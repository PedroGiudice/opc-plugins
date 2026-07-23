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
  buildGlobalSettings,
  DEFAULT_OUTPUT_STYLE,
  applyGlobalOutputStyle,
  ensureFeedbackImport,
  FEEDBACK_IMPORT_LINE,
} from "./setup.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
  // Action via wscript + vbs (execucao sem janela de console).
  assert.ok(cmd.includes("sync-cases-hidden.vbs"));
  assert.ok(cmd.includes("wscript.exe"));
  // Dois triggers: AtLogOn + TimeTrigger que arma no REGISTRO (nao depende
  // de logon — um re-registro sem relogon deixava o sync morto, CMR-126).
  assert.ok(cmd.includes("-Trigger @($logon,$timer)"));
  assert.ok(cmd.includes("$logon.Repetition.Duration=''"));
  assert.ok(cmd.includes("$timer.Repetition.Duration=''"));
  // Intervalo de 5 min nos dois triggers, indefinido.
  assert.equal(
    (cmd.match(/-RepetitionInterval \(New-TimeSpan -Minutes 5\)/g) || []).length,
    2,
  );
  assert.ok(!cmd.includes("-Minutes 15"));
  // Idempotencia + registro + primeiro sync.
  assert.ok(cmd.includes("Unregister-ScheduledTask -TaskName 'CaseKnowledge-SyncCases'"));
  assert.ok(cmd.includes("Register-ScheduledTask -TaskName 'CaseKnowledge-SyncCases'"));
  assert.ok(cmd.includes("Start-ScheduledTask -TaskName 'CaseKnowledge-SyncCases'"));
  // Settings do original preservados.
  assert.ok(cmd.includes("-MultipleInstances IgnoreNew"));
  assert.ok(cmd.includes("-ExecutionTimeLimit (New-TimeSpan -Minutes 5)"));
  assert.ok(cmd.includes("-StartWhenAvailable"));
});

test("sync-cases-hidden.vbs: versionado no plugin, roda oculto e espera", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const vbs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "sync-cases-hidden.vbs"),
    "utf8",
  );
  // intWindowStyle=0 (oculto) e bWaitOnReturn=True (preserva
  // ExecutionTimeLimit/MultipleInstances da task para o sync real).
  assert.match(vbs, /\.Run\(cmd, 0, True\)/);
  // Propaga o exit code do node para LastTaskResult.
  assert.match(vbs, /WScript\.Quit sh\.Run/);
});

test("buildSyncTaskCommand: path com aspas simples nao quebra o literal PS", () => {
  const cmd = buildSyncTaskCommand("C:\\Users\\O'Neill\\sync-cases.mjs");
  assert.ok(cmd.includes("$script='C:\\Users\\O''Neill\\sync-cases.mjs'"));
});

// --- buildGlobalSettings: output style default no settings.json GLOBAL ---

test("buildGlobalSettings: sem arquivo previo -> cria com outputStyle", () => {
  for (const raw of [null, "", "   "]) {
    const out = buildGlobalSettings(raw);
    assert.ok(out, String(raw));
    assert.equal(out.changed, true);
    assert.deepEqual(JSON.parse(out.json), { outputStyle: DEFAULT_OUTPUT_STYLE });
  }
});

test("buildGlobalSettings: merge preserva as demais chaves do usuario", () => {
  const raw = JSON.stringify({ model: "opus", theme: "dark-ansi", permissions: { defaultMode: "default" } });
  const out = buildGlobalSettings(raw);
  assert.equal(out.changed, true);
  const parsed = JSON.parse(out.json);
  assert.equal(parsed.outputStyle, DEFAULT_OUTPUT_STYLE);
  assert.equal(parsed.model, "opus");
  assert.equal(parsed.theme, "dark-ansi");
  assert.deepEqual(parsed.permissions, { defaultMode: "default" });
});

test("buildGlobalSettings: outputStyle divergente e sobrescrito", () => {
  const out = buildGlobalSettings(JSON.stringify({ outputStyle: "Explanatory", model: "opus" }));
  assert.equal(out.changed, true);
  const parsed = JSON.parse(out.json);
  assert.equal(parsed.outputStyle, DEFAULT_OUTPUT_STYLE);
  assert.equal(parsed.model, "opus");
});

test("buildGlobalSettings: idempotente (ja setado -> changed=false)", () => {
  const out = buildGlobalSettings(JSON.stringify({ outputStyle: DEFAULT_OUTPUT_STYLE, model: "opus" }));
  assert.equal(out.changed, false);
  assert.equal(JSON.parse(out.json).outputStyle, DEFAULT_OUTPUT_STYLE);
});

test("buildGlobalSettings: JSON invalido/array/null -> null (nao pisa em config)", () => {
  for (const raw of ["{nao json", "[1,2,3]", "null", "\"str\"", "42"]) {
    assert.equal(buildGlobalSettings(raw), null, raw);
  }
});

// --- applyGlobalOutputStyle: integridade em disco real (tmpdir) ---

function withTmpHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "ck-setup-"));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("applyGlobalOutputStyle: settings valido -> merge, backup e SEM sobra de tmp", () => {
  withTmpHome((home) => {
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "settings.json");
    const original = JSON.stringify({ model: "opus", theme: "dark-ansi" }, null, 2) + "\n";
    writeFileSync(target, original, "utf-8");

    const failures = [];
    applyGlobalOutputStyle(failures, home);

    assert.deepEqual(failures, []);
    const parsed = JSON.parse(readFileSync(target, "utf-8"));
    assert.equal(parsed.outputStyle, DEFAULT_OUTPUT_STYLE);
    assert.equal(parsed.model, "opus");
    assert.equal(parsed.theme, "dark-ansi");
    // backup do estado anterior, byte-a-byte
    assert.equal(readFileSync(`${target}.bak`, "utf-8"), original);
    // nenhum tmp orfao (rename consumiu)
    assert.equal(existsSync(`${target}.setup-tmp`), false);
  });
});

test("applyGlobalOutputStyle: sem arquivo previo -> cria, sem backup", () => {
  withTmpHome((home) => {
    const failures = [];
    applyGlobalOutputStyle(failures, home);
    const target = join(home, ".claude", "settings.json");
    assert.deepEqual(failures, []);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf-8")), { outputStyle: DEFAULT_OUTPUT_STYLE });
    assert.equal(existsSync(`${target}.bak`), false);
  });
});

test("applyGlobalOutputStyle: JSON invalido -> NAO altera o arquivo, vira pendencia", () => {
  withTmpHome((home) => {
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "settings.json");
    const corrupto = '{ "model": "opus"  <<< quebrado';
    writeFileSync(target, corrupto, "utf-8");

    const failures = [];
    applyGlobalOutputStyle(failures, home);

    // arquivo intocado byte-a-byte + pendencia reportada
    assert.equal(readFileSync(target, "utf-8"), corrupto);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /JSON invalido/);
  });
});

test("applyGlobalOutputStyle: idempotente (ja setado -> nao reescreve, sem backup novo)", () => {
  withTmpHome((home) => {
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "settings.json");
    writeFileSync(target, JSON.stringify({ outputStyle: DEFAULT_OUTPUT_STYLE, model: "opus" }), "utf-8");

    const failures = [];
    applyGlobalOutputStyle(failures, home);

    assert.deepEqual(failures, []);
    assert.equal(existsSync(`${target}.bak`), false); // no-op nao gera backup
    assert.equal(JSON.parse(readFileSync(target, "utf-8")).outputStyle, DEFAULT_OUTPUT_STYLE);
  });
});

// --- ensureFeedbackImport: @import do feedback no ~/.claude/CLAUDE.md (CMR-138) ---

import { readdirSync, statSync } from "node:fs";

function countOccurrences(content, line) {
  return content.split(/\r?\n/).filter((l) => l.trim() === line).length;
}

test("ensureFeedbackImport: cria o CLAUDE.md ausente com header minimo + a linha", () => {
  withTmpHome((home) => {
    const r = ensureFeedbackImport(home);
    assert.equal(r.changed, true);
    assert.equal(r.error, undefined);
    const target = join(home, ".claude", "CLAUDE.md");
    const content = readFileSync(target, "utf-8");
    assert.equal(countOccurrences(content, FEEDBACK_IMPORT_LINE), 1);
    assert.ok(content.length > FEEDBACK_IMPORT_LINE.length, "tem header minimo alem da linha");
    // sem tmp orfao
    assert.equal(existsSync(`${target}.setup-tmp`), false);
  });
});

test("ensureFeedbackImport: idempotente (roda 2x -> a linha aparece uma unica vez)", () => {
  withTmpHome((home) => {
    const first = ensureFeedbackImport(home);
    const second = ensureFeedbackImport(home);
    assert.equal(first.changed, true);
    assert.equal(second.changed, false); // 2a passada nao altera
    const target = join(home, ".claude", "CLAUDE.md");
    const content = readFileSync(target, "utf-8");
    assert.equal(countOccurrences(content, FEEDBACK_IMPORT_LINE), 1);
    // no-op nao deixa backup
    const baks = readdirSync(join(home, ".claude")).filter((f) => f.startsWith("CLAUDE.md.bak-"));
    assert.equal(baks.length, 0);
  });
});

test("ensureFeedbackImport: arquivo existente SEM a linha -> append preserva conteudo + backup", () => {
  withTmpHome((home) => {
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "CLAUDE.md");
    const original = "# Minhas instrucoes\n\nRegra pessoal importante.\n";
    writeFileSync(target, original, "utf-8");

    const r = ensureFeedbackImport(home);
    assert.equal(r.changed, true);
    const content = readFileSync(target, "utf-8");
    // conteudo original inteiro preservado no inicio
    assert.ok(content.startsWith(original), "preserva o conteudo original");
    // a linha foi anexada exatamente uma vez, com linha em branco separando
    assert.equal(countOccurrences(content, FEEDBACK_IMPORT_LINE), 1);
    assert.match(content, /Regra pessoal importante\.\n\n@~\/cases\/\.feedback\/FEEDBACK\.md\n$/);
    // backup .bak-<ts> do estado anterior, byte-a-byte
    const baks = readdirSync(dir).filter((f) => f.startsWith("CLAUDE.md.bak-"));
    assert.equal(baks.length, 1);
    assert.equal(readFileSync(join(dir, baks[0]), "utf-8"), original);
    // sem tmp orfao
    assert.equal(existsSync(`${target}.setup-tmp`), false);
  });
});

