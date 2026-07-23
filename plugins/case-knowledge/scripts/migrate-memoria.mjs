#!/usr/bin/env node
/**
 * Migracao ONE-SHOT dos `project_*`/`feedback_*` legados (dir agregado de
 * auto-memory da cmr-002) para o layout namespace-por-autor da feature CMR-138.
 *
 * Origem (Windows, verbatim):
 *   C:\Users\pedro\.claude\projects\C--Users-pedro-cases\memory\  (57 arquivos)
 * Destino:
 *   project_<slug> -> <cases-base>/<caso>/.memoria/<autor>/<nome>
 *   feedback_*      -> <cases-base>/.feedback/<autor>/<nome>
 *
 * REGRAS DURAS:
 *   - COPIA (nunca move/apaga): o dir agregado fica intacto como rollback.
 *   - DRY-RUN por default; `--apply` executa. Nunca sobrescreve destino existente.
 *   - Ambiguo/orfao NUNCA sao auto-resolvidos -- decisao humana do CEO.
 *   - reference_* e MEMORY.md NAO migram (refs de maquina/ferramenta + indice).
 *
 * Este arquivo e uma CASCA FINA de I/O em volta de funcoes puras testaveis
 * (classifyLegacyMemFile / planMigration / migrationDest). A logica de decisao
 * vive nas puras; a casca so le disco, imprime a tabela e copia.
 *
 * Spec/plano: case-docs/.superpowers/sdd/2026-07-21-memoria-caso-sincronizavel/
 */

import {
  mkdirSync,
  readdirSync,
  copyFileSync,
  constants,
} from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { readCredential, decodeJwtSub } from "../auth.mjs";
import {
  isSafeMemoriaCase,
  isSafeMemoriaAuthor,
  isSafeMemoriaFile,
} from "../sync-cases.mjs";

// ---------------------------------------------------------------------------
// Normalizacao e tokenizacao (deterministicas)
// ---------------------------------------------------------------------------

/** Normaliza para comparacao: lowercase e `_` -> `-`. */
function norm(s) {
  return String(s).toLowerCase().replace(/_/g, "-");
}

