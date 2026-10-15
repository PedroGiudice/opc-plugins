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

// ---------- .docx ----------

// Marcadores de lacuna usuais em minuta: o rótulo é o que a radiografia mostra.
const PLACEHOLDERS = [
  ["XXXX", /X{4,}/g],
  ["[●]", /\[●\]/g],
  ["___", /_{3,}/g],
  ["( )", /\(\s+\)/g],
];

/** Conta os placeholders de minuta no texto; só entram as chaves com contagem > 0. */
export function acharPlaceholders(texto) {
  const out = {};
  for (const [rotulo, re] of PLACEHOLDERS) {
    const n = (texto.match(re) ?? []).length;
    if (n > 0) out[rotulo] = n;
  }
  return out;
}

function plural(n, um, varios) {
  return `${n} ${n === 1 ? um : varios}`;
}

function escaparCelula(s) {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * Segmentos do leitor em Markdown: CriticMarkup com o autor entre colchetes;
 * âncoras como referência de nota. Exportado porque o leitor de .docx usa a
 * mesma notação no texto de célula de tabela (que no contrato é string).
 */
export function renderSegmentos(segs) {
  let s = "";
  for (const seg of segs) {
    if (seg.comentarios) {
      s += seg.comentarios.map((id) => `[^c${id}]`).join("");
      continue;
    }
    if (seg.nota !== undefined) {
      s += `[^n${seg.nota}]`;
      continue;
    }
    if (seg.marca === "ins") s += `{++${seg.texto}++}[${seg.autor}]`;
    else if (seg.marca === "del") s += `{--${seg.texto}--}[${seg.autor}]`;
    else s += seg.texto;
  }
  return s;
}

/**
 * Corpo do sidecar de um .docx a partir da estrutura de lerDocx. A
 * radiografia vem primeiro porque é o que decide se o advogado pode confiar
 * no texto: marcas de revisão e comentários pendentes mudam o que o contrato
 * diz. Marcas e placeholders contam em parágrafos e tabelas. Placeholders
 * são contados no texto ACEITO (exclusões fora), que é o que ficará no
 * contrato. Autores em ordem alfabética com colação pt-BR fixa
 * (não a do sistema), para a saída não depender da máquina nem da ordem de
 * aparição.
 */
export function renderDocx(d) {
  // --- radiografia ---
  const porAutor = new Map(); // autor -> {ins, del}
  let ins = 0;
  let del = 0;
  let textoAceito = "";
  for (const b of d.blocos) {
    // tabela conta pelos segmentos das células; tabela sem `segmentos`
    // (estrutura montada à mão) conta como vazia
    for (const s of b.segmentos ?? []) {
      if (s.marca) {
        const a = porAutor.get(s.autor) ?? { ins: 0, del: 0 };
        a[s.marca] += 1;
        porAutor.set(s.autor, a);
        if (s.marca === "ins") {
          ins += 1;
          textoAceito += s.texto;
        } else del += 1;
      } else textoAceito += s.texto;
    }
    textoAceito += "\n";
  }
  const porAutorOrdenado = Array.from(porAutor.entries()).sort(([a], [b]) => a.localeCompare(b, "pt-BR"));
  const porAutorCom = new Map();
  for (const c of d.comentarios) porAutorCom.set(c.autor, (porAutorCom.get(c.autor) ?? 0) + 1);
  const placeholders = acharPlaceholders(textoAceito);
  const linhas = ["## Radiografia", ""];
  const temMarcas = ins + del > 0;
  const temCom = d.comentarios.length > 0;
  const temPh = Object.keys(placeholders).length > 0;
  if (!temMarcas && !temCom && !temPh && !d.temNumeracao) {
    linhas.push("- Sem marcas de revisão, sem comentários, sem placeholders, sem numeração automática.");
  } else {
    if (temMarcas) {
      const detalhe = porAutorOrdenado
        .map(([autor, a]) => {
          const partes = [a.ins ? plural(a.ins, "inserção", "inserções") : null, a.del ? plural(a.del, "exclusão", "exclusões") : null];
          return `${autor}: ${partes.filter(Boolean).join(", ")}`;
        })
        .join("; ");
      linhas.push(`- Marcas de revisão: ${plural(ins, "inserção", "inserções")} e ${plural(del, "exclusão", "exclusões")} de ${plural(porAutor.size, "revisor", "revisores")} (${detalhe})`);
    } else linhas.push("- Marcas de revisão: nenhuma");
    if (temCom) {
      const det = Array.from(porAutorCom.entries())
        .sort(([a], [b]) => a.localeCompare(b, "pt-BR"))
        .map(([a, n]) => `${a}: ${n}`)
        .join("; ");
      linhas.push(`- Comentários: ${d.comentarios.length} (${det})`);
    } else linhas.push("- Comentários: nenhum");
    if (temPh) linhas.push(`- Placeholders no texto aceito: ${Object.entries(placeholders).map(([r, n]) => `${r} ×${n}`).join(", ")}`);
    linhas.push(`- Numeração automática: ${d.temNumeracao ? `sim (${plural(d.niveisNumeracao, "nível", "níveis")})` : "não"}`);
  }
  // --- texto ---
  linhas.push("", "## Texto", "");
  for (const b of d.blocos) {
    if (b.tipo === "tabela") {
      if (b.linhas.length === 0) continue;
      // linha mais curta completada com células vazias: tabela Markdown exige
      // o mesmo número de colunas em toda linha
      const largura = Math.max(...b.linhas.map((l) => l.length));
      const norm = b.linhas.map((l) => [...l, ...Array(largura - l.length).fill("")]);
      linhas.push(`| ${norm[0].map(escaparCelula).join(" | ")} |`);
      linhas.push(`| ${norm[0].map(() => "---").join(" | ")} |`);
      for (const l of norm.slice(1)) linhas.push(`| ${l.map(escaparCelula).join(" | ")} |`);
      linhas.push("");
      continue;
    }
    const corpo = renderSegmentos(b.segmentos);
    linhas.push(b.numero ? `${b.numero} ${corpo}` : corpo, "");
  }
  if (d.comentarios.length) {
    linhas.push("## Comentários", "");
    for (const c of d.comentarios) linhas.push(`[^c${c.id}]: **${c.autor}** (${c.data}): ${c.texto.replace(/\n/g, " ")}`);
    linhas.push("");
  }
  if (d.notas.length) {
    linhas.push("## Notas", "");
    for (const n of d.notas) linhas.push(`[^n${n.id}]: ${n.texto.replace(/\n/g, " ")}`);
    linhas.push("");
  }
  if (d.cabecalhoRodape.length) {
    linhas.push("## Cabeçalho e rodapé", "");
    for (const t of d.cabecalhoRodape) linhas.push(t, "");
  }
  return linhas.join("\n");
}

/**
 * .xlsx -> Markdown: uma seção por aba visível, com tabela cujo cabeçalho é a
 * primeira linha não vazia (linhas vazias iniciais são só margem da planilha).
 * Aba oculta não é renderizada; o leitor já a registrou nos avisos.
 */
export function renderXlsx(d) {
  const linhas = [];
  for (const aba of d.abas) {
    if (aba.oculta) continue;
    linhas.push(`## Aba: ${aba.nome}`, "");
    const inicio = aba.linhas.findIndex((l) => l.some((c) => c !== ""));
    if (inicio < 0) { linhas.push("(aba vazia)", ""); continue; }
    const uteis = aba.linhas.slice(inicio);
    // mesma razão do renderDocx: tabela Markdown exige o mesmo número de colunas em toda linha
    const largura = Math.max(...uteis.map((l) => l.length));
    const norm = uteis.map((l) => [...l, ...Array(largura - l.length).fill("")]);
    linhas.push(`| ${norm[0].map(escaparCelula).join(" | ")} |`);
    linhas.push(`| ${norm[0].map(() => "---").join(" | ")} |`);
    for (const l of norm.slice(1)) linhas.push(`| ${l.map(escaparCelula).join(" | ")} |`);
    linhas.push("");
  }
  return linhas.join("\n");
}
