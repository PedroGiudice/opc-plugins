#!/usr/bin/env node
/**
 * Hook UserPromptSubmit: injeta memoria do caso (legal-cogmem na VM).
 *
 * Porta do cogmem.sh do cogmem de dev, adaptada: gate por pasta de caso
 * (sem rede fora de caso), POST /api/context com timeout curto, degrada
 * gracioso ({} em QUALQUER falha — nunca quebra o Claude Code).
 *
 * Mesmo endpoint default do memoria_search (memoria.mjs); override via
 * LEGAL_COGMEM_API_BASE.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MEM_API_BASE =
  process.env.LEGAL_COGMEM_API_BASE || "http://100.123.73.128:3940/api";
const FETCH_TIMEOUT_MS = 2500;
const MIN_PROMPT_LENGTH = 15;
const DISPLAY_MAX_CHARS = 1500; // truncamento de EXIBICAO (storage e integral)

const TRIVIAL = new Set([
  "ok", "sim", "nao", "não", "yes", "no", "continua", "continue",
  "prossiga", "next", "entendi", "entendido", "perfeito", "otimo",
  "ótimo", "beleza",
]);

/** Base canonica dos casos — mesma env e defaults do detectCase() do
 * server.mjs (CMR-95 item 5). */
export function defaultCasesBase() {
  if (process.platform === "win32")
    return join(process.env.USERPROFILE || "C:\\Users\\pedro", "cases");
  return "/home/opc/case-docs/cases";
}

const CASES_BASE = process.env.CASE_KNOWLEDGE_CASES_BASE || defaultCasesBase();

/**
 * Slug do caso = primeiro componente do cwd RELATIVO a CASES_BASE.
 * Antes aceitava qualquer componente `cases` no path; alinhado ao gate
 * detectCase() do server.mjs — cwd fora da base nao e caso (e nao gera
 * trafego pro daemon). Comparacao string-based com separadores
 * normalizados: roda em Windows (cmr-002) e Unix (VM) sem node:path
 * platform-specific.
 */
export function caseSlugFromCwd(cwd, base = CASES_BASE) {
  if (!cwd || !base) return null;
  const norm = (p) => p.replaceAll("\\", "/").replace(/\/+$/, "");
  const c = norm(cwd);
  const b = norm(base);
  if (c === b || !c.startsWith(b + "/")) return null;
  return c.slice(b.length + 1).split("/")[0] || null;
}

/** Filtros do cogmem.sh: curto, slash command, resposta trivial. */
export function shouldSkipPrompt(prompt) {
  if (!prompt || prompt.length < MIN_PROMPT_LENGTH) return true;
  if (prompt.startsWith("/")) return true;
  const norm = prompt.trim().toLowerCase().replace(/[.!]+$/, "");
  if (TRIVIAL.has(norm)) return true;
  if (/^[0-9]$/.test(norm)) return true;
  return false;
}

/** Bloco de contexto; null se nao ha chunks. */
export function formatContext(slug, chunks) {
  if (!chunks || chunks.length === 0) return null;
  const lines = [`MEMORIA DO CASO [${slug}]`, "=".repeat(16), ""];
  for (const c of chunks) {
    const score = typeof c.score === "number" ? c.score.toFixed(2) : "?";
    const content = String(c.content ?? "").slice(0, DISPLAY_MAX_CHARS);
    lines.push(`[${score}]`, content, "");
  }
  return lines.join("\n");
}

export function buildHookOutput(context) {
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  };
}

/** POST /api/context com timeout; retorna chunks ou null em qualquer falha. */
export async function fetchContext(prompt, repoPath, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${MEM_API_BASE}/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, repo_path: repoPath }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.status !== "ok") return null;
    return json.chunks ?? [];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

async function main() {
  let input = {};
  try {
    input = JSON.parse(await readStdin());
  } catch {
    /* stdin invalido -> segue com {} */
  }
  const prompt = input.userPrompt ?? input.user_prompt ?? input.prompt ?? "";
  const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

  const slug = caseSlugFromCwd(cwd);
  if (!slug || shouldSkipPrompt(prompt)) {
    console.log("{}");
    return;
  }
  const chunks = await fetchContext(prompt, cwd);
  const context = formatContext(slug, chunks ?? []);
  console.log(context ? JSON.stringify(buildHookOutput(context)) : "{}");
}

// So roda main quando invocado como script (permite import nos testes).
// pathToFileURL e obrigatorio: comparacao com `file://${argv[1]}` falha no
// Windows por causa do drive letter (file:///C:/...).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => console.log("{}"));
}
