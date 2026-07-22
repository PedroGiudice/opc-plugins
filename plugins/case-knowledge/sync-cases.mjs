#!/usr/bin/env node
/**
 * Espelho de casos VM -> maquina cliente (cmr-002).
 *
 * Fluxo: GET /cases/sync-manifest -> compara md5 local -> baixa via
 * GET /cases/{name}/briefing so o que mudou -> move orfaos p/ _archive.
 * NUNCA deleta nada; so escreve nos arquivos de briefing.
 *
 * Agendado pelo Task Scheduler (a cada 5 min + logon, via sync-cases-hidden.vbs). Exit 0 sempre —
 * erro e logado em ~/cases/.sync.log e o proximo ciclo e o retry.
 *
 * Spec: case-docs/docs/superpowers/specs/2026-06-11-sync-vm-cmr002-mirror-design.md
 */

import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readdirSync, readFileSync,
  writeFileSync, renameSync, appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { requestWithAuth, readCredential, decodeJwtSub } from "./auth.mjs";

// Espelha defaultApiBase/defaultCasesBase do server.mjs. Duplicado de
// proposito: importar server.mjs executaria o server MCP (connect no
// top-level). Se mudar la, mudar aqui.
function defaultApiBase() {
  if (process.platform === "win32") return "https://api.aidvlabs.com/api";
  return "http://127.0.0.1:8422/api";
}
function defaultCasesBase() {
  if (process.platform === "win32") return join(process.env.USERPROFILE || "C:\\Users\\pedro", "cases");
  return "/home/opc/case-docs/cases";
}

export const BRIEFING_FILES = ["CLAUDE.md", "case.yaml", "documentos.yaml"];
const EXCLUDED_DIRS = new Set(["_archive", "_template", "scripts"]);

export function isExcluded(name) {
  return EXCLUDED_DIRS.has(name) || name.startsWith(".");
}

export function md5hex(buf) {
  return createHash("md5").update(buf).digest("hex");
}

// Whitelist client-side de nome de caso (espelha valid_case_name do
// servidor): alfanumerico ASCII no inicio, depois `.` `_` `-` permitidos.
// Bloqueia path traversal por construcao (sem `/`, `\` ou prefixo `.`).
const VALID_CASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Decide acoes a partir do manifest remoto e do estado local.
 * localState: { caseName: { fileName: md5hex } } — TODOS os dirs locais;
 * exclusoes (_archive, _template, scripts, dotdirs) sao tratadas aqui.
 * Retorna { mkdir: [name], download: [{name, files}], orphans: [name] }.
 *
 * Defesa client-side: a invariante "so escreve nos arquivos de briefing"
 * e garantida AQUI (quem decide o que tocar no disco), nao so no servidor
 * — nome remoto invalido/reservado e arquivo fora de BRIEFING_FILES sao
 * descartados do plano.
 *
 * Matching de nome e case-insensitive (NTFS): se a VM renomear a caixa de
 * um caso, o cliente reusa o dir local existente em vez de criar duplicata
 * e arquivar o antigo (que carregaria o trabalho local do advogado junto).
 */
export function planActions(manifestCases, localState, baseline = {}) {
  const plan = { mkdir: [], download: [], orphans: [], conflicts: [] };

  // Defesa em profundidade: manifest vazio significa quase certamente erro
  // no servidor (a VM tem 20+ casos ativos), nunca "arquive tudo".
  if (manifestCases.length === 0) return plan;

  // Indice lowercase do estado local para matching NTFS-safe.
  const localByLower = new Map();
  for (const name of Object.keys(localState)) {
    localByLower.set(name.toLowerCase(), name);
  }

  const remoteLower = new Set();
  for (const c of manifestCases) {
    if (!VALID_CASE_NAME.test(c.name) || isExcluded(c.name)) continue;
    remoteLower.add(c.name.toLowerCase());

    // Reusa o dir local existente quando so a caixa difere (NTFS).
    const localName = localByLower.get(c.name.toLowerCase());
    const local = localName !== undefined ? localState[localName] : undefined;
    const base = (localName !== undefined ? baseline[localName] : undefined) ?? baseline[c.name];
    const targetName = localName ?? c.name;
    if (!local) plan.mkdir.push(c.name);

    const needs = [];
    for (const [file, info] of Object.entries(c.files)) {
      if (!BRIEFING_FILES.includes(file)) continue;
      const localMd5 = local?.[file];
      const baseMd5 = base?.[file];
      if (localMd5 === undefined) {
        needs.push(file); // arquivo novo no cliente
      } else if (localMd5 === info.md5) {
        // ja sincronizado: nada a fazer
      } else if (baseMd5 !== undefined && localMd5 === baseMd5) {
        needs.push(file); // VM mudou, local intocado desde o ultimo download
      } else {
        plan.conflicts.push({ name: targetName, file }); // edicao local -> preserva
      }
    }
    if (needs.length > 0) plan.download.push({ name: targetName, files: needs });
  }

  // Um dir local ausente do manifest so e orfao se o sync ja o trouxe antes
  // (presente no baseline) -> caso removido na VM, limpeza legitima. Um dir que
  // o sync nunca sincronizou (ausente do baseline) e trabalho local do usuario
  // (ex: contrato jogado em ~/cases para revisao): NAO tocar. O espelho mexe so
  // no que e dele.
  const baselineLower = new Set(Object.keys(baseline).map((k) => k.toLowerCase()));
  for (const name of Object.keys(localState)) {
    if (remoteLower.has(name.toLowerCase()) || isExcluded(name)) continue;
    if (baselineLower.has(name.toLowerCase())) plan.orphans.push(name);
  }
  return plan;
}

/**
 * Novo baseline a persistir apos aplicar o plano. Reflete o md5 da VM para
 * arquivos agora sincronizados (baixados com sucesso OU ja iguais a VM);
 * preserva o baseline anterior para conflitos (a versao da VM de quando o
 * usuario editou); remove orfaos (casos ausentes do manifest).
 *
 * succeeded: Set de chaves `${name} ${file}` baixadas com sucesso neste ciclo.
 */
