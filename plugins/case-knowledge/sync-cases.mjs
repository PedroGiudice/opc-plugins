#!/usr/bin/env node
/**
 * Espelho de casos VM -> maquina cliente (cmr-002).
 *
 * Fluxo: GET /cases/sync-manifest -> compara md5 local -> baixa via
 * GET /cases/{name}/briefing so o que mudou -> move orfaos p/ _archive.
 * NUNCA deleta nada; so escreve nos arquivos de briefing.
 *
 * Agendado pelo Task Scheduler (logon + 15 min). Exit 0 sempre —
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

// Espelha defaultApiBase/defaultCasesBase do server.mjs. Duplicado de
// proposito: importar server.mjs executaria o server MCP (connect no
// top-level). Se mudar la, mudar aqui.
function defaultApiBase() {
  if (process.platform === "win32") return "http://100.123.73.128:8422/api";
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
export function planActions(manifestCases, localState) {
  const plan = { mkdir: [], download: [], orphans: [] };

  // Defesa em profundidade: manifest vazio significa quase certamente erro
  // no servidor (a VM tem 20+ casos ativos), nunca "arquive tudo". Se um dia
  // for legitimo (todos os casos arquivados), mover a mao.
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

    // Reusa o dir local existente quando so a caixa difere.
    const localName = localByLower.get(c.name.toLowerCase());
    const local = localName !== undefined ? localState[localName] : undefined;
    if (!local) plan.mkdir.push(c.name);
    const needs = Object.entries(c.files)
      .filter(([file]) => BRIEFING_FILES.includes(file))
      .filter(([file, info]) => !local || local[file] !== info.md5)
      .map(([file]) => file);
    if (needs.length > 0) plan.download.push({ name: localName ?? c.name, files: needs });
  }

  for (const name of Object.keys(localState)) {
    if (!remoteLower.has(name.toLowerCase()) && !isExcluded(name)) plan.orphans.push(name);
  }
  return plan;
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

/** Escrita atomica: tmp + rename (rename sobrescreve no Windows via MoveFileEx). */
function writeAtomic(path, content) {
  const tmp = `${path}.sync-tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
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

async function main() {
  const apiBase = process.env.CASE_KNOWLEDGE_API_BASE || defaultApiBase();
  const casesBase = process.env.CASE_KNOWLEDGE_CASES_BASE || defaultCasesBase();
  mkdirSync(casesBase, { recursive: true });

  let manifest;
  try {
    manifest = await fetchJson(`${apiBase}/cases/sync-manifest`);
  } catch (err) {
    appendLog(casesBase, `erro manifest: ${err.message}`);
    return; // proximo ciclo e o retry
  }

  const plan = planActions(manifest.cases || [], readLocalState(casesBase));
  let updated = 0;
  const errors = [];

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
        updated++;
      }
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
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

  const summary =
    `${errors.length ? "erro" : "ok"} mkdir=${plan.mkdir.length} ` +
    `arquivos_atualizados=${updated} orfaos_arquivados=${archived}` +
    (errors.length ? ` ERROS: ${errors.join(" | ")}` : "");
  appendLog(casesBase, summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // ultima linha de defesa: nunca propagar exit != 0 pro scheduler
    try { appendLog(process.env.CASE_KNOWLEDGE_CASES_BASE || defaultCasesBase(), `erro fatal: ${err.message}`); } catch {}
  });
}
