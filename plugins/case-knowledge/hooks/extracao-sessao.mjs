#!/usr/bin/env node
/**
 * Hook SessionStart: extrai o texto dos workdocs da pasta da sessão ANTES do
 * primeiro prompt e diz ao Claude o que existe. A primeira resposta do Claude
 * espera este hook (documentação de hooks, conferida em 15/10/2026), então o
 * sumário chega antes de qualquer leitura. Orçamento de 60 s: o que não couber
 * fica para o tick do sync e aparece na segunda lista. Degrada para {} em
 * qualquer falha — nunca quebra o Claude Code.
 *
 * O extrator (../extrair.mjs) entra por import DINÂMICO, só depois de
 * pastaDoCaso decidir que o cwd é pasta de caso: este hook roda em todo
 * SessionStart, de qualquer pasta, e não deve pagar a carga do extrator fora de
 * caso; e dep de pacote por import estático derruba o módulo inteiro quando o
 * node_modules não a tem (teste C1 em sync-cases.test.mjs).
 *
 * Não usa caseSlugFromCwd: o hook roda em QUALQUER pasta dentro de ~/cases
 * (inclusive pasta solta de revisão que não está no manifesto), então a pasta
 * da sessão é decidida só pelo cwd relativo à base.
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { defaultCasesBase } from "./memoria-context.mjs";

const CASES_BASE = process.env.CASE_KNOWLEDGE_CASES_BASE || defaultCasesBase();
export const ORCAMENTO_MS = 60_000;
export const PREFIXO = "[textos-extraidos] ";

const WIN_DRIVE = /^[a-z]:(\/|$)/i;

/** Pasta do caso = <base>/<primeiro componente do cwd relativo à base>; null fora da base ou na raiz. */
export function pastaDoCaso(cwd, base) {
  if (!cwd || !base) return null;
  const norm = (p) => p.replaceAll("\\", "/").replace(/\/+$/, "");
  const c = norm(cwd), b = norm(base);
  // Drive do Windows não distingue caixa; no resto o caminho é case-sensitive.
  const ins = WIN_DRIVE.test(c) && WIN_DRIVE.test(b);
  const cc = ins ? c.toLowerCase() : c, bb = ins ? b.toLowerCase() : b;
  if (cc === bb || !cc.startsWith(bb + "/")) return null;
  const slug = c.slice(b.length + 1).split("/")[0];
  if (!slug || slug.startsWith(".") || slug === "_archive" || slug === "_template" || slug === "scripts") return null;
  const sep = cwd.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}${slug}`;
}

export async function resolverSaidaHook(cwd, base = CASES_BASE, deps = {}) {
  const dir = pastaDoCaso(cwd, base);
  if (!dir) return {};
  try {
    const importar = deps.importar ?? (() => import("../extrair.mjs"));
    const mod = await importar();
    const extrairCaso = deps.extrairCaso ?? mod.extrairCaso;
    const r = await extrairCaso(dir, { orcamentoMs: ORCAMENTO_MS });
    const s = mod.formatarResumo(r);
    if (!s) return {};
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: PREFIXO + s } };
  } catch {
    return {};
  }
}

async function readStdin() {
  const c = [];
  for await (const ch of process.stdin) c.push(ch);
  return Buffer.concat(c).toString("utf-8");
}

// Nada além da linha JSON final pode chegar ao stdout do hook: o Claude Code a
// lê como JSON, e uma linha a mais (uma lib que faz console.debug ao ler um .msg
// com recorrência malformada, p.ex.) invalida a saída inteira. O console fica
// mudo durante todo o hook; a saída final vai direto por process.stdout.
function silenciarConsole() {
  for (const m of ["log", "debug", "info", "warn", "error", "trace", "dir"]) console[m] = () => {};
}

function emitir(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function main() {
  silenciarConsole();
  let input = {};
  try {
    input = JSON.parse(await readStdin());
  } catch {
    /* stdin inválido -> segue com {} */
  }
  const rawCwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  // Canonicaliza symlinks nos DOIS lados (na VM cases/ -> tenants/1/cases);
  // caminho inexistente cai no valor original.
  const physical = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  emitir(await resolverSaidaHook(physical(rawCwd), physical(CASES_BASE)));
}

// pathToFileURL: comparar com `file://${argv[1]}` falha no Windows (drive letter).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => emitir({}));
}