export function computeBaseline(manifestCases, localState, prevBaseline, succeeded) {
  const next = {};
  const localByLower = new Map();
  for (const name of Object.keys(localState)) {
    localByLower.set(name.toLowerCase(), name);
  }

  for (const c of manifestCases) {
    if (!VALID_CASE_NAME.test(c.name) || isExcluded(c.name)) continue;
    const localName = localByLower.get(c.name.toLowerCase()) ?? c.name;
    const local = localState[localName];
    const prev = prevBaseline[localName] ?? prevBaseline[c.name] ?? {};
    const entry = {};
    for (const [file, info] of Object.entries(c.files)) {
      if (!BRIEFING_FILES.includes(file)) continue;
      const key = `${localName} ${file}`;
      if (succeeded.has(key)) {
        entry[file] = info.md5; // baixado -> agora igual a VM
      } else if (local?.[file] === info.md5) {
        entry[file] = info.md5; // ja sincronizado -> adota
      } else if (prev[file] !== undefined) {
        entry[file] = prev[file]; // conflito/falha -> mantem
      }
    }
    if (Object.keys(entry).length > 0) next[localName] = entry;
  }
  return next;
}

// ---------- CMR-138: memoria de caso sincronizavel (por-autor) ----------
//
// A memoria de caso e uma arvore por-autor: cada advogado (tenant/autor) tem seu
// subdir; peers baixados vivem em `.memoria/<peer>/`, a memoria do proprio autor
// (auto-memory) e a fonte dos uploads. Estas puras decidem o que baixar (peers +
// self sob never-overwrite) e o que subir (SO os arquivos do proprio autor,
// roteados para memoria-de-caso ou pool-de-feedback). Wiring (fs/rede) e a Task 10.

/**
 * Normaliza o valor de um arquivo no manifest/baseline/estado local para a
 * string md5. O server real usa md5 STRING PLANA; os testes e o manifest
 * teorico usam objeto `{ md5, content? }`. Aceita ambos; qualquer outra coisa
 * (undefined, numero, etc) -> undefined.
 */
function fileMd5(v) {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof v.md5 === "string") return v.md5;
  return undefined;
}

/** Conteudo do arquivo (para upload). So o shape objeto `{ content }` carrega. */
function fileContent(v) {
  if (v && typeof v === "object" && typeof v.content === "string") return v.content;
  return undefined;
}

// PEERS.md e um indice gerado dentro do dir de memoria, nunca um arquivo de
// autor -- fica fora de download e upload.
const MEMORIA_IGNORED = new Set(["PEERS.md"]);

// FEEDBACK.md e o indice gerado do pool de feedback (fica na raiz de `.feedback/`,
// nao em subdir de autor); nunca um arquivo de autor.
const FEEDBACK_IGNORED = new Set(["FEEDBACK.md"]);

/**
 * Le o `type` declarado no frontmatter YAML (bloco entre `---` no INICIO do
 * arquivo). Sem lib YAML: varre as linhas do bloco e casa `type: <valor>`
 * (top-level OU aninhado sob `metadata:`), tolerante a indentacao, aspas e
 * comentario inline. Se qualquer linha declarar `type: feedback`, retorna
 * "feedback"; senao retorna o primeiro `type:` encontrado (ex: "project");
 * sem frontmatter/sem type -> undefined.
 */
