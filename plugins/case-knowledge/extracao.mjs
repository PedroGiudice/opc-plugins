/**
 * Extração automática de texto dos workdocs — lógica PURA.
 *
 * Decide o que extrair e renderiza as estruturas que os leitores de formato
 * (extracao/docx.mjs, extracao/xlsx.mjs, extracao/email.mjs) produzem. Sem I/O:
 * o wiring (disco, orçamento, log) vive em extrair.mjs, como o par
 * workdocs.mjs / sync-cases.mjs.
 *
 * Spec: case-docs/docs/superpowers/specs/2026-10-15-extracao-automatica-workdocs-design.md
 */
import { isSafeRelPath, isExcludedDirName } from "./workdocs.mjs";

// Versão do FORMATO de saída, não do plugin: só muda quando a renderização
// muda de modo que valha reextrair o parque (sidecar com versão menor é
// regerado no próximo tick).
export const EXTRATOR_VERSAO = 1;
export const EXTRATOR_NOME = "case-knowledge/extracao";

export const FORMATOS = Object.freeze({
  docx: "docx",
  docm: "docx",
  xlsx: "xlsx",
  xlsm: "xlsx",
  msg: "msg",
  eml: "eml",
});

const LOCK_PREFIX = "~$";
const CONFLITO = ".conflito-";
const OPT_OUT = ".local";

// Minúsculas ASCII, como o `asciiLower` de workdocs.mjs (o `toLowerCase` do JS
// é Unicode-aware e divergiria do servidor em nomes exóticos).
function asciiLower(s) {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

function basename(rel) {
  const i = rel.lastIndexOf("/");
  return i < 0 ? rel : rel.slice(i + 1);
}

function extensao(rel) {
  const b = basename(rel);
  const i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i + 1).toLowerCase();
}

export function tipoDeFormato(rel) {
  return FORMATOS[extensao(rel)] ?? null;
}

// Stem com opt-out pessoal (`x.local.docx`): o sidecar herda o opt-out
// (`x.local.docx.local.md`) para o pool também ignorá-lo. Comparação sem caixa,
// como o canal de workdocs faz com WORKDOC_OPT_OUT_SUFFIX.
function temOptOut(rel) {
  const b = basename(rel);
  const stem = b.slice(0, b.lastIndexOf("."));
  return stem.toLowerCase().endsWith(OPT_OUT);
}

export function nomeSidecar(rel) {
  return temOptOut(rel) ? `${rel}${OPT_OUT}.md` : `${rel}.md`;
}

export function ehOriginalElegivel(rel) {
  if (typeof rel !== "string" || !tipoDeFormato(rel)) return false;
  if (!isSafeRelPath(rel)) return false;
  const partes = rel.split("/");
  // Sem caixa, como `isWorkdocPath`: o cliente é NTFS, e `X.CONFLITO-ana.docx`
  // é cópia de conflito tanto quanto `x.conflito-ana.docx`. Poda idêntica à do
  // canal, senão o extrator geraria sidecar de arquivo que o canal não circula.
  const nome = asciiLower(partes[partes.length - 1]);
  if (nome.startsWith(LOCK_PREFIX) || nome.includes(CONFLITO)) return false;
  // `isSafeRelPath` já barra dotdir; o laço fica mesmo assim: a poda de árvores
  // barradas é regra DESTA função, não efeito colateral de outra.
  for (const dir of partes.slice(0, -1)) {
    if (dir.startsWith(".") || isExcludedDirName(dir)) return false;
  }
  return true;
}

// Escapa como string YAML entre aspas duplas. Além de `\` e `"`, TODO caractere
// de controle (U+0000-U+001F) é escapado: um `\n` cru quebraria a linha do
// frontmatter, `lerFrontmatter` devolveria null e o sidecar do próprio extrator
// passaria a ser tratado como arquivo do usuário (naoTocar) para sempre. Nome
// de arquivo do Windows e assunto de e-mail podem trazer esses caracteres.
const ESCAPES_CURTOS = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t" };

