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
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
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
// (`;`, `|`, `<`, `>`) nem curinga. O lookahead recusa `a.docx.md` (leitura do
// sidecar, não extração manual) e extensão maior (`.docxfoo`).
const RE_ARQUIVO =
  /((?:[A-Za-z]:|~)?[\\/][^\s"'`|;<>*?]*?cases[\\/][^"'`|;<>*?\n\r]*?\.(?:docx|docm|xlsx|xlsm|msg|eml))(?![A-Za-z0-9_]|\.md\b)/i;

function textoDeResultado(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((c) => c?.type === "text").map((c) => c.text).join("\n");
  return "";
}

/**
 * Pares {arquivo, comando, resultado}: tool_use Bash/PowerShell cujo comando
 * cita um arquivo suportado sob `cases` + o tool_result de mesmo
 * `tool_use_id` (que pode vir em linha bem posterior). `arquivo` fica como
 * achado no comando (a CLI é quem resolve para um caminho existente).
 * Resultado de erro (`is_error`) não é extração: descarta o par.
 */
export function pararExtracoesManuais(linhas) {
  const pendentes = new Map();
  const pares = [];
  for (const linha of linhas) {
    let obj;
    try { obj = JSON.parse(linha); } catch { continue; }
    const content = obj?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === "tool_use" && (c.name === "Bash" || c.name === "PowerShell")) {
        const cmd = String(c.input?.command ?? "");
        // `\\` -> `\`: caminhos dentro de string Python/JSON no comando vêm com barra dobrada
        const m = RE_ARQUIVO.exec(cmd.replace(/\\\\/g, "\\"));
        if (m) pendentes.set(c.id, { arquivo: m[1], comando: cmd });
      } else if (c?.type === "tool_result" && pendentes.has(c.tool_use_id)) {
        const p = pendentes.get(c.tool_use_id);
        pendentes.delete(c.tool_use_id);
        if (c.is_error) continue;
        pares.push({ ...p, resultado: textoDeResultado(c.content) });
      }
    }
  }
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
async function extrairEmMemoria(abs) {
  const buf = readFileSync(abs);
  switch (tipoDeFormato(abs.replaceAll("\\", "/"))) {
    case "docx": return { md: renderDocx(lerDocx(buf)), bytes: buf.length };
    case "xlsx": return { md: renderXlsx(await lerXlsx(buf)), bytes: buf.length };
    case "eml": return { md: renderEmail(await lerEml(buf)), bytes: buf.length };
    case "msg": return { md: renderEmail(lerMsg(buf)), bytes: buf.length };
    default: return { md: null, bytes: buf.length };
  }
}

const celula = (s) => String(s).replace(/\r?\n/g, " ").replaceAll("|", "\\|");

/**
 * Relatório Markdown. `linhas`: {arquivo, bytes, ms, recall, tokensManuais,
 * faltantes} ou, quando a extração falhou, {arquivo, bytes, ms, erro}.
 */
export function montarRelatorio({ linhas, ausentes }) {
  const out = ["# Benchmark da extração automática", "", "| Arquivo | Bytes | ms | Recall | Tokens manuais | Faltantes (amostra) |", "|---|---:|---:|---:|---:|---|"];
  let abaixo = 0;
  let maior = null;
  for (const l of linhas) {
    if (!maior || l.ms > maior.ms) maior = l;
    const ms = Math.round(l.ms);
    if (l.erro !== undefined) {
      abaixo += 1;
      out.push(`| ${celula(l.arquivo)} | ${l.bytes} | ${ms} | ERRO | | ${celula(l.erro)} |`);
      continue;
    }
    if (l.recall < LIMIAR) abaixo += 1;
    out.push(`| ${celula(l.arquivo)} | ${l.bytes} | ${ms} | ${(l.recall * 100).toFixed(1)}% | ${l.tokensManuais} | ${celula(l.faltantes.slice(0, 20).join(", "))} |`);
  }
  const tempo = maior ? `${Math.round(maior.ms)} ms (${maior.arquivo})` : "n/d";
  out.push("", `Arquivos comparados: ${linhas.length}; abaixo de 99%: ${abaixo}; citados no JSONL mas ausentes no disco: ${ausentes}; maior tempo de extração: ${tempo}.`, "");
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
  if (!projects) {
    console.error("uso: node scripts/benchmark-extracao.mjs --projects <dir dos JSONL> [--cases <pasta de casos>] [--saida <relatorio.md>]");
    process.exit(2);
  }
  // Um arquivo pode aparecer em várias sessões e grafias: chave = caminho resolvido
  // (ou a grafia achada, se ausente). Guarda o resultado manual MAIS LONGO
  // (extrações parciais com head/grep são subconjuntos do completo).
  const porArquivo = new Map();
  for (const f of listarJsonl(projects)) {
    let pares;
    try { pares = pararExtracoesManuais(readFileSync(f, "utf-8").split("\n")); } catch (err) { console.error(`aviso: ${f} ilegível (${err.message})`); continue; }
    for (const p of pares) {
      const abs = resolverCaminho(p.arquivo, { cases });
      const k = (abs ?? p.arquivo).toLowerCase();
      const atual = porArquivo.get(k);
      if (!atual || atual.resultado.length < p.resultado.length) porArquivo.set(k, { ...p, abs });
    }
  }
  const linhas = [];
  let ausentes = 0;
  for (const [, p] of [...porArquivo.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!p.abs) { ausentes += 1; continue; }
    const t0 = performance.now();
    try {
      const { md, bytes } = await extrairEmMemoria(p.abs);
      const ms = performance.now() - t0;
      const r = recall(p.resultado, md ?? "");
      linhas.push({ arquivo: p.abs, bytes, ms, recall: r.recall, tokensManuais: tokens(p.resultado).size, faltantes: r.faltantes });
    } catch (err) {
      linhas.push({ arquivo: p.abs, bytes: 0, ms: performance.now() - t0, erro: err.message });
    }
  }
  writeFileSync(saida, montarRelatorio({ linhas, ausentes }), "utf-8");
  const abaixo = linhas.filter((l) => l.erro !== undefined || l.recall < LIMIAR).length;
  console.log(`relatório em ${saida}: ${linhas.length} comparados, ${abaixo} abaixo de 99%, ${ausentes} ausentes no disco`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
