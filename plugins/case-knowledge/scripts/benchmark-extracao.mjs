#!/usr/bin/env node
/**
 * Benchmark do extrator contra as extrações que o Claude fez À MÃO nas
 * sessões de caso (JSONL do Claude Code da cmr-002). Para cada comando
 * Bash/PowerShell que citou um .docx/.xlsx/.msg/.eml da pasta de casos,
 * compara o texto que a sessão obteve com o que o extrator produz hoje para o
 * mesmo arquivo: recall de tokens (tudo que a extração manual tinha, o
 * resultado do extrator tem?). Roda na máquina onde estão os arquivos; lê os
 * originais e os JSONL, extrai em memória e grava SÓ o relatório (`--saida`):
 * nunca escreve sidecar nem toca nas pastas de caso.
 *
 *   node scripts/benchmark-extracao.mjs --projects <dir dos JSONL> --cases <pasta de casos> --saida <relatorio.md>
 *       [--detalhe <trecho do caminho>]   grava <saida>.<n>.detalhe.md (## Manual / ## Extrator) dos arquivos que casam
 *
 * Só conta extração de texto de verdade (filtrarPares) e a métrica do gate é o
 * Recall(sub), por substring; o Recall por token exato fica como referência.
 */
import { readdirSync, readFileSync, existsSync, writeFileSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { lerDocx } from "../extracao/docx.mjs";
import { lerXlsx } from "../extracao/xlsx.mjs";
import { lerEml, lerMsg } from "../extracao/email.mjs";
import { renderDocx, renderXlsx, renderEmail, tipoDeFormato } from "../extracao.mjs";

const HOME_PADRAO = "C:\\Users\\pedro";
const LIMIAR = 0.99;

// Caminho de arquivo sob uma pasta `cases`, em qualquer grafia que as sessões
// usaram: `C:\Users\...`, `/c/Users/...` (Git Bash), `~/cases/...`. O prefixo
// não aceita espaço (o caminho começa numa palavra do comando); o resto aceita
// (nomes de arquivo têm espaço), mas não atravessa separador de comando
// (`;`, `|`, `&` — logo `&&` e `||` —, `<`, `>`) nem curinga; nome de arquivo
// com `&` é raro e cai fora como o `cd` + caminho
// relativo. O lookahead recusa `a.docx.md` (leitura do sidecar, não extração
// manual) e extensão maior (`.docxfoo`). O último caractere antes da extensão
// não pode ser separador: `cases/x/.docx` (nome vazio, é a pasta) não é arquivo.
const RE_ARQUIVO =
  /((?:[A-Za-z]:|~)?[\\/][^\s"'`|;&<>*?]*?cases[\\/][^"'`|;&<>*?\n\r]*?[^"'`|;&<>*?\n\r\\/]\.(?:docx|docm|xlsx|xlsm|msg|eml))(?![A-Za-z0-9_]|\.md\b)/i;

function textoDeResultado(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((c) => c?.type === "text").map((c) => c.text).join("\n");
  return "";
}

// Máquina de pareamento incremental: alimentada linha a linha (array na versão
// síncrona, stream na assíncrona) com o mesmo comportamento nas duas.
function criarPareador() {
  const pendentes = new Map();
  const pares = [];
  const linha = (texto) => {
    let obj;
    try { obj = JSON.parse(texto); } catch { return; }
    const content = obj?.message?.content;
    if (!Array.isArray(content)) return;
    for (const c of content) {
      if (c?.type === "tool_use" && (c.name === "Bash" || c.name === "PowerShell")) {
        const cmd = String(c.input?.command ?? "");
        // `\\` -> `\`: caminhos dentro de string Python/JSON no comando vêm com barra dobrada
        const m = RE_ARQUIVO.exec(cmd.replace(/\\\\/g, "\\"));
        if (m) pendentes.set(c.id, { arquivo: m[1], comando: cmd, descricao: String(c.input?.description ?? "") });
      } else if (c?.type === "tool_result" && pendentes.has(c.tool_use_id)) {
        const p = pendentes.get(c.tool_use_id);
        pendentes.delete(c.tool_use_id);
        if (c.is_error) continue;
        pares.push({ ...p, resultado: textoDeResultado(c.content) });
      }
    }
  };
  return { linha, pares };
}

/**
 * Pares {arquivo, comando, resultado}: tool_use Bash/PowerShell cujo comando
 * cita um arquivo suportado sob `cases` + o tool_result de mesmo
 * `tool_use_id` (que pode vir em linha bem posterior). `arquivo` fica como
 * achado no comando (a CLI é quem resolve para um caminho existente).
 * Resultado de erro (`is_error`) não é extração: descarta o par.
 * `linhas`: qualquer iterável de linhas JSONL.
 */
export function pararExtracoesManuais(linhas) {
  const { linha, pares } = criarPareador();
  for (const l of linhas) linha(l);
  return pares;
}

/** Igual a `pararExtracoesManuais`, sobre iterável assíncrono (stream de linhas). */
export async function pararExtracoesManuaisStream(linhas) {
  const { linha, pares } = criarPareador();
  for await (const l of linhas) linha(l);
  return pares;
}

export function tokens(texto) {
  const out = new Set();
  for (const m of String(texto).normalize("NFC").toLowerCase().matchAll(/[\p{L}\p{N}]{2,}/gu)) out.add(m[0]);
  return out;
}

export function recall(manual, sidecar) {
  const tm = tokens(manual), ts = tokens(sidecar);
  if (tm.size === 0) return { recall: 1, faltantes: [] };
  const faltantes = [...tm].filter((t) => !ts.has(t));
  return { recall: (tm.size - faltantes.length) / tm.size, faltantes };
}

// Só entra no benchmark o par que é de fato uma extração de texto feita à mão.
// Pela descrição do tool_use (ou o comando, se não houver descrição): precisa
// falar em extrair/ler/imprimir e não em gerar, salvar, listar, comparar etc.
// Pelo resultado: traceback, `ls -la`, EISDIR e afins não são o texto do
// arquivo, e saída curta (< 300 caracteres) é diagnóstico, não extração.
const RE_DESC_INCLUI = /extra[ií]|texto|conte[uú]do|\bler\b|leitura|converter|dump|print/i;
const RE_DESC_EXCLUI = /gerar|salvar|redline|empacot|validar|render|listar|ls\b|compar/i;
const RE_RESULTADO_RUIM = /Traceback|drwxr|EISDIR|Errno|error:/i;
const MIN_RESULTADO = 300;

export function filtrarPares(pares) {
  const mantidos = [];
  let porDescricao = 0, porResultado = 0;
  for (const p of pares) {
    const desc = p.descricao || p.comando;
    if (!RE_DESC_INCLUI.test(desc) || RE_DESC_EXCLUI.test(desc)) { porDescricao += 1; continue; }
    if (RE_RESULTADO_RUIM.test(p.resultado) || p.resultado.trim().length < MIN_RESULTADO) { porResultado += 1; continue; }
    mantidos.push(p);
  }
  return { mantidos, porDescricao, porResultado };
}

/**
 * Recall por substring: o token manual (4+ caracteres) conta como achado se é
 * substring do texto do extrator, limpo como os tokens (minúsculas, NFC,
 * `[\p{L}\p{N}]+` unidos por espaço). Absorve o que o texto manual quebrou ou
 * colou (mojibake, hifenização, "pedro" dentro de "pedrosa"). Só os que não
 * casam por token exato passam pela busca de substring (custo).
 */
export function recallSub(manual, sidecar) {
  const tm = [...tokens(manual)].filter((t) => [...t].length >= 4);
  if (tm.length === 0) return { recall: 1, faltantes: [] };
  const exatos = tokens(sidecar);
  const limpo = [...String(sidecar).normalize("NFC").toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map((m) => m[0]).join(" ");
  const faltantes = tm.filter((t) => !exatos.has(t) && !limpo.includes(t));
  return { recall: (tm.length - faltantes.length) / tm.length, faltantes };
}

/**
 * Caminho existente para a grafia achada no JSONL, ou null. Tenta, em ordem:
 * como está; `/c/Users/...` -> `C:\Users\...`; `~` -> home; o trecho depois de
 * `cases/` sob a pasta de casos informada. `existe` é injetável (teste).
 */
export function resolverCaminho(arquivo, { home = HOME_PADRAO, cases, existe = existsSync } = {}) {
  const candidatos = [arquivo];
  const posix = /^\/([A-Za-z])\/(.*)$/.exec(arquivo);
  if (posix) candidatos.push(`${posix[1].toUpperCase()}:\\${posix[2].replaceAll("/", "\\")}`);
  if (arquivo.startsWith("~")) {
    const resto = arquivo.slice(1);
    candidatos.push(home + (home.includes("\\") ? resto.replaceAll("/", "\\") : resto));
  }
  const tail = /cases[\\/](.*)$/i.exec(arquivo);
  if (cases && tail) candidatos.push(join(cases, ...tail[1].split(/[\\/]/)));
  return candidatos.find((p) => existe(p)) ?? null;
}

// Extrai em memória (sem sidecar). Devolve o Markdown que o extrator geraria.
// Arquivo que o leitor não abre vira erro, como no extrator (que não grava
// sidecar dele): renderizar a estrutura vazia daria recall 0 sem dizer por quê.
async function extrairEmMemoria(abs) {
  const buf = readFileSync(abs);
  const lido = (d) => {
    if (d.ilegivel) throw new Error(`não foi possível ler: ${d.motivo}`);
    return d;
  };
  switch (tipoDeFormato(abs.replaceAll("\\", "/"))) {
    case "docx": return { md: renderDocx(lido(lerDocx(buf))), bytes: buf.length };
    case "xlsx": return { md: renderXlsx(lido(await lerXlsx(buf))), bytes: buf.length };
    case "eml": return { md: renderEmail(await lerEml(buf)), bytes: buf.length };
    case "msg": return { md: renderEmail(lido(lerMsg(buf))), bytes: buf.length };
    default: return { md: null, bytes: buf.length };
  }
}

// Identidade de um caminho para deduplicar: mesma máquina, grafias diferentes
// (`/c/Users/..`, `C:\Users\..`, `~/..`) viram a mesma chave.
function chaveDeCaminho(arquivo, home = HOME_PADRAO) {
  let p = arquivo;
  const posix = /^\/([A-Za-z])\/(.*)$/.exec(p);
  if (posix) p = `${posix[1]}:/${posix[2]}`;
  else if (p.startsWith("~")) p = home + p.slice(1);
  return p.replaceAll("\\", "/").toLowerCase();
}

const celula = (s) => String(s).replace(/\r?\n/g, " ").replaceAll("|", "\\|");

/**
 * Relatório Markdown. `linhas`: {arquivo, bytes, ms, recall, recallSub,
 * tokensManuais, faltantes} ou, quando a extração falhou, {arquivo, bytes, ms,
 * erro}. `faltantes` são os do Recall(sub), a métrica do gate. `descartados`:
 * {porDescricao, porResultado} da filtragem de pares.
 */
export function montarRelatorio({ linhas, ausentes, descartados = {} }) {
  const out = ["# Benchmark da extração automática", "", "| Arquivo | Bytes | ms | Recall | Recall(sub) | Tokens manuais | Faltantes (amostra) |", "|---|---:|---:|---:|---:|---:|---|"];
  let abaixo = 0;
  let maior = null;
  for (const l of linhas) {
    if (!maior || l.ms > maior.ms) maior = l;
    const ms = Math.round(l.ms);
    if (l.erro !== undefined) {
      abaixo += 1;
      out.push(`| ${celula(l.arquivo)} | ${l.bytes} | ${ms} | ERRO | | | ${celula(l.erro)} |`);
      continue;
    }
    if (l.recallSub < LIMIAR) abaixo += 1;
    out.push(`| ${celula(l.arquivo)} | ${l.bytes} | ${ms} | ${(l.recall * 100).toFixed(1)}% | ${(l.recallSub * 100).toFixed(1)}% | ${l.tokensManuais} | ${celula(l.faltantes.slice(0, 20).join(", "))} |`);
  }
  const tempo = maior ? `${Math.round(maior.ms)} ms (${maior.arquivo})` : "n/d";
  out.push("", `Arquivos comparados: ${linhas.length}; abaixo de 99%: ${abaixo}; citados no JSONL mas ausentes no disco: ${ausentes}; maior tempo de extração: ${tempo}; descartados: ${descartados.porDescricao ?? 0} por descrição, ${descartados.porResultado ?? 0} por resultado.`, "");
  return out.join("\n");
}

function listarJsonl(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const projects = val("--projects"), cases = val("--cases"), saida = val("--saida") ?? "benchmark-extracao.md";
  const detalhe = val("--detalhe");
  if (!projects) {
    console.error("uso: node scripts/benchmark-extracao.mjs --projects <dir dos JSONL> [--cases <pasta de casos>] [--saida <relatorio.md>] [--detalhe <trecho do caminho>]");
    process.exit(2);
  }
  // Um arquivo pode aparecer em várias sessões e grafias: chave = identidade
  // normalizada do caminho (resolvido, ou o achado se ausente; vale também
  // para a contagem de ausentes). Guarda o resultado manual MAIS LONGO
  // (extrações parciais com head/grep são subconjuntos do completo).
  const porArquivo = new Map();
  const descartados = { porDescricao: 0, porResultado: 0 };
  for (const f of listarJsonl(projects)) {
    let pares;
    // em stream: sessões chegam a centenas de MB e o diretório a GB
    try { pares = await pararExtracoesManuaisStream(createInterface({ input: createReadStream(f, { encoding: "utf-8" }), crlfDelay: Infinity })); } catch (err) { console.error(`aviso: ${f} ilegível (${err.message})`); continue; }
    const filtro = filtrarPares(pares);
    descartados.porDescricao += filtro.porDescricao;
    descartados.porResultado += filtro.porResultado;
    for (const p of filtro.mantidos) {
      const abs = resolverCaminho(p.arquivo, { cases });
      const k = chaveDeCaminho(abs ?? p.arquivo);
      const atual = porArquivo.get(k);
      if (!atual || atual.resultado.length < p.resultado.length) porArquivo.set(k, { ...p, abs });
    }
  }
  const linhas = [];
  let ausentes = 0;
  let nDetalhe = 0;
  const alvo = detalhe ? detalhe.replaceAll("\\", "/").toLowerCase() : null;
  // `--detalhe`: manual e extrator lado a lado (um depois do outro) para diff a olho
  const gravarDetalhe = (p, extrator) => {
    if (!alvo || !p.abs.replaceAll("\\", "/").toLowerCase().includes(alvo)) return;
    nDetalhe += 1;
    writeFileSync(`${saida}.${nDetalhe}.detalhe.md`, `# ${p.abs}\n\n## Manual\n\n${p.resultado}\n\n## Extrator\n\n${extrator}\n`, "utf-8");
  };
  for (const [, p] of [...porArquivo.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!p.abs) { ausentes += 1; continue; }
    const t0 = performance.now();
    try {
      const { md, bytes } = await extrairEmMemoria(p.abs);
      const ms = performance.now() - t0;
      const r = recall(p.resultado, md ?? "");
      const rs = recallSub(p.resultado, md ?? "");
      linhas.push({ arquivo: p.abs, bytes, ms, recall: r.recall, recallSub: rs.recall, tokensManuais: tokens(p.resultado).size, faltantes: rs.faltantes });
      gravarDetalhe(p, md ?? "");
    } catch (err) {
      linhas.push({ arquivo: p.abs, bytes: 0, ms: performance.now() - t0, erro: err.message });
      gravarDetalhe(p, `(erro na extração: ${err.message})`);
    }
  }
  writeFileSync(saida, montarRelatorio({ linhas, ausentes, descartados }), "utf-8");
  const abaixo = linhas.filter((l) => l.erro !== undefined || l.recallSub < LIMIAR).length;
  console.log(`relatório em ${saida}: ${linhas.length} comparados, ${abaixo} abaixo de 99%, ${ausentes} ausentes no disco, descartados ${descartados.porDescricao} por descrição e ${descartados.porResultado} por resultado`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