function yamlStr(s) {
  const esc = String(s).replace(/[\\"\u0000-\u001F]/g, (c) =>
    ESCAPES_CURTOS[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `"${esc}"`;
}

// Inverso de yamlStr em UMA passada: uma sequência `\\n` (barra literal + n) não
// pode ser relida como quebra de linha, o que aconteceria com replaces em série.
const DESFAZ = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };

function unYamlStr(s) {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(s.trim());
  if (!m) return null;
  return m[1].replace(/\\(?:u([0-9a-fA-F]{4})|(["\\nrt]))/g, (_, hex, c) =>
    hex !== undefined ? String.fromCharCode(parseInt(hex, 16)) : DESFAZ[c]);
}

// Serialização própria, não `js-yaml`: o subconjunto é fixo (strings, inteiro,
// lista de strings) e a escrita tem que ser estável byte a byte entre versões
// de qualquer lib. Sem data nem nome de máquina: mesmo input, mesma saída.
export function montarSidecar({ fonte, md5, bytes, avisos, corpo }) {
  const linhas = [
    "---",
    `fonte: ${yamlStr(fonte)}`,
    `fonte_md5: ${md5}`,
    `fonte_bytes: ${bytes}`,
    `extrator: ${yamlStr(`${EXTRATOR_NOME} ${EXTRATOR_VERSAO}`)}`,
  ];
  if (!avisos || avisos.length === 0) {
    linhas.push("avisos: []");
  } else {
    linhas.push("avisos:");
    for (const a of avisos) linhas.push(`  - ${yamlStr(a)}`);
  }
  linhas.push("---", "");
  let saida = linhas.join("\n") + "\n" + corpo.replace(/\r\n?/g, "\n");
  if (!saida.endsWith("\n")) saida += "\n";
  return saida;
}

// Leitura própria, tolerante só ao que escrevemos: qualquer desvio devolve null
// e o `.md` é tratado como do usuário (nunca sobrescrito).
export function lerFrontmatter(texto) {
  if (typeof texto !== "string" || !texto.startsWith("---\n")) return null;
  const fim = texto.indexOf("\n---\n", 4);
  if (fim < 0) return null;
  const bloco = texto.slice(4, fim).split("\n");
  const out = { avisos: [] };
  let emAvisos = false;
  for (const linha of bloco) {
    if (emAvisos && linha.startsWith("  - ")) {
      const v = unYamlStr(linha.slice(4));
      if (v === null) return null;
      out.avisos.push(v);
      continue;
    }
    emAvisos = false;
    const i = linha.indexOf(":");
    if (i < 0) return null;
    const chave = linha.slice(0, i);
    const valor = linha.slice(i + 1).trim();
    if (chave === "fonte") out.fonte = unYamlStr(valor);
    else if (chave === "fonte_md5") out.fonte_md5 = valor;
    else if (chave === "fonte_bytes") out.fonte_bytes = Number(valor);
    else if (chave === "extrator") {
      const s = unYamlStr(valor);
      const m = s && /^(.+) (\d+)$/.exec(s);
      if (!m) return null;
      out.extrator_nome = m[1];
      out.extrator_versao = Number(m[2]);
    } else if (chave === "avisos") {
      if (valor === "[]") continue;
      if (valor !== "") return null;
      emAvisos = true;
    } else return null;
  }
  // Só é nosso quando tem os campos obrigatórios e o nome do extrator.
  if (out.extrator_nome !== EXTRATOR_NOME) return null;
  if (typeof out.fonte !== "string" || !/^[0-9a-f]{32}$/.test(out.fonte_md5 ?? "")) return null;
  if (!Number.isInteger(out.fonte_bytes)) return null;
  return {
    fonte: out.fonte,
    fonte_md5: out.fonte_md5,
    fonte_bytes: out.fonte_bytes,
    extrator_nome: out.extrator_nome,
    extrator_versao: out.extrator_versao,
    avisos: out.avisos,
  };
}

/**
 * Decide, para cada original elegível, se extrai, pula ou não toca.
 * `originais`: {rel: {md5, bytes}}; `sidecars`: {rel: textoDoMd} (só os .md
 * que o wiring achou ao lado de um original). Ordem de saída por path, para o
 * log e o resumo serem estáveis.
 */
export function planejarExtracao({ originais = {}, sidecars = {} } = {}) {
  const extrair = [];
  const pular = [];
  const naoTocar = [];
  for (const rel of Object.keys(originais).sort()) {
    if (!ehOriginalElegivel(rel)) continue;
    const sidecar = nomeSidecar(rel);
    const texto = sidecars[sidecar];
    if (texto === undefined) {
      extrair.push({ rel, sidecar, motivo: "sem sidecar" });
      continue;
    }
    const fm = lerFrontmatter(texto);
    if (!fm) {
      // .md com esse nome que não é nosso: é do usuário. Nunca sobrescrever.
      naoTocar.push({ rel, sidecar, motivo: "sidecar sem frontmatter do extrator (arquivo do usuário)" });
      continue;
    }
    if (fm.fonte_md5 !== originais[rel].md5) {
      extrair.push({ rel, sidecar, motivo: "original mudou" });
    } else if (fm.extrator_versao < EXTRATOR_VERSAO) {
      extrair.push({ rel, sidecar, motivo: "extrator desatualizado" });
    } else {
      pular.push({ rel, motivo: "sidecar em dia" });
    }
  }
  return { extrair, pular, naoTocar };
}
