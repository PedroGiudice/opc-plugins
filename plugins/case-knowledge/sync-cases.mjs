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

/**
 * Decide acoes a partir do manifest remoto e do estado local.
 * localState: { caseName: { fileName: md5hex } } — so dirs nao-excluidos.
 * Retorna { mkdir: [name], download: [{name, files}], orphans: [name] }.
 */
export function planActions(manifestCases, localState) {
  const remoteNames = new Set(manifestCases.map((c) => c.name));
  const plan = { mkdir: [], download: [], orphans: [] };

  // Defesa em profundidade: manifest vazio significa quase certamente erro
  // no servidor (a VM tem 20+ casos ativos), nunca "arquive tudo". Se um dia
  // for legitimo (todos os casos arquivados), mover a mao.
  if (manifestCases.length === 0) return plan;

  for (const c of manifestCases) {
    const local = localState[c.name];
    if (!local) plan.mkdir.push(c.name);
    const needs = Object.entries(c.files)
      .filter(([file, info]) => !local || local[file] !== info.md5)
      .map(([file]) => file);
    if (needs.length > 0) plan.download.push({ name: c.name, files: needs });
  }

  for (const name of Object.keys(localState)) {
    if (!remoteNames.has(name) && !isExcluded(name)) plan.orphans.push(name);
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
