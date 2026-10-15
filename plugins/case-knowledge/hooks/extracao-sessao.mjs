#!/usr/bin/env node
/**
 * Hook SessionStart: extrai o texto dos workdocs da pasta da sessão ANTES do
 * primeiro prompt e diz ao Claude o que existe. A primeira resposta do Claude
 * espera este hook (documentação de hooks, conferida em 15/10/2026), então o
 * sumário chega antes de qualquer leitura. Orçamento de 60 s: o que não couber
 * fica para o tick do sync e aparece na segunda lista. Degrada para {} em
 * qualquer falha — nunca quebra o Claude Code.
 *
 * Não usa caseSlugFromCwd: o hook roda em QUALQUER pasta dentro de ~/cases
 * (inclusive pasta solta de revisão que não está no manifesto), então a pasta
 * da sessão é decidida só pelo cwd relativo à base.
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { extrairCaso as extrairCasoReal, formatarResumo } from "../extrair.mjs";
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

export async function resolverSaidaHook(cwd, base = CASES_BASE, { extrairCaso = extrairCasoReal } = {}) {
  const dir = pastaDoCaso(cwd, base);
  if (!dir) return {};
  try {
    const r = await extrairCaso(dir, { orcamentoMs: ORCAMENTO_MS });
    const s = formatarResumo(r);
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

async function main() {
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
  console.log(JSON.stringify(await resolverSaidaHook(physical(rawCwd), physical(CASES_BASE))));
}

// pathToFileURL: comparar com `file://${argv[1]}` falha no Windows (drive letter).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => console.log("{}"));
}
