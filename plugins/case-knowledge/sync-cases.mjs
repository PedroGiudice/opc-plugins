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
import { requestWithAuth } from "./auth.mjs";

// Espelha defaultApiBase/defaultCasesBase do server.mjs. Duplicado de
// proposito: importar server.mjs executaria o server MCP (connect no
// top-level). Se mudar la, mudar aqui.
function defaultApiBase() {
  if (process.platform === "win32") return "https://api.aidvlabs.com/api";
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
export function planActions(manifestCases, localState, baseline = {}) {
  const plan = { mkdir: [], download: [], orphans: [], conflicts: [] };

  // Defesa em profundidade: manifest vazio significa quase certamente erro
  // no servidor (a VM tem 20+ casos ativos), nunca "arquive tudo".
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

    // Reusa o dir local existente quando so a caixa difere (NTFS).
    const localName = localByLower.get(c.name.toLowerCase());
    const local = localName !== undefined ? localState[localName] : undefined;
    const base = (localName !== undefined ? baseline[localName] : undefined) ?? baseline[c.name];
    const targetName = localName ?? c.name;
    if (!local) plan.mkdir.push(c.name);

    const needs = [];
    for (const [file, info] of Object.entries(c.files)) {
      if (!BRIEFING_FILES.includes(file)) continue;
      const localMd5 = local?.[file];
      const baseMd5 = base?.[file];
      if (localMd5 === undefined) {
        needs.push(file); // arquivo novo no cliente
      } else if (localMd5 === info.md5) {
        // ja sincronizado: nada a fazer
      } else if (baseMd5 !== undefined && localMd5 === baseMd5) {
        needs.push(file); // VM mudou, local intocado desde o ultimo download
      } else {
        plan.conflicts.push({ name: targetName, file }); // edicao local -> preserva
      }
    }
    if (needs.length > 0) plan.download.push({ name: targetName, files: needs });
  }

  // Um dir local ausente do manifest so e orfao se o sync ja o trouxe antes
  // (presente no baseline) -> caso removido na VM, limpeza legitima. Um dir que
  // o sync nunca sincronizou (ausente do baseline) e trabalho local do usuario
  // (ex: contrato jogado em ~/cases para revisao): NAO tocar. O espelho mexe so
  // no que e dele.
  const baselineLower = new Set(Object.keys(baseline).map((k) => k.toLowerCase()));
  for (const name of Object.keys(localState)) {
    if (remoteLower.has(name.toLowerCase()) || isExcluded(name)) continue;
    if (baselineLower.has(name.toLowerCase())) plan.orphans.push(name);
  }
  return plan;
}

/**
 * Novo baseline a persistir apos aplicar o plano. Reflete o md5 da VM para
 * arquivos agora sincronizados (baixados com sucesso OU ja iguais a VM);
 * preserva o baseline anterior para conflitos (a versao da VM de quando o
 * usuario editou); remove orfaos (casos ausentes do manifest).
 *
 * succeeded: Set de chaves `${name} ${file}` baixadas com sucesso neste ciclo.
 */
export function computeBaseline(manifestCases, localState, prevBaseline, succeeded) {
  const next = {};
  const localByLower = new Map();
  for (const name of Object.keys(localState)) {
    localByLower.set(name.toLowerCase(), name);
  }

  for (const c of manifestCases) {
    if (!VALID_CASE_NAME.test(c.name) || isExcluded(c.name)) continue;
    const localName = localByLower.get(c.name.toLowerCase()) ?? c.name;
    const local = localState[localName];
    const prev = prevBaseline[localName] ?? prevBaseline[c.name] ?? {};
    const entry = {};
    for (const [file, info] of Object.entries(c.files)) {
      if (!BRIEFING_FILES.includes(file)) continue;
      const key = `${localName} ${file}`;
      if (succeeded.has(key)) {
        entry[file] = info.md5; // baixado -> agora igual a VM
      } else if (local?.[file] === info.md5) {
        entry[file] = info.md5; // ja sincronizado -> adota
      } else if (prev[file] !== undefined) {
        entry[file] = prev[file]; // conflito/falha -> mantem
      }
    }
    if (Object.keys(entry).length > 0) next[localName] = entry;
  }
  return next;
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

const STATE_FILE = ".sync-state.json";

export function readBaselineFrom(casesBase) {
  const p = join(casesBase, STATE_FILE);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {}; // estado corrompido: trata como bootstrap, nao derruba o sync
  }
}

function writeBaseline(casesBase, baseline) {
  const path = join(casesBase, STATE_FILE);
  const tmp = `${path}.sync-tmp`;
  writeFileSync(tmp, JSON.stringify(baseline), "utf-8");
  renameSync(tmp, path);
}

async function fetchJson(url) {
  // Bearer S2S via requestWithAuth: injeta Authorization quando ha credencial
  // (login do plugin), faz refresh em 401, e DEGRADA sem credencial (segue sem
  // Bearer -- preserva o uso atual na tailnet com require_bearer=false). Mesma
  // credencial do MCP (keychain), entao o sync herda o login sem passo extra.
  const res = await requestWithAuth((authHeaders) =>
    fetch(url, { headers: authHeaders, signal: AbortSignal.timeout(10_000) }),
  );
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

  const manifestCases = manifest.cases || [];
  const localState = readLocalState(casesBase);
  const baseline = readBaselineFrom(casesBase);
  const plan = planActions(manifestCases, localState, baseline);
  let updated = 0;
  const errors = [];
  const succeeded = new Set();

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
        // Chave deve usar nome do dir local (plan.download[].name = targetName),
        // igual ao que computeBaseline usa em `${localName} ${file}`. NTFS-safe.
        succeeded.add(`${name} ${f}`);
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

  // Persiste o baseline (md5 da versao da VM por arquivo sincronizado).
  try {
    writeBaseline(casesBase, computeBaseline(manifestCases, localState, baseline, succeeded));
  } catch (err) {
    errors.push(`baseline: ${err.message}`);
  }

  // Loga edicoes locais preservadas (visibilidade para reconciliar a mao).
  for (const { name, file } of plan.conflicts) {
    appendLog(casesBase, `conflito preservado: ${name}/${file} editado localmente diverge da VM (nao sobrescrito)`);
  }

  const summary =
    `${errors.length ? "erro" : "ok"} mkdir=${plan.mkdir.length} ` +
    `arquivos_atualizados=${updated} orfaos_arquivados=${archived} conflitos=${plan.conflicts.length}` +
    (errors.length ? ` ERROS: ${errors.join(" | ")}` : "");
  appendLog(casesBase, summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // ultima linha de defesa: nunca propagar exit != 0 pro scheduler
    try { appendLog(process.env.CASE_KNOWLEDGE_CASES_BASE || defaultCasesBase(), `erro fatal: ${err.message}`); } catch {}
  });
}
