import { test } from "node:test";
import assert from "node:assert/strict";

import {
  defaultApiBase,
  defaultCasesBase,
  SETUP_ENV_VARS,
  resolvePluginDir,
  isSafeScaffoldingPath,
  planScaffoldingWrites,
  psSingleQuote,
  buildSyncTaskCommand,
} from "./setup.mjs";

// --- defaults por plataforma (rodam no SO corrente; asserts condicionais) ---

test("defaultApiBase: publico no Windows, loopback fora", () => {
  if (process.platform === "win32") {
    assert.equal(defaultApiBase(), "https://api.aidvlabs.com/api");
  } else {
    assert.equal(defaultApiBase(), "http://127.0.0.1:8422/api");
  }
});

test("defaultCasesBase: termina em cases", () => {
  assert.match(defaultCasesBase(), /cases$/);
});

test("SETUP_ENV_VARS: as 3 APIs publicas com Bearer", () => {
  assert.deepEqual(SETUP_ENV_VARS, [
    ["CASE_KNOWLEDGE_API_BASE", "https://api.aidvlabs.com/api"],
    ["STJ_VEC_API_BASE", "https://stj.aidvlabs.com/api"],
    ["LEGAL_VEC_API_BASE", "https://legalvec.aidvlabs.com/api"],
  ]);
});

test("resolvePluginDir: sem marketplace clone cai no diretorio do proprio arquivo", () => {
  // homedir inexistente -> fallback = dir deste repo (onde setup.mjs vive).
  const dir = resolvePluginDir("/caminho/que/nao/existe");
  assert.match(dir, /case-knowledge$/);
});

// --- isSafeScaffoldingPath ---

test("isSafeScaffoldingPath: aceita paths reais do scaffolding", () => {
  for (const p of [
    "CLAUDE.md",
    ".claude/settings.json",
    ".claude/rules/leitura-autos.md",
    "_template/case.yaml",
    "scripts/New-Case.ps1",
    "docs/guia-rapido-windows.md",
  ]) {
    assert.equal(isSafeScaffoldingPath(p), true, p);
  }
});

test("isSafeScaffoldingPath: rejeita traversal, absolutos e lixo", () => {
  for (const p of [
    "",
    "../fora",
    "a/../b",
    "a/./b",
    "/etc/passwd",
    "C:/Windows/system32",
    "c:\\x",
    "a\\b",
    "a//b",
    "a/",
    null,
    42,
  ]) {
    assert.equal(isSafeScaffoldingPath(p), false, String(p));
  }
});

// --- planScaffoldingWrites ---

test("planScaffoldingWrites: escreve novos, preserva existentes, rejeita invalidos", () => {
  const files = [
    { path: "CLAUDE.md", content: "novo" },
    { path: ".claude/settings.json", content: "{}" },
    { path: "../escape", content: "mal" },
    { path: "scripts/New-Case.ps1" }, // sem content -> invalido
  ];
  const existing = new Set(["CLAUDE.md"]);
  const plan = planScaffoldingWrites(files, (p) => existing.has(p));
  assert.deepEqual(plan.write.map((f) => f.path), [".claude/settings.json"]);
  assert.deepEqual(plan.skip.map((f) => f.path), ["CLAUDE.md"]);
  assert.deepEqual(plan.invalid, ["../escape", "scripts/New-Case.ps1"]);
});

test("planScaffoldingWrites: lista vazia/ausente -> plano vazio", () => {
  const plan = planScaffoldingWrites(undefined, () => false);
  assert.deepEqual(plan, { write: [], skip: [], invalid: [] });
});

// --- PowerShell: task do espelho ---

test("psSingleQuote: escapa aspas simples dobrando", () => {
  assert.equal(psSingleQuote("O'Neill"), "'O''Neill'");
  assert.equal(psSingleQuote("simples"), "'simples'");
});

test("buildSyncTaskCommand: replica o Install-SyncTask.ps1", () => {
  const cmd = buildSyncTaskCommand("C:\\Users\\x\\sync-cases.mjs");
  // Path embutido como literal single-quoted.
  assert.ok(cmd.includes("$script='C:\\Users\\x\\sync-cases.mjs'"));
  // Truque do Repetition: herdado de um TimeTrigger e Duration='' (indefinido).
  assert.ok(cmd.includes("$logon.Repetition=$timer.Repetition"));
  assert.ok(cmd.includes("$logon.Repetition.Duration=''"));
  assert.ok(cmd.includes("-RepetitionInterval (New-TimeSpan -Minutes 15)"));
  // Idempotencia + registro + primeiro sync.
  assert.ok(cmd.includes("Unregister-ScheduledTask -TaskName 'CaseKnowledge-SyncCases'"));
  assert.ok(cmd.includes("Register-ScheduledTask -TaskName 'CaseKnowledge-SyncCases'"));
  assert.ok(cmd.includes("Start-ScheduledTask -TaskName 'CaseKnowledge-SyncCases'"));
  // Settings do original preservados.
  assert.ok(cmd.includes("-MultipleInstances IgnoreNew"));
  assert.ok(cmd.includes("-ExecutionTimeLimit (New-TimeSpan -Minutes 5)"));
  assert.ok(cmd.includes("-StartWhenAvailable"));
});

test("buildSyncTaskCommand: path com aspas simples nao quebra o literal PS", () => {
  const cmd = buildSyncTaskCommand("C:\\Users\\O'Neill\\sync-cases.mjs");
  assert.ok(cmd.includes("$script='C:\\Users\\O''Neill\\sync-cases.mjs'"));
});
