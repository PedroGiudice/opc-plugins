#!/usr/bin/env node
/**
 * SessionStart hook: digest de handoff do caso (CMR-154).
 *
 * "Desde a sua ultima sessao neste caso": sessoes recentes de OUTRAS origens
 * (maquinas/advogados) gravadas na memoria do caso, com data, origem e tema
 * (trecho mais substantivo da sessao). A marca de "ultima vez" e local por caso
 * (`<caso>/.claude/handoff-state.json`); sem marca, janela de 7 dias.
 *
 * Degrade TOTAL: qualquer falha (sem credencial, 401, timeout, daemon fora)
 * -> `{}` sem output, nunca trava a abertura da sessao. O estado so avanca
 * quando a chamada teve sucesso — falha nao engole janela.
 *
 * Reusa helpers do memoria-context.mjs (hook irmao; import e seguro: o main
 * de la so roda como script).
 */

import {
  mkdirSync, readFileSync, realpathSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  caseSlugFromCwd, contextHeaders, defaultCasesBase, defaultMemApiBase,
  originLabel, readCredentialSafe,
} from "./memoria-context.mjs";

const MEM_API_BASE = process.env.LEGAL_COGMEM_API_BASE || defaultMemApiBase();
const CASES_BASE = process.env.CASE_KNOWLEDGE_CASES_BASE || defaultCasesBase();

const FETCH_TIMEOUT_MS = 4000;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;
const MAX_SESSIONS_SHOWN = 8;
const OPENING_DISPLAY_CHARS = 200;

/**
 * Dias desde a marca local, clamp 1..MAX_DAYS. Sem marca (ou marca invalida
 * ou no futuro): DEFAULT_DAYS.
 */
export function daysSince(lastTs, nowMs = Date.now()) {
  if (typeof lastTs !== "string" || !lastTs) return DEFAULT_DAYS;
  const t = Date.parse(lastTs);
  if (Number.isNaN(t) || t > nowMs) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(1, Math.ceil((nowMs - t) / 86_400_000)));
}

/** Igualdade de path NTFS-insensitive (separador e caixa). */
export function samePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const norm = (p) => p.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Bloco do digest; null quando nao ha sessao de OUTRA origem (silencio — nada
 * de "nenhuma novidade" a cada abertura). Sessoes desta mesma maquina neste
 * caso ficam fora (o operador ja as conhece; /resume cobre).
 */
export function formatDigest(slug, sessions, cwd) {
  const others = (sessions || []).filter((s) => !samePath(s.repo_path, cwd));
  if (others.length === 0) return null;
  const lines = [
    `HANDOFF DO CASO [${slug}]`,
    "=".repeat(16),
    "Sessoes recentes de outras maquinas/advogados neste caso, da mais nova " +
      "para a mais antiga (tema = trecho mais substantivo da sessao). Considere o que " +
      "ja foi feito antes de refazer; detalhes via memoria_search.",
    "",
  ];
  for (const s of others.slice(0, MAX_SESSIONS_SHOWN)) {
    const dia = typeof s.last_ts === "string" ? s.last_ts.slice(0, 10) : "?";
    const quem = originLabel(s.repo_path) ?? "origem desconhecida";
    const tema = String(s.opening ?? "").replace(/\s+/g, " ").trim()
      .slice(0, OPENING_DISPLAY_CHARS);
    lines.push(`- ${dia} ${quem} (${s.turns ?? "?"} turnos): ${tema}`);
  }
  return lines.join("\n");
}

export function statePath(cwd) {
  return join(cwd, ".claude", "handoff-state.json");
}

export function readState(cwd) {
  try {
    return JSON.parse(readFileSync(statePath(cwd), "utf-8"));
  } catch {
    return {};
  }
}

export function writeState(cwd, state) {
  try {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(statePath(cwd), `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    /* estado e otimizacao; falha nao bloqueia */
  }
}

/** POST /api/handoff com timeout; null em qualquer falha. */
export async function fetchHandoff(
  repoPath, days, fetchImpl = fetch, cred = readCredentialSafe(),
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${MEM_API_BASE}/handoff`, {
      method: "POST",
      headers: contextHeaders(cred),
      body: JSON.stringify({ repo_path: repoPath, days }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.status !== "ok") return null;
    return json.sessions ?? [];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function buildHookOutput(context) {
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  };
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
  const rawCwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const physical = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const cwd = physical(rawCwd);
  const slug = caseSlugFromCwd(cwd, physical(CASES_BASE));
  if (!slug) {
    console.log("{}");
    return;
  }
  const state = readState(cwd);
  const days = daysSince(state.last_digest_ts);
  const sessions = await fetchHandoff(cwd, days);
  if (sessions === null) {
    console.log("{}");
    return;
  }
  const digest = formatDigest(slug, sessions, cwd);
  writeState(cwd, { ...state, last_digest_ts: new Date().toISOString() });
  console.log(digest ? JSON.stringify(buildHookOutput(digest)) : "{}");
}

// So roda main quando invocado como script (permite import nos testes).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => console.log("{}"));
}