test("ensureFeedbackImport: ja contem a linha (em qualquer posicao) -> no-op, sem backup", () => {
  withTmpHome((home) => {
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "CLAUDE.md");
    const original = `# Topo\n\n${FEEDBACK_IMPORT_LINE}\n\nmais texto\n`;
    writeFileSync(target, original, "utf-8");
    const before = statSync(target).mtimeMs;

    const r = ensureFeedbackImport(home);
    assert.equal(r.changed, false);
    assert.equal(readFileSync(target, "utf-8"), original); // intocado
    assert.equal(statSync(target).mtimeMs, before);
    const baks = readdirSync(dir).filter((f) => f.startsWith("CLAUDE.md.bak-"));
    assert.equal(baks.length, 0);
  });
});

// --- autoUpdate do marketplace opc-plugins (CMR-143) ---

test("mergeMarketplaceAutoUpdate: null para raw ausente/vazio/invalido/nao-objeto", async () => {
  const { mergeMarketplaceAutoUpdate } = await import("./setup.mjs");
  assert.equal(mergeMarketplaceAutoUpdate(null), null);
  assert.equal(mergeMarketplaceAutoUpdate("   "), null);
  assert.equal(mergeMarketplaceAutoUpdate("{nao-json"), null);
  assert.equal(mergeMarketplaceAutoUpdate("[]"), null);
  assert.equal(mergeMarketplaceAutoUpdate('"str"'), null);
});

test("mergeMarketplaceAutoUpdate: null sem a entrada opc-plugins ou entrada nao-objeto", async () => {
  const { mergeMarketplaceAutoUpdate } = await import("./setup.mjs");
  assert.equal(mergeMarketplaceAutoUpdate("{}"), null);
  assert.equal(mergeMarketplaceAutoUpdate('{"outro": {}}'), null);
  assert.equal(mergeMarketplaceAutoUpdate('{"opc-plugins": "str"}'), null);
});

test("mergeMarketplaceAutoUpdate: seta true preservando o resto; changed distingue no-op", async () => {
  const { mergeMarketplaceAutoUpdate } = await import("./setup.mjs");
  const raw = JSON.stringify({
    "claude-plugins-official": { source: { source: "github", repo: "anthropics/claude-plugins-official" } },
    "opc-plugins": {
      source: { source: "github", repo: "PedroGiudice/opc-plugins" },
      installLocation: "/x/marketplaces/opc-plugins",
      lastUpdated: "2026-07-23T00:00:00.000Z",
    },
  });
  const r = mergeMarketplaceAutoUpdate(raw);
  assert.ok(r && r.changed === true);
  const obj = JSON.parse(r.json);
  assert.equal(obj["opc-plugins"].autoUpdate, true);
  assert.equal(obj["opc-plugins"].installLocation, "/x/marketplaces/opc-plugins");
  assert.deepEqual(obj["claude-plugins-official"], {
    source: { source: "github", repo: "anthropics/claude-plugins-official" },
  });

  // false -> true e changed
  const r2 = mergeMarketplaceAutoUpdate(JSON.stringify({ "opc-plugins": { autoUpdate: false } }));
  assert.ok(r2 && r2.changed === true && JSON.parse(r2.json)["opc-plugins"].autoUpdate === true);

  // ja true -> changed false
  const r3 = mergeMarketplaceAutoUpdate(JSON.stringify({ "opc-plugins": { autoUpdate: true } }));
  assert.ok(r3 && r3.changed === false);
});

test("applyMarketplaceAutoUpdate: aplica em disco; ausencia vira pendencia sem criar arquivo", async () => {
  const { applyMarketplaceAutoUpdate } = await import("./setup.mjs");
  const home = mkdtempSync(join(tmpdir(), "setup-autoupd-"));
  const dir = join(home, ".claude", "plugins");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "known_marketplaces.json");

  // ausente -> pendencia, arquivo nao criado
  const f1 = [];
  applyMarketplaceAutoUpdate(f1, home);
  assert.equal(f1.length, 1);
  assert.equal(existsSync(target), false);

  // presente -> aplica e nao gera pendencia
  writeFileSync(target, JSON.stringify({ "opc-plugins": { source: {} } }), "utf-8");
  const f2 = [];
  applyMarketplaceAutoUpdate(f2, home);
  assert.deepEqual(f2, []);
  assert.equal(JSON.parse(readFileSync(target, "utf-8"))["opc-plugins"].autoUpdate, true);

  // idempotente
  const f3 = [];
  applyMarketplaceAutoUpdate(f3, home);
  assert.deepEqual(f3, []);
  rmSync(home, { recursive: true, force: true });
});