/** Tokens do identificador: split em `-`/`_`, lowercase, sem vazios. */
function tokenize(s) {
  return String(s)
    .toLowerCase()
    .split(/[-_]+/)
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Mapa curado de JULGAMENTO HUMANO (CMR-138)
//
// Estes slugs NAO sao resolviveis por casamento lexical sozinho -- codificam
// decisao humana que o texto do nome nao carrega. O casamento fuzzy foi usado
// para GERAR estes candidatos; o humano confirmou. Consultados ANTES do fuzzy.
//
// CURATED_CLEAN: slug -> caso UNICO confirmado por humano (match "curated",
// AUTO-APLICA). Usado quando o token distintivo do slug DIVERGE do nome da
// pasta -- ali o fuzzy resolveria por coincidencia de um token secundario, sem
// confianca. Fixar aqui torna a decisao humana explicita em vez de acidental.
// E o destino de um palpite FUZZY que o CEO confirma no dry-run: ao aprovar, a
// entrada migra de fuzzy (segurado) para ca (auto-aplicavel).
//
// NASCE VAZIO por decisao de contrato: um subagente NAO pre-decide onde vai a
// memoria curada do CEO. Todo palpite fuzzy fica SEGURADO no --apply ate o CEO
// confirmar no dry-run e adicionar a entrada AQUI a mao. Exemplo do tipo de
// entrada que o CEO adicionaria depois de confirmar:
//   salesforce_facilita_attrus: "salesforce-facilita-pagamentos",
//   ("attrus" -- a contraparte -- nao aparece na pasta "pagamentos"; so
//    "facilita" liga os dois. Enquanto nao confirmado, cai como fuzzy.)
// Exportado para o teste do mecanismo do tier "curated" (injeta entrada e limpa).
export const CURATED_CLEAN = {};

// CURATED_AMBIGUOUS: slug -> candidatos plausiveis; SEMPRE exige decisao humana
// (nunca auto-aplica), mesmo com 1 unico candidato ("provavel, confirmar").
// Por que cada um precisa de curadoria (fuzzy puro erraria):
//   - luiz_henrique_demissao: casaria LIMPO em luiz-henrique-soares (tokens
//     "luiz"+"henrique"), mas a memoria de demissao pode pertencer a
//     carlos-eduardo (outro caso de demissao) -- duvida semantica, nao lexical.
//   - piggpay_salesforce: salesforce-piggpay e piggpay_sfdc sao o MESMO CNJ em
//     duas pastas; ambas plausiveis.
//   - desktop_salesforce_notificacoes: provavel salesforce-desktopsa, mas o
//     humano marcou "?" (candidato incerto) -- nao auto-resolver.
//   - comex_salesforce_agravo / novartis_hed_execucao: multiplas pastas do
//     mesmo grupo, sem token que desempate.
//   - odmgt_contratos_modelo: compartilha o token raro "odmgt" com
//     odmgt-jf-beleza e casaria LIMPO no fuzzy, mas e um modelo de contrato
//     avulso -- EXISTE o candidato, mas a pertinencia e duvida humana, nao
//     orfandade. 1 candidato -> ambiguo (confirmar), nunca auto-aplica.
const CURATED_AMBIGUOUS = {
  luiz_henrique_demissao: ["luiz-henrique-soares", "carlos-eduardo"],
  desktop_salesforce_notificacoes: ["salesforce-desktopsa"],
  piggpay_salesforce: ["salesforce-piggpay", "piggpay_sfdc"],
  comex_salesforce_agravo: [
    "comex-salesforce-acao-principal",
    "comex-salesforce-cumprimento-provisorio",
  ],
  novartis_hed_execucao: [
    "novartis-anais-prado",
    "novartis-hosp-dornelles",
    "novartis-medfarma",
  ],
  odmgt_contratos_modelo: ["odmgt-jf-beleza"],
};

// CURATED_ORPHAN: slug SEM nenhuma pasta correspondente no disco -> orfao.
//   - otsuka_primeq: sem caso correspondente.
const CURATED_ORPHAN = new Set(["otsuka_primeq"]);

// ---------------------------------------------------------------------------
// Resolucao fuzzy de slug -> pasta (para tudo que NAO esta no mapa curado)
// ---------------------------------------------------------------------------

/**
 * Resolve o slug de um `project_*` contra as pastas de caso.
 *
 * Ordem: (1) match exato normalizado -> limpo; (2) score por overlap de tokens
 * ponderado por raridade (IDF, `1/df`) -- tokens comuns como "salesforce"
 * pesam pouco, tokens raros pesam muito. Desempate por COBERTURA da pasta
 * (fracao dos tokens da pasta explicada pelo slug): entre dois matches de um
 * unico token raro (ex: "compassion" vs "salesforce-ph-brasil", ambos idf=1),
 * vence a pasta cujo nome esta mais contido no slug ("compassion" = 100%).
 * Unico vencedor -> limpo, empate real -> ambiguo, nenhum candidato -> orfao.
 *
 * Retorna: { casePath, via:"exact" } | { casePath, via:"fuzzy", score } |
 * { ambiguous: [...] } | { orphan: true }. `via` distingue casamento exato de
 * palpite; `score` (idf/cov do vencedor) alimenta o dry-run.
 * Nunca produz um casePath que falhe em isSafeMemoriaCase.
 */
function resolveProjectSlug(slug, casePaths) {
  const safe = casePaths.filter((cp) => isSafeMemoriaCase(cp));
  const slugN = norm(slug);

  // (1) match exato normalizado (cobre casing misto, ex: abrafarma-ML-Ifood)
  const exact = safe.filter((cp) => norm(cp) === slugN);
  if (exact.length === 1) return { casePath: exact[0], via: "exact" };
  if (exact.length > 1) return { ambiguous: exact };

  // (2) score por token IDF + cobertura
  const slugToks = new Set(tokenize(slug));
  const cpToks = safe.map((cp) => ({ cp, toks: [...new Set(tokenize(cp))] }));

  // df(token) = numero de pastas que contem o token
  const df = new Map();
  for (const { toks } of cpToks) {
    for (const t of toks) df.set(t, (df.get(t) || 0) + 1);
  }

  const round = (x) => Math.round(x * 1e6) / 1e6;
  const scored = [];
  for (const { cp, toks } of cpToks) {
    let idf = 0;
    let shared = 0;
    for (const t of toks) {
      if (slugToks.has(t)) {
        idf += 1 / df.get(t);
        shared++;
      }
    }
    if (shared > 0) {
      scored.push({ cp, idf: round(idf), cov: round(shared / toks.length) });
    }
  }

  if (scored.length === 0) return { orphan: true };

  // Vencedor lexicografico: maior idf; empate -> maior cobertura.
  const maxIdf = Math.max(...scored.map((s) => s.idf));
  const topIdf = scored.filter((s) => s.idf === maxIdf);
  const maxCov = Math.max(...topIdf.map((s) => s.cov));
  const winners = topIdf.filter((s) => s.cov === maxCov);
  if (winners.length === 1) {
    const w = winners[0];
    return { casePath: w.cp, via: "fuzzy", score: { idf: w.idf, cov: w.cov } };
  }
  return { ambiguous: winners.map((s) => s.cp) };
}

// ---------------------------------------------------------------------------
// Funcao pura central: classifica UM arquivo legado
// ---------------------------------------------------------------------------

/**
 * Classifica um arquivo de auto-memory legado (nome COM `.md`) roteando-o para
 * o novo layout. Decisao 100% pelo NOME (prefixo) + mapa curado + fuzzy contra
 * as pastas reais. Determinístico; nunca lanca.
 *
 * @param {string} name       nome do arquivo (ex: "project_bianka_salesforce.md")
 * @param {string[]} casePaths pastas de caso reais lidas do disco
 * @returns {{kind:string, casePath?:string, match?:string, score?:object, ambiguous?:string[], orphan?:true}}
 *   kind: "feedback" | "project" | "reference" | "index" | "other".
 *   match (so quando casePath resolvido): "exact" | "curated" | "fuzzy".
 *   Apenas "exact" e "curated" auto-aplicam; "fuzzy" e palpite (segurado).
 */
export function classifyLegacyMemFile(name, casePaths) {
  if (typeof name !== "string") return { kind: "other" };
  const paths = Array.isArray(casePaths) ? casePaths : [];

  if (name === "MEMORY.md") return { kind: "index" };
  // Guard de seguranca: nome que nao e .md seguro nunca vira destino de escrita.
  if (!isSafeMemoriaFile(name)) return { kind: "other" };

  if (name.startsWith("reference_")) return { kind: "reference" };
  if (name.startsWith("feedback_")) return { kind: "feedback" };

  if (name.startsWith("project_")) {
    const slug = name.slice("project_".length).replace(/\.md$/, "");

    // (a) mapa curado: julgamento humano vence o fuzzy.
    // (a.1) curado LIMPO: destino unico confirmado -> auto-aplica (match curated).
    const clean = CURATED_CLEAN[slug];
    if (clean && paths.includes(clean) && isSafeMemoriaCase(clean)) {
      return { kind: "project", casePath: clean, match: "curated" };
    }
    // (a.2) curado ORFAO: sem pasta correspondente.
    if (CURATED_ORPHAN.has(slug)) return { kind: "project", orphan: true };
    // (a.3) curado AMBIGUO: exige decisao humana (nunca auto-aplica), mesmo com
    // 1 candidato. So candidatos que existem no disco E sao seguros.
    const curated = CURATED_AMBIGUOUS[slug];
    if (curated) {
      const cands = curated.filter(
        (c) => paths.includes(c) && isSafeMemoriaCase(c),
      );
      if (cands.length >= 1) return { kind: "project", ambiguous: cands };
      // Candidatos curados sumiram do disco -> cai no fuzzy (defensivo).
    }

    // (b) fuzzy
    const r = resolveProjectSlug(slug, paths);
    if (r.casePath && isSafeMemoriaCase(r.casePath)) {
      if (r.via === "exact") {
        return { kind: "project", casePath: r.casePath, match: "exact" };
      }
      // Palpite: casePath e o chute, match "fuzzy" segura no --apply.
      return { kind: "project", casePath: r.casePath, match: "fuzzy", score: r.score };
    }
    if (r.ambiguous) return { kind: "project", ambiguous: r.ambiguous };
    return { kind: "project", orphan: true };
  }

  return { kind: "other" };
}

// ---------------------------------------------------------------------------
// Planejamento e destino (puros)
// ---------------------------------------------------------------------------

/**
 * Classifica uma lista de nomes e agrega contagens por TIER de RESOLUCAO (nao so
 * por kind): exact/curated/fuzzy/ambiguous/orphan/feedback/reference/index/other.
 * exact+curated auto-aplicam; fuzzy e palpite segurado (como ambiguo/orfao).
 */
export function planMigration(names, casePaths) {
  const rows = [];
  const counts = {
    exact: 0,
    curated: 0,
    fuzzy: 0,
    ambiguous: 0,
    orphan: 0,
    feedback: 0,
    reference: 0,
    index: 0,
    other: 0,
  };
  for (const name of names) {
    const c = classifyLegacyMemFile(name, casePaths);
    const row = { name, ...c };
    rows.push(row);
    if (c.kind === "project") {
      if (c.casePath) counts[c.match] = (counts[c.match] || 0) + 1; // exact|curated|fuzzy
      else if (c.ambiguous) counts.ambiguous++;
      else counts.orphan++;
    } else {
      counts[c.kind] = (counts[c.kind] || 0) + 1;
    }
  }
  return { rows, counts };
}

/**
 * Caminho de destino de um arquivo que AUTO-MIGRA, ou null. So retorna path para
 * project EXATO/CURADO (nunca fuzzy) e feedback -- por construcao, a lista de
 * copias derivada de migrationDest EXCLUI palpites fuzzy, ambiguos e orfaos.
 * Puro (so join de path).
 */
export function migrationDest(entry, casesBase, author) {
  if (!entry || typeof author !== "string") return null;
  if (entry.kind === "feedback") {
    return join(casesBase, ".feedback", author, entry.name);
  }
  if (
    entry.kind === "project" &&
    entry.casePath &&
    (entry.match === "exact" || entry.match === "curated")
  ) {
    return join(casesBase, entry.casePath, ".memoria", author, entry.name);
  }
  // fuzzy (palpite) / ambiguo / orfao / reference / index / other -> nao auto-migra.
  return null;
}

// ---------------------------------------------------------------------------
// CLI (casca de I/O; sem logica de decisao)
// ---------------------------------------------------------------------------

const DEFAULT_LEGACY_DIR =
  "C:\\Users\\pedro\\.claude\\projects\\C--Users-pedro-cases\\memory";

function defaultCasesBase() {
  if (process.platform === "win32") {
    return join(process.env.USERPROFILE || "C:\\Users\\pedro", "cases");
  }
  return join(process.env.HOME || "/home/opc", "cases");
}

function parseArgs(argv) {
  const out = { legacyDir: DEFAULT_LEGACY_DIR, casesBase: null, apply: false, author: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--legacy-dir") out.legacyDir = argv[++i];
    else if (a === "--cases-base") out.casesBase = argv[++i];
    else if (a === "--author") out.author = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  if (!out.casesBase) out.casesBase = defaultCasesBase();
  return out;
}

/** Le as pastas de caso reais (dirs), excluindo dotdirs e reservados. */
function readCasePaths(casesBase) {
  const EXCLUDED = new Set(["_archive", "_template", "scripts"]);
  let entries;
  try {
    entries = readdirSync(casesBase, { withFileTypes: true });
  } catch (err) {
    throw new Error(`nao consegui ler cases-base ${casesBase}: ${err.message}`);
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => !n.startsWith(".") && !EXCLUDED.has(n));
}

/** Rotulo legivel do destino para a tabela de dry-run, POR TIER. Deixa obvio o
 * que sera copiado (EXATO/CURADO) vs o que fica retido (FUZZY/AMBIGUO/ORFAO). */
function destLabel(row) {
  if (row.kind === "project" && row.casePath) {
    if (row.match === "exact") return `EXATO   -> ${row.casePath}/.memoria/`;
    if (row.match === "curated") return `CURADO  -> ${row.casePath}/.memoria/`;
    // fuzzy: mostra o palpite + score; NAO auto-aplica.
    const s = row.score ? `idf=${row.score.idf} cov=${row.score.cov}` : "?";
    return `FUZZY?  -> ${row.casePath} (${s}; confirmar)`;
  }
  if (row.kind === "project" && row.ambiguous) return `AMBIGUO [${row.ambiguous.join(" | ")}]`;
  if (row.kind === "project" && row.orphan) return "ORFAO (sem pasta)";
  if (row.kind === "feedback") return "feedback -> .feedback/ (pool)";
  if (row.kind === "reference") return "PULADO (reference)";
  if (row.kind === "index") return "PULADO (index MEMORY.md)";
  return "PULADO (fora de padrao)";
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "uso: node scripts/migrate-memoria.mjs [--legacy-dir <path>] [--cases-base <path>] [--author <sub>] [--apply]\n" +
        "  sem --apply = DRY-RUN (nada e escrito). COPIA (nunca move). Nunca sobrescreve.",
    );
    return 0;
  }

  // Autor: --author ou derivado do sub do JWT da credencial (keychain/arquivo).
  let author = args.author;
  if (!author) {
    try {
      const cred = readCredential();
      author = cred && cred.access_jwt ? decodeJwtSub(cred.access_jwt) : null;
    } catch {
      author = null;
    }
  }
  if (!author) {
    console.error(
      "ERRO: nao foi possivel derivar o autor da credencial. Rode o login do plugin\n" +
        "(node server.mjs login) ou passe --author <sub> explicitamente.",
    );
    return 1;
  }
  if (!isSafeMemoriaAuthor(author)) {
    console.error(`ERRO: autor inseguro derivado (${author}). Passe --author valido.`);
    return 1;
  }

  // Le origem e pastas de destino.
  let files;
  try {
    files = readdirSync(args.legacyDir).filter((n) => n.endsWith(".md"));
  } catch (err) {
    console.error(`ERRO: nao consegui ler legacy-dir ${args.legacyDir}: ${err.message}`);
    return 1;
  }
  let casePaths;
  try {
    casePaths = readCasePaths(args.casesBase);
  } catch (err) {
    console.error(`ERRO: ${err.message}`);
    return 1;
  }

  const { rows, counts } = planMigration(files, casePaths);

  const modo = args.apply ? "APPLY (copiando)" : "DRY-RUN (nada escrito)";
  console.log(`\nMigracao de memoria legada -- ${modo}`);
  console.log(`origem : ${args.legacyDir}`);
  console.log(`destino: ${args.casesBase}`);
  console.log(`autor  : ${author}`);
  console.log(`casos  : ${casePaths.length} pastas | arquivos .md: ${files.length}\n`);

  for (const row of rows.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`${pad(row.name, 48)} ${pad(row.kind, 10)} ${destLabel(row)}`);
  }

  console.log(
    `\nresumo (auto-aplica): ${counts.exact} EXATO + ${counts.curated} CURADO + ` +
      `${counts.feedback} feedback` +
      `\nresumo (retido, decisao humana): ${counts.fuzzy} FUZZY? + ` +
      `${counts.ambiguous} AMBIGUO + ${counts.orphan} ORFAO` +
      `\nresumo (pulados): ${counts.reference} reference + ${counts.index} index + ` +
      `${counts.other} fora-de-padrao`,
  );

  if (!args.apply) {
    console.log("\nDRY-RUN: nada foi escrito. Revise a tabela e rode com --apply para copiar.");
    return 0;
  }

  // APPLY: copia so os que AUTO-APLICAM (EXATO + CURADO + feedback -- ver
  // migrationDest, que retorna null p/ fuzzy/ambiguo/orfao). FUZZY (palpite)
  // fica retido junto de ambiguo/orfao: NUNCA copia sem confirmacao do CEO.
  let copied = 0;
  let skippedExisting = 0;
  const heldBack = [];
  for (const row of rows) {
    const dest = migrationDest(row, args.casesBase, author);
    if (!dest) {
      if (row.kind === "project" && (row.match === "fuzzy" || row.ambiguous || row.orphan)) {
        heldBack.push(row);
      }
      continue;
    }
    // Guard de seguranca no ponto de escrita (defense-in-depth).
    if (!isSafeMemoriaFile(row.name)) {
      console.log(`  pulado (nome inseguro): ${row.name}`);
      continue;
    }
    try {
      mkdirSync(dirname(dest), { recursive: true });
      const src = join(args.legacyDir, row.name);
      // Never-overwrite ATOMICO: COPYFILE_EXCL falha com EEXIST se o destino ja
      // existe (fecha o TOCTOU do existsSync + copy). Nunca sobrescreve.
      copyFileSync(src, dest, constants.COPYFILE_EXCL);
      copied++;
    } catch (err) {
      if (err.code === "EEXIST") {
        console.log(`  pulado (destino ja existe): ${dest}`);
        skippedExisting++;
      } else {
        console.log(`  ERRO copiando ${row.name}: ${err.message}`);
      }
    }
  }

  console.log(`\nAPPLY concluido: ${copied} copiados, ${skippedExisting} pulados (ja existiam).`);
  if (heldBack.length) {
    console.log(
      `\n${heldBack.length} arquivos NAO migrados (decisao manual do CEO -- ` +
        `FUZZY: confirmar e adicionar ao mapa curado se correto):`,
    );
    for (const row of heldBack) {
      console.log(`  ${pad(row.name, 48)} ${destLabel(row)}`);
    }
  }
  console.log("\nO dir agregado de origem ficou INTOCADO (rollback preservado).");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