function frontmatterType(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return undefined;
  let first;
  for (const line of m[1].split(/\r?\n/)) {
    const lm = line.match(/^\s*type:\s*["']?([A-Za-z_]+)["']?\s*(?:#.*)?$/);
    if (!lm) continue;
    const v = lm[1].toLowerCase();
    if (v === "feedback") return "feedback";
    if (first === undefined) first = v;
  }
  return first;
}

/**
 * Roteia um arquivo de memoria para "feedback" (pool compartilhado por autor)
 * ou "memoria" (memoria-de-caso do autor).
 *
 * Sinal PRIMARIO (spike CMR-138): o auto-memory nomeia arquivos livremente
 * (ex: `recursos-preferir-agravo.md`) e marca a categoria no frontmatter
 * (`metadata.type: feedback|project|reference`). O frontmatter e primario nos
 * DOIS sentidos: `type: feedback` -> "feedback"; type CONHECIDO nao-feedback
 * (`project`/`reference`/`user`) -> "memoria" MESMO com nome `feedback_*`. Sem
 * frontmatter ou type desconhecido -> FALLBACK legado por nome: prefixo
 * `feedback_` -> "feedback". Caso contrario -> "memoria".
 *
 * content ausente/nao-string -> so o fallback de prefixo.
 */
const MEMORIA_KNOWN_TYPES = new Set(["project", "reference", "user"]);

export function memFileType(name, content) {
  if (typeof content === "string") {
    const ft = frontmatterType(content);
    if (ft === "feedback") return "feedback";
    if (MEMORIA_KNOWN_TYPES.has(ft)) return "memoria";
  }
  if (typeof name === "string" && name.startsWith("feedback_")) return "feedback";
  return "memoria";
}

/**
 * Decide download e upload da memoria de caso a partir do manifest remoto
 * (por-autor), do estado local e do baseline.
 *
 * Shapes (destripados do envelope pela Task 10):
 *   remoteManifest:     { <caso>: { <autor>: { <arquivo>: md5|{md5} } } }
 *   localMemoriaState:  { <caso>: { <autor>: { <arquivo>: md5|{md5,content} } } }
 *   baseline:           { <caso>: { <autor>: { <arquivo>: md5|{md5} } } }
 *   selfAuthor:         id do proprio autor (string) ou null
 *
 * Retorna:
 *   { downloadAuthors: [{ case, author, files: [nome] }],
 *     uploadFiles:     [{ case, name, content, target: "memoria"|"feedback" }] }
 *
 * DOWNLOAD (qualquer autor, peer OU self, sob never-overwrite): baixa um
 * arquivo quando
 *   - ausente local E ausente do baseline (nunca visto nesta maquina -> seed), OU
 *   - a VM mudou e o local ficou intocado desde o ultimo sync
 *     (baseMd5 definido, local === baseline, local !== VM).
 * Ausente local MAS presente no baseline = o usuario DELETOU localmente apos o
 * baseline -> PRESERVA a delecao (nao baixa): a auto-memory deleta memorias
 * erradas por design, ressuscita-las e nocivo. Edicao local divergente (inclui
 * bootstrap sem baseline) -> preserva. Espelha o never-overwrite de planActions.
 *
 * UPLOAD (SO o proprio autor): deriva EXCLUSIVAMENTE de
 * localMemoriaState[caso][selfAuthor] -- nunca dos subdirs de peers ja baixados
 * (senao re-uploadaria memoria alheia como se fosse sua). selfAuthor null ->
 * nenhum upload. Um arquivo do self entra em uploadFiles apenas quando
 *   - a VM nao o tem (remoteMd5 === undefined), OU
 *   - local !== VM E o arquivo NAO esta na fila de download deste plano
 *     (se o plano decidiu baixar a versao da VM, subir a local antiga por cima
 *     seria revert acidental da versao mais nova da VM).
 * Roteamento por memFileType (frontmatter, com fallback prefixo).
 */
export function planMemoriaActions(remoteManifest, localMemoriaState, baseline, selfAuthor) {
  const plan = { downloadAuthors: [], uploadFiles: [] };
  remoteManifest = remoteManifest || {};
  localMemoriaState = localMemoriaState || {};
  baseline = baseline || {};

  // Fila de download deste plano (chave `${caso} ${autor} ${arquivo}`) para o
  // gate de upload nao reverter uma versao da VM que este mesmo plano vai baixar.
  const downloadKeys = new Set();

  // ----- DOWNLOAD -----
  for (const [caso, authors] of Object.entries(remoteManifest)) {
    if (!authors || typeof authors !== "object") continue;
    for (const [author, files] of Object.entries(authors)) {
      if (!files || typeof files !== "object") continue;
      const localAuthor = localMemoriaState[caso]?.[author];
      const baseAuthor = baseline[caso]?.[author];
      const needs = [];
      for (const [file, info] of Object.entries(files)) {
        if (MEMORIA_IGNORED.has(file)) continue;
        const vmMd5 = fileMd5(info);
        const localMd5 = fileMd5(localAuthor?.[file]);
        const baseMd5 = fileMd5(baseAuthor?.[file]);
        const seed = localMd5 === undefined && baseMd5 === undefined;
        const vmChangedUntouched =
          baseMd5 !== undefined && localMd5 === baseMd5 && localMd5 !== vmMd5;
        if (seed || vmChangedUntouched) {
          needs.push(file);
          downloadKeys.add(`${caso} ${author} ${file}`);
        }
        // ausente + baseline presente -> delecao local preservada;
        // divergente (edicao ou bootstrap sem baseline) -> preservado.
      }
      if (needs.length > 0) plan.downloadAuthors.push({ case: caso, author, files: needs });
    }
  }

  // ----- UPLOAD (so o proprio autor) -----
  if (selfAuthor !== null && selfAuthor !== undefined) {
    for (const [caso, authors] of Object.entries(localMemoriaState)) {
      const selfFiles = authors?.[selfAuthor];
      if (!selfFiles || typeof selfFiles !== "object") continue;
      const remoteSelf = remoteManifest[caso]?.[selfAuthor];
      for (const [file, info] of Object.entries(selfFiles)) {
        if (MEMORIA_IGNORED.has(file)) continue;
        const localMd5 = fileMd5(info);
        const remoteMd5 = fileMd5(remoteSelf?.[file]);
        const queuedForDownload = downloadKeys.has(`${caso} ${selfAuthor} ${file}`);
        if (remoteMd5 === undefined || (localMd5 !== remoteMd5 && !queuedForDownload)) {
          const content = fileContent(info);
          plan.uploadFiles.push({
            case: caso,
            name: file,
            content,
            target: memFileType(file, content),
          });
        }
      }
    }
  }
  return plan;
}

/**
 * Novo baseline por-autor a persistir apos aplicar o plano de memoria. Analogo
 * a computeBaseline, sobre a arvore { <caso>: { <autor>: { <arquivo>: md5 } } }.
 *
 *   - Arquivo BAIXADO com sucesso (peer ou self) -> md5 da VM (agora local === VM).
 *   - Arquivo self UPLOADADO -> md5 LOCAL (a VM passou a te-lo). Sem isso o
 *     proximo ciclo veria o self recem-uploadado sem baseline e poderia
 *     re-baixar em ping-pong.
 *   - Arquivo ja sincronizado (local === VM) -> adota md5 da VM.
 *   - Conflito/falha -> mantem o baseline anterior.
 *   - Autor/caso ausente do manifest E nao uploadado -> removido (orfao).
 *
 * succeeded: Set de chaves `${caso} ${autor} ${arquivo}` baixadas com sucesso.
 * uploaded:  Set de chaves `${caso} ${selfAuthor} ${arquivo}` subidas com sucesso.
 */
export function computeMemoriaBaseline(remoteManifest, localMemoriaState, prevBaseline, succeeded, uploaded, selfAuthor) {
  remoteManifest = remoteManifest || {};
  localMemoriaState = localMemoriaState || {};
  prevBaseline = prevBaseline || {};
  succeeded = succeeded || new Set();
  uploaded = uploaded || new Set();

  const next = {};
  const put = (caso, author, file, md5) => {
    if (md5 === undefined) return;
    (next[caso] ??= {});
    (next[caso][author] ??= {});
    next[caso][author][file] = md5;
  };

  // Passo 1: espelha computeBaseline sobre a arvore por-autor da VM.
  for (const [caso, authors] of Object.entries(remoteManifest)) {
    if (!authors || typeof authors !== "object") continue;
    for (const [author, files] of Object.entries(authors)) {
      if (!files || typeof files !== "object") continue;
      const localAuthor = localMemoriaState[caso]?.[author];
      const prevAuthor = prevBaseline[caso]?.[author] ?? {};
      for (const [file, info] of Object.entries(files)) {
        if (MEMORIA_IGNORED.has(file)) continue;
        const vmMd5 = fileMd5(info);
        const key = `${caso} ${author} ${file}`;
        if (succeeded.has(key)) {
          put(caso, author, file, vmMd5); // baixado -> agora igual a VM
        } else if (vmMd5 !== undefined && fileMd5(localAuthor?.[file]) === vmMd5) {
          put(caso, author, file, vmMd5); // ja sincronizado -> adota
        } else if (prevAuthor[file] !== undefined) {
          put(caso, author, file, fileMd5(prevAuthor[file])); // conflito/falha -> mantem
        }
      }
    }
  }

  // Passo 2: arquivos self UPLOADADOS -> md5 local (a VM passou a te-lo).
  if (selfAuthor !== null && selfAuthor !== undefined) {
    for (const [caso, authors] of Object.entries(localMemoriaState)) {
      const selfFiles = authors?.[selfAuthor];
      if (!selfFiles || typeof selfFiles !== "object") continue;
      for (const [file, info] of Object.entries(selfFiles)) {
        if (MEMORIA_IGNORED.has(file)) continue;
        if (uploaded.has(`${caso} ${selfAuthor} ${file}`)) put(caso, selfAuthor, file, fileMd5(info));
      }
    }
  }
  return next;
}

// Indices agregados (PEERS.md / FEEDBACK.md) sao ARTEFATOS do sync: o wiring
// (Task 10) os regera a partir do estado local e grava dentro de `.memoria`/
// `.feedback`. O CC le no maximo ~25 KB do MEMORY.md, entao os indices tem cap
// de 25 KB. Ao estourar, truncamos por ITEM INTEIRO (nunca corte no meio de um
// arquivo) e escrevemos um trailer VISIVEL com a contagem omitida.
const INDEX_MAX_BYTES = 25 * 1024;
// Folga reservada para o trailer; a contagem cabe com varios digitos.
const INDEX_TRAILER_RESERVE = 96;

function indexTrailer(n) {
  return `\n> [sync] ${n} itens omitidos por limite de tamanho\n`;
}

/**
 * Monta um indice agregado por-autor sobre `{ <autor>: { <arquivo>: {md5,content} } }`.
 * `header` e o texto de topo (explica a origem). Cada autor vira `## Autor <autor>`
 * e cada arquivo um bloco `### <nome>` seguido do conteudo. Anexa gulosamente por
 * byte ate o cap; itens que nao cabem sao contados e sinalizados no trailer. Pura.
 */
function buildAggregatedIndex(authorTrees, header) {
  authorTrees = authorTrees || {};
  const budget = INDEX_MAX_BYTES - INDEX_TRAILER_RESERVE;

  // Unidades de anexacao: cada arquivo e uma unidade; a primeira de cada autor
  // carrega o cabecalho do autor (assim um autor 100% omitido nao deixa header
  // solto). Ordenacao para saida deterministica.
  const units = [];
  for (const author of Object.keys(authorTrees).sort()) {
    const files = authorTrees[author];
    if (!files || typeof files !== "object") continue;
    let firstOfAuthor = true;
    for (const name of Object.keys(files).sort()) {
      const content = fileContent(files[name]) ?? "";
      let unit = "";
      if (firstOfAuthor) { unit += `## Autor ${author}\n\n`; firstOfAuthor = false; }
      unit += `### ${name}\n\n${content}\n\n`;
      units.push(unit);
    }
  }

  let out = header;
  let omitted = 0;
  let stopped = false;
  for (const unit of units) {
    if (stopped) { omitted++; continue; }
    if (Buffer.byteLength(out, "utf-8") + Buffer.byteLength(unit, "utf-8") <= budget) {
      out += unit;
    } else {
      // Trunca por item inteiro: para de anexar e conta o resto como omitido.
      stopped = true;
      omitted++;
    }
  }
  if (omitted > 0) out += indexTrailer(omitted);
  return out;
}

/**
 * Indice PEERS.md de um caso: memoria de caso dos OUTROS advogados sobre este
 * caso, agregada pelo sync. Input: `{ <autor>: { <arquivo>: {md5,content} } }`.
 */
export function buildPeersIndex(authorTrees) {
  const header =
    "# Memória de peers deste caso (agregada pelo sync)\n\n" +
    "Memória de caso de outros advogados do escritório sobre ESTE caso. " +
    "Somente leitura; o sync regenera este arquivo a cada ciclo.\n\n";
  return buildAggregatedIndex(authorTrees, header);
}

/**
 * Indice FEEDBACK.md do pool: feedback do escritório (aprendizados/correções)
 * agregado por autor pelo sync. Input: `{ <autor>: { <arquivo>: {md5,content} } }`.
 */
export function buildFeedbackIndex(authorTrees) {
  const header =
    "# Feedback do escritório (agregado pelo sync)\n\n" +
    "Aprendizados e correções compartilhados pelo escritório, agrupados por autor. " +
    "Somente leitura; o sync regenera este arquivo a cada ciclo.\n\n";
  return buildAggregatedIndex(authorTrees, header);
}

/**
 * Conteudo do <caso>/.claude/settings.local.json a provisionar, a partir do
 * settings.json do scaffolding (<casesBase>/.claude/settings.json). O CC NAO
 * herda settings de diretorio ancestral — a config que o scaffolding declara
 * para as sessoes de caso (outputStyle, permissions) fica inerte no pai e
 * cada caso nascia em default (selecao manual na primeira sessao). Retorna
 * a string JSON a gravar, ou null (sem scaffolding/sem outputStyle/JSON
 * invalido = no-op). So e gravado quando o arquivo NAO existe: depois do
 * nascimento ele pertence ao usuario/CC (mudar o style ou aprovar permissao
 * edita o mesmo arquivo; o sync nunca sobrescreve).
 */
export function buildLocalSettings(scaffoldingSettingsRaw, overrideStyle, autoMemoryDir) {
  if (typeof scaffoldingSettingsRaw !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(scaffoldingSettingsRaw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.outputStyle !== "string") return null;
  const out = { outputStyle: overrideStyle || parsed.outputStyle };
  if (parsed.permissions !== undefined) out.permissions = parsed.permissions;
  // CMR-138: auto memory por-caso. So grava quando o caller passa um dir
  // (string nao-vazia); a normalizacao do path e do caller — aqui grava literal.
  if (typeof autoMemoryDir === "string" && autoMemoryDir) out.autoMemoryDirectory = autoMemoryDir;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * Merge de `autoMemoryDirectory` num settings.local.json JA EXISTENTE (caso
 * legado, nascido antes do CMR-138). Round-trip preservando TODAS as chaves
 * (outputStyle, permissions, hooks, qualquer outra) — espelha a semantica de
 * setup.mjs:buildGlobalSettings (nao pisa em config alheia). Regras:
 *   - raw invalido/array/null/primitivo -> null (nao sobrescreve config corrompida)
 *   - raw que JA contem autoMemoryDirectory -> retorna o JSON inalterado
 *     (nunca sobrescreve escolha local do usuario)
 * O valor gravado e literal — a normalizacao do path (absoluto, `/` no Windows)
 * e responsabilidade do caller.
 */
export function mergeAutoMemoryDir(existingLocalRaw, autoMemoryDir) {
  if (typeof existingLocalRaw !== "string") return null;
  let obj;
  try {
    obj = JSON.parse(existingLocalRaw);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  if (obj.autoMemoryDirectory !== undefined) return `${JSON.stringify(obj, null, 2)}\n`;
  obj.autoMemoryDirectory = autoMemoryDir;
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/**
 * Extrai o override de output style do case.yaml do caso (campo opcional
 * `output_style: <nome>`, escrito na VM — a mao ou pelo classifier). O
 * case.yaml e formato NOSSO (materializado pelo case-ingest), entao um
 * match de linha basta — sem dependencia de parser YAML completo. Aceita
 * valor plano ou entre aspas; comentario inline (` # ...`) e descartado.
 */
export function extractOutputStyle(caseYamlRaw) {
  if (typeof caseYamlRaw !== "string") return null;
  const m = caseYamlRaw.match(/^output_style:[ \t]*(.+)$/m);
  if (!m) return null;
  let v = m[1].trim();
  const quoted = v.match(/^"([^"]*)"|^'([^']*)'/);
  if (quoted) {
    v = quoted[1] ?? quoted[2];
  } else {
    v = v.replace(/[ \t]+#.*$/, "").trim();
  }
  return v || null;
}

/** Nome de destino em _archive/, sufixando -YYYYMMDD em colisao. */
export function archiveTarget(name, taken, now = new Date()) {
  if (!taken.has(name)) return name;
  const ymd = now.toISOString().slice(0, 10).replaceAll("-", "");
  const candidate = `${name}-${ymd}`;
  if (!taken.has(candidate)) return candidate;
  return `${name}-${now.toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
}

// ---------- I/O ----------

function readLocalState(casesBase) {
  const state = {};
  if (!existsSync(casesBase)) return state;
  for (const entry of readdirSync(casesBase, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const files = {};
    for (const f of BRIEFING_FILES) {
      const p = join(casesBase, entry.name, f);
      if (existsSync(p)) files[f] = md5hex(readFileSync(p));
    }
    state[entry.name] = files;
  }
  return state;
}

/** Le os *.md de um dir de autor -> { <arquivo>: { md5, content } }, aplicando ignore. */
function readAuthorFiles(authorDir, ignored) {
  const files = {};
  for (const fileEntry of readdirSync(authorDir, { withFileTypes: true })) {
    if (!fileEntry.isFile()) continue;
    const name = fileEntry.name;
    if (ignored.has(name)) continue;
    if (!name.endsWith(".md")) continue;
    const buf = readFileSync(join(authorDir, name));
    files[name] = { md5: md5hex(buf), content: buf.toString("utf-8") };
  }
  return files;
}

/**
 * Le a arvore de memoria de caso local: `<casesBase>/<caso>/.memoria/<autor>/*.md`.
 * Retorna { <caso>: { <autor>: { <arquivo>: { md5, content } } } } (com content —
 * o upload do self e os indices precisam do conteudo). Ignora PEERS.md (artefato
 * do sync), entradas nao-dir, arquivos nao-.md e casos sem `.memoria`. Tolerante:
 * casesBase/dir ausente -> objeto vazio. md5 dos bytes crus, como readLocalState.
 */
export function readMemoriaState(casesBase) {
  const state = {};
  if (!existsSync(casesBase)) return state;
  for (const caseEntry of readdirSync(casesBase, { withFileTypes: true })) {
    if (!caseEntry.isDirectory()) continue;
    const memDir = join(casesBase, caseEntry.name, ".memoria");
    if (!existsSync(memDir)) continue;
    const authors = {};
    for (const authorEntry of readdirSync(memDir, { withFileTypes: true })) {
      if (!authorEntry.isDirectory()) continue;
      const files = readAuthorFiles(join(memDir, authorEntry.name), MEMORIA_IGNORED);
      if (Object.keys(files).length > 0) authors[authorEntry.name] = files;
    }
    if (Object.keys(authors).length > 0) state[caseEntry.name] = authors;
  }
  return state;
}

/**
 * Le o pool de feedback do escritorio local: `<casesBase>/.feedback/<autor>/*.md`.
 * Retorna { <autor>: { <arquivo>: { md5, content } } }. Ignora FEEDBACK.md (indice
 * na raiz de `.feedback/` — cai fora por nao ser dir; ignorado defensivamente em
 * qualquer nivel), entradas nao-dir e arquivos nao-.md. Tolerante: `.feedback`
 * ausente -> objeto vazio.
 */
export function readFeedbackState(casesBase) {
  const state = {};
  if (!existsSync(casesBase)) return state;
  const feedbackDir = join(casesBase, ".feedback");
  if (!existsSync(feedbackDir)) return state;
  for (const authorEntry of readdirSync(feedbackDir, { withFileTypes: true })) {
    if (!authorEntry.isDirectory()) continue; // FEEDBACK.md na raiz cai aqui (nao-dir)
    const files = readAuthorFiles(join(feedbackDir, authorEntry.name), FEEDBACK_IGNORED);
    if (Object.keys(files).length > 0) state[authorEntry.name] = files;
  }
  return state;
}

/** Escrita atomica: tmp + rename (rename sobrescreve no Windows via MoveFileEx). */
function writeAtomic(path, content) {
  const tmp = `${path}.sync-tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}

const STATE_FILE = ".sync-state.json";

export function readBaselineFrom(casesBase) {
  const p = join(casesBase, STATE_FILE);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {}; // estado corrompido: trata como bootstrap, nao derruba o sync
  }
}

function writeBaseline(casesBase, baseline) {
  const path = join(casesBase, STATE_FILE);
  const tmp = `${path}.sync-tmp`;
  writeFileSync(tmp, JSON.stringify(baseline), "utf-8");
  renameSync(tmp, path);
}

async function fetchJson(url) {
  // Bearer S2S via requestWithAuth: injeta Authorization quando ha credencial
  // (login do plugin), faz refresh em 401, e DEGRADA sem credencial (segue sem
  // Bearer -- preserva o uso atual na tailnet com require_bearer=false). Mesma
  // credencial do MCP (keychain), entao o sync herda o login sem passo extra.
  const res = await requestWithAuth((authHeaders) =>
    fetch(url, { headers: authHeaders, signal: AbortSignal.timeout(10_000) }),
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return await res.json();
}

/**
 * POST autenticado espelhando fetchJson: Bearer S2S via requestWithAuth (injeta
 * quando ha credencial, refresh em 401, degrada sem credencial), timeout 10s,
 * lanca em nao-ok. Body JSON. Retorna a resposta parseada. Usado no upload de
 * memoria/feedback (CMR-138).
 */
export async function postJson(url, body) {
  const res = await requestWithAuth((authHeaders) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    }),
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return await res.json();
}

function appendLog(casesBase, line) {
  try {
    appendFileSync(join(casesBase, ".sync.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // log nunca derruba o sync
  }
}

// ---------- CMR-138: wiring do sync de memoria de caso (Task 10) ----------
//
// Liga as puras (planMemoriaActions/computeMemoriaBaseline + read*State +
// build*Index) a rede e disco. Estado SEPARADO em .memoria-state.json — a
// invariante dos 3 briefing files (.sync-state.json etc) e INTOCAVEL. Toda
// falha de I/O/rede loga e continua; nenhum caminho aqui pode derrubar o sync
// de briefing (main chama em try/catch proprio).

// Estado do sync de memoria — arquivo PROPRIO, distinto de .sync-state.json.
const STATE_FILE_MEMORIA = ".memoria-state.json";

// Pseudo-caso do pool de feedback nas estruturas de plano/baseline: um unico
// mapa combinado {...casosReais, ".feedback": authorsDoPool} passa por
// planMemoriaActions/computeMemoriaBaseline como se fosse mais um caso. Nunca
// colide com caso real (o server rejeita nome com leading dot).
const FEEDBACK_POOL = ".feedback";

// Caps de upload — espelham o servidor: 50 arquivos/req, 1 MiB/arquivo, 5 MiB/req.
const UPLOAD_MAX_FILES = 50;
const UPLOAD_MAX_FILE_BYTES = 1024 * 1024;
const UPLOAD_MAX_REQ_BYTES = 5 * 1024 * 1024;
// Folga por arquivo p/ o envelope JSON ({"files":[{"name","content"}]} + escaping):
// orcamos sobre content+name para nunca estourar o limite de body do server.
const UPLOAD_ENVELOPE_RESERVE = 64;

function readMemoriaBaselineFrom(casesBase) {
  const p = join(casesBase, STATE_FILE_MEMORIA);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {}; // estado corrompido: trata como bootstrap, nao derruba o sync
  }
}

function writeMemoriaBaseline(casesBase, baseline) {
  const path = join(casesBase, STATE_FILE_MEMORIA);
  const tmp = `${path}.sync-tmp`;
  writeFileSync(tmp, JSON.stringify(baseline), "utf-8");
  renameSync(tmp, path);
}

/**
 * Agrupa arquivos de upload em batches respeitando os caps do servidor:
 * <=UPLOAD_MAX_FILES por batch e custo (content+name+envelope) <=UPLOAD_MAX_REQ_BYTES.
 * Arquivos sem content string ou acima de UPLOAD_MAX_FILE_BYTES sao pulados
 * (reportados em `skipped`, nunca derrubam o batch). Pura.
 * Retorna { batches: [[file]], skipped: [{ name, case, reason }] }.
 */
function batchUploads(files) {
  const batches = [];
  const skipped = [];
  let cur = [];
  let curBytes = 0;
  for (const f of files) {
    if (typeof f.content !== "string") {
      skipped.push({ name: f.name, case: f.case, reason: "sem conteudo" });
      continue;
    }
    const contentBytes = Buffer.byteLength(f.content, "utf-8");
    if (contentBytes > UPLOAD_MAX_FILE_BYTES) {
      skipped.push({ name: f.name, case: f.case, reason: ">1MiB" });
      continue;
    }
    const cost = contentBytes + Buffer.byteLength(f.name, "utf-8") + UPLOAD_ENVELOPE_RESERVE;
    if (cur.length >= UPLOAD_MAX_FILES || (cur.length > 0 && curBytes + cost > UPLOAD_MAX_REQ_BYTES)) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(f);
    curBytes += cost;
  }
  if (cur.length > 0) batches.push(cur);
  return { batches, skipped };
}

/**
 * Sincroniza a memoria de caso por-autor: baixa peers (+ self sob never-overwrite)
 * e sobe SO os arquivos do proprio autor, roteados p/ memoria-de-caso ou pool de
 * feedback. Orquestra as puras da Task 8/9. `deps` injeta a rede em teste
 * (getJson/postJson); default usa as reais (fetchJson/postJson). NUNCA lanca —
 * toda falha loga e continua. selfAuthor null/undefined -> skip total.
 *
 * Contratos do servidor:
 *   GET  /memoria-manifest   -> { cases: { <caso>: { <autor>: { <arq>: md5 } } } }
 *   GET  /feedback-manifest  -> { authors: { <autor>: { <arq>: md5 } } }
 *   GET  /cases/{c}/memoria/{a} e /feedback/{a} -> { files: { <arq>: {content,md5} } }
 *   POST /cases/{c}/memoria e /feedback -> body { files: [{name,content}] };
 *        resp { author, count, written: [nome], case? }
 */
export async function syncMemoria(apiBase, casesBase, selfAuthor, deps = {}) {
  const doGet = deps.getJson || fetchJson;
  const doPost = deps.postJson || postJson;

  if (selfAuthor === null || selfAuthor === undefined) {
    appendLog(casesBase, "memoria: sem autor (credencial ausente/sem sub) -> skip");
    return;
  }

  // 1) Dois GETs fixos por ciclo (manifests agregados). Falha -> skip com log.
  let memManifest, fbManifest;
  try {
    memManifest = await doGet(`${apiBase}/memoria-manifest`);
    fbManifest = await doGet(`${apiBase}/feedback-manifest`);
  } catch (err) {
    appendLog(casesBase, `memoria: erro manifest: ${err.message}`);
    return;
  }

  const remoteCombined = {
    ...(memManifest?.cases || {}),
    [FEEDBACK_POOL]: fbManifest?.authors || {},
  };

  // 2) Estado local + baseline combinados (pool como pseudo-caso).
  let memoriaState = {}, feedbackState = {}, baseline = {};
  try {
    memoriaState = readMemoriaState(casesBase);
    feedbackState = readFeedbackState(casesBase);
    baseline = readMemoriaBaselineFrom(casesBase);
  } catch (err) {
    appendLog(casesBase, `memoria: erro lendo estado local: ${err.message}`);
    return;
  }
  const localCombined = { ...memoriaState, [FEEDBACK_POOL]: feedbackState };

  const plan = planMemoriaActions(remoteCombined, localCombined, baseline, selfAuthor);

  // 3+4) Downloads: so casos com dir local (pool sempre elegivel). Escrita atomica
  // em <caso>/.memoria/<autor>/ ou .feedback/<autor>/. Chave de sucesso combina
  // com computeMemoriaBaseline (`${caso} ${autor} ${arquivo}`, caso=".feedback" no pool).
  const succeeded = new Set();
  let downloaded = 0;
  for (const d of plan.downloadAuthors) {
    const isPool = d.case === FEEDBACK_POOL;
    const caseDir = isPool ? join(casesBase, FEEDBACK_POOL) : join(casesBase, d.case);
    if (!isPool && !existsSync(caseDir)) {
      appendLog(casesBase, `memoria: caso ${d.case} sem dir local -> skip download`);
      continue;
    }
    const authorDir = isPool ? join(caseDir, d.author) : join(caseDir, ".memoria", d.author);
    let payload;
    try {
      const path = isPool
        ? `${apiBase}/feedback/${encodeURIComponent(d.author)}`
        : `${apiBase}/cases/${encodeURIComponent(d.case)}/memoria/${encodeURIComponent(d.author)}`;
      payload = await doGet(path);
    } catch (err) {
      appendLog(casesBase, `memoria: erro baixando ${d.case}/${d.author}: ${err.message}`);
      continue;
    }
    try {
      mkdirSync(authorDir, { recursive: true });
    } catch (err) {
      appendLog(casesBase, `memoria: erro mkdir ${authorDir}: ${err.message}`);
      continue;
    }
    for (const file of d.files) {
      const remote = payload?.files?.[file];
      if (!remote || typeof remote.content !== "string") continue; // sumiu entre manifest e fetch
      try {
        writeAtomic(join(authorDir, file), remote.content);
        succeeded.add(`${d.case} ${d.author} ${file}`);
        downloaded++;
      } catch (err) {
        appendLog(casesBase, `memoria: erro escrevendo ${d.case}/${d.author}/${file}: ${err.message}`);
      }
    }
  }

  // 5) Indices agregados a partir do estado POS-download (reflete o disco real).
  let postMem = {}, postFb = {};
  try { postMem = readMemoriaState(casesBase); } catch { /* index degrada p/ vazio */ }
  try { postFb = readFeedbackState(casesBase); } catch { /* idem */ }

  // PEERS.md por caso: autores do caso EXCLUINDO o self; so escreve se ha >=1 peer com arquivo.
  for (const [caso, authors] of Object.entries(postMem)) {
    const peerTrees = {};
    for (const [author, files] of Object.entries(authors)) {
      if (author === selfAuthor) continue;
      if (files && Object.keys(files).length > 0) peerTrees[author] = files;
    }
    if (Object.keys(peerTrees).length === 0) continue;
    try {
      const memDir = join(casesBase, caso, ".memoria");
      mkdirSync(memDir, { recursive: true });
      writeAtomic(join(memDir, "PEERS.md"), buildPeersIndex(peerTrees));
    } catch (err) {
      appendLog(casesBase, `memoria: erro PEERS.md ${caso}: ${err.message}`);
    }
  }

  // FEEDBACK.md do pool: TODOS os autores do pool (inclui self). So se ha pool.
  if (Object.keys(postFb).length > 0) {
    try {
      const fbDir = join(casesBase, FEEDBACK_POOL);
      mkdirSync(fbDir, { recursive: true });
      writeAtomic(join(fbDir, "FEEDBACK.md"), buildFeedbackIndex(postFb));
    } catch (err) {
      appendLog(casesBase, `memoria: erro FEEDBACK.md: ${err.message}`);
    }
  }

  // 6) Uploads roteados por target (never-overwrite decidido pela pura): target
  // "feedback" -> POST /feedback (case ignorado no server); "memoria" -> POST por
  // caso. `uploaded` chaveia por u.case (verbatim) p/ casar computeMemoriaBaseline.
  const uploaded = new Set();
  let uploadedCount = 0;
  const feedbackFiles = plan.uploadFiles.filter((u) => u.target === "feedback");
  const memoriaByCase = new Map();
  for (const u of plan.uploadFiles) {
    if (u.target === "feedback") continue;
    // target "memoria" com caso invalido (pseudo-caso/leading dot) nunca vira POST
    // de caso — o server rejeitaria; pula com log (defensivo, nao ocorre no fluxo real).
    if (typeof u.case !== "string" || u.case.startsWith(".")) {
      appendLog(casesBase, `memoria: upload memoria com caso invalido ${u.case}/${u.name} -> skip`);
      continue;
    }
    if (!memoriaByCase.has(u.case)) memoriaByCase.set(u.case, []);
    memoriaByCase.get(u.case).push(u);
  }

  // Posta batches de uma lista e coleta o `written` do server (so o ACEITO vira baseline).
  const postBatches = async (files, url, label) => {
    const { batches, skipped } = batchUploads(files);
    for (const s of skipped) {
      appendLog(casesBase, `memoria: upload pulado (${label}) ${s.name}: ${s.reason}`);
    }
    for (const batch of batches) {
      try {
        const resp = await doPost(url, { files: batch.map((f) => ({ name: f.name, content: f.content })) });
        const written = new Set(Array.isArray(resp?.written) ? resp.written : []);
        for (const f of batch) {
          if (written.has(f.name)) {
            uploaded.add(`${f.case} ${selfAuthor} ${f.name}`);
            uploadedCount++;
          }
        }
      } catch (err) {
        appendLog(casesBase, `memoria: erro upload (${label}): ${err.message}`);
      }
    }
  };

  await postBatches(feedbackFiles, `${apiBase}/feedback`, "feedback");
  for (const [caso, files] of memoriaByCase) {
    await postBatches(files, `${apiBase}/cases/${encodeURIComponent(caso)}/memoria`, `memoria ${caso}`);
  }

  // 7) Baseline combinado (inclui o pseudo-caso .feedback). NUNCA toca .sync-state.json.
  try {
    const next = computeMemoriaBaseline(remoteCombined, localCombined, baseline, succeeded, uploaded, selfAuthor);
    writeMemoriaBaseline(casesBase, next);
  } catch (err) {
    appendLog(casesBase, `memoria: erro baseline: ${err.message}`);
  }

  appendLog(casesBase, `memoria: ok baixados=${downloaded} uploads=${uploadedCount}`);
}

async function main() {
  const apiBase = process.env.CASE_KNOWLEDGE_API_BASE || defaultApiBase();
  const casesBase = process.env.CASE_KNOWLEDGE_CASES_BASE || defaultCasesBase();
  mkdirSync(casesBase, { recursive: true });

  // CMR-138: autor da memoria (namespace-por-autor) derivado UMA vez do sub do
  // access_jwt, no INICIO (a injecao de autoMemoryDirectory por-caso da Task 11
  // precisa do selfAuthor no path). Sem credencial/sub -> null: a memoria e
  // pulada e o sync de briefing segue normal. Try/catch defensivo: uma falha
  // rara ao ler a credencial NUNCA pode derrubar o sync de briefing abaixo.
  let selfAuthor = null;
  try {
    const cred = readCredential();
    selfAuthor = cred && cred.access_jwt ? decodeJwtSub(cred.access_jwt) : null;
  } catch {
    selfAuthor = null;
  }

  let manifest;
  try {
    manifest = await fetchJson(`${apiBase}/cases/sync-manifest`);
  } catch (err) {
    appendLog(casesBase, `erro manifest: ${err.message}`);
    return; // proximo ciclo e o retry
  }

  const manifestCases = manifest.cases || [];
  const localState = readLocalState(casesBase);
  const baseline = readBaselineFrom(casesBase);
  const plan = planActions(manifestCases, localState, baseline);
  let updated = 0;
  const errors = [];
  const succeeded = new Set();

  for (const name of plan.mkdir) {
    mkdirSync(join(casesBase, name), { recursive: true });
  }

  for (const { name, files } of plan.download) {
    try {
      const briefing = await fetchJson(`${apiBase}/cases/${encodeURIComponent(name)}/briefing`);
      for (const f of files) {
        const remote = briefing.files?.[f];
        if (!remote) continue; // sumiu entre manifest e fetch; proximo ciclo resolve
        writeAtomic(join(casesBase, name, f), remote.content);
        // Chave deve usar nome do dir local (plan.download[].name = targetName),
        // igual ao que computeBaseline usa em `${localName} ${file}`. NTFS-safe.
        succeeded.add(`${name} ${f}`);
        updated++;
      }
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }

  // Provisiona .claude/settings.local.json (outputStyle/permissions do
  // scaffolding, com override opcional `output_style:` do case.yaml do caso)
  // nos casos do manifest que ainda nao tem — cria-se-ausente, cobre legados
  // e recem-criados; nunca sobrescreve (CMR-103). Roda DEPOIS dos downloads:
  // caso novo precisa do case.yaml ja no disco para o override valer no
  // nascimento. Dirs locais fora do manifest nao sao tocados.
  let provisioned = 0;
  try {
    const scaffoldingSettings = join(casesBase, ".claude", "settings.json");
    const scaffoldingRaw = existsSync(scaffoldingSettings)
      ? readFileSync(scaffoldingSettings, "utf-8")
      : null;
    if (buildLocalSettings(scaffoldingRaw)) {
      const localByLower = new Map(
        Object.keys(localState).map((k) => [k.toLowerCase(), k]),
      );
      for (const c of manifestCases) {
        if (!VALID_CASE_NAME.test(c.name) || isExcluded(c.name)) continue;
        const dirName = localByLower.get(c.name.toLowerCase()) ?? c.name;
        const caseDir = join(casesBase, dirName);
        if (!existsSync(caseDir)) continue;
        const target = join(caseDir, ".claude", "settings.local.json");
        if (existsSync(target)) continue;
        const caseYamlPath = join(caseDir, "case.yaml");
        const overrideStyle = extractOutputStyle(
          existsSync(caseYamlPath) ? readFileSync(caseYamlPath, "utf-8") : null,
        );
        const localSettings = buildLocalSettings(scaffoldingRaw, overrideStyle);
        mkdirSync(join(caseDir, ".claude"), { recursive: true });
        writeAtomic(target, localSettings);
        provisioned++;
      }
    }
  } catch (err) {
    errors.push(`settings: ${err.message}`);
  }

  let archived = 0;
  if (plan.orphans.length > 0) {
    const archiveDir = join(casesBase, "_archive");
    mkdirSync(archiveDir, { recursive: true });
    const taken = new Set(readdirSync(archiveDir));
    for (const name of plan.orphans) {
      try {
        const target = archiveTarget(name, taken);
        renameSync(join(casesBase, name), join(archiveDir, target));
        taken.add(target);
        archived++;
      } catch (err) {
        errors.push(`orfao ${name}: ${err.message}`);
      }
    }
  }

  // Persiste o baseline (md5 da versao da VM por arquivo sincronizado).
  try {
    writeBaseline(casesBase, computeBaseline(manifestCases, localState, baseline, succeeded));
  } catch (err) {
    errors.push(`baseline: ${err.message}`);
  }

  // Loga edicoes locais preservadas (visibilidade para reconciliar a mao).
  for (const { name, file } of plan.conflicts) {
    appendLog(casesBase, `conflito preservado: ${name}/${file} editado localmente diverge da VM (nao sobrescrito)`);
  }

  const summary =
    `${errors.length ? "erro" : "ok"} mkdir=${plan.mkdir.length} ` +
    `arquivos_atualizados=${updated} orfaos_arquivados=${archived} conflitos=${plan.conflicts.length}` +
    (provisioned ? ` settings_provisionados=${provisioned}` : "") +
    (errors.length ? ` ERROS: ${errors.join(" | ")}` : "");
  appendLog(casesBase, summary);

  // CMR-138: sincroniza a memoria de caso por-autor (peers + upload do self).
  // Roda DEPOIS do briefing/settings, com estado e log PROPRIOS
  // (.memoria-state.json). syncMemoria nunca lanca; o try/catch e ultima linha
  // de defesa para garantir que a memoria jamais derrube o sync de briefing.
  try {
    await syncMemoria(apiBase, casesBase, selfAuthor);
  } catch (err) {
    appendLog(casesBase, `memoria: erro inesperado: ${err.message}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // ultima linha de defesa: nunca propagar exit != 0 pro scheduler
    try { appendLog(process.env.CASE_KNOWLEDGE_CASES_BASE || defaultCasesBase(), `erro fatal: ${err.message}`); } catch {}
  });
}
