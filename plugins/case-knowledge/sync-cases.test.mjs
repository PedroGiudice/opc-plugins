import { test } from "node:test";
import assert from "node:assert/strict";
import { planActions, computeBaseline, isExcluded, archiveTarget } from "./sync-cases.mjs";

test("caso novo: mkdir + download de todos os arquivos do manifest", () => {
  const manifest = [
    { name: "alpha", status: "active", files: { "CLAUDE.md": { md5: "aa" }, "case.yaml": { md5: "bb" } } },
  ];
  const plan = planActions(manifest, {});
  assert.deepEqual(plan.mkdir, ["alpha"]);
  assert.deepEqual(plan.download, [{ name: "alpha", files: ["CLAUDE.md", "case.yaml"] }]);
  assert.deepEqual(plan.orphans, []);
});

test("md5 igual: nenhuma acao", () => {
  const manifest = [
    { name: "alpha", status: "active", files: { "CLAUDE.md": { md5: "aa" } } },
  ];
  const local = { alpha: { "CLAUDE.md": "aa" } };
  const plan = planActions(manifest, local);
  assert.deepEqual(plan.mkdir, []);
  assert.deepEqual(plan.download, []);
});

test("VM atualizou (local == baseline): baixa so o arquivo que mudou", () => {
  const manifest = [
    { name: "alpha", status: "active", files: { "CLAUDE.md": { md5: "aa" }, "case.yaml": { md5: "NEW" } } },
  ];
  const local = { alpha: { "CLAUDE.md": "aa", "case.yaml": "OLD" } };
  const baseline = { alpha: { "CLAUDE.md": "aa", "case.yaml": "OLD" } };
  const plan = planActions(manifest, local, baseline);
  assert.deepEqual(plan.download, [{ name: "alpha", files: ["case.yaml"] }]);
  assert.deepEqual(plan.conflicts, []);
});

test("usuario editou local (local != baseline): preserva, vira conflito, nao baixa", () => {
  const manifest = [
    { name: "alpha", status: "active", files: { "CLAUDE.md": { md5: "VM" } } },
  ];
  const local = { alpha: { "CLAUDE.md": "EDITADO" } };
  const baseline = { alpha: { "CLAUDE.md": "BAIXADO_ANTES" } };
  const plan = planActions(manifest, local, baseline);
  assert.deepEqual(plan.download, []);
  assert.deepEqual(plan.conflicts, [{ name: "alpha", file: "CLAUDE.md" }]);
});

test("bootstrap (sem baseline) + divergencia: conflito conservador, nao destroi local", () => {
  const manifest = [
    { name: "alpha", status: "active", files: { "CLAUDE.md": { md5: "VM" } } },
  ];
  const local = { alpha: { "CLAUDE.md": "LOCAL" } };
  const plan = planActions(manifest, local, {});
  assert.deepEqual(plan.download, []);
  assert.deepEqual(plan.conflicts, [{ name: "alpha", file: "CLAUDE.md" }]);
});

test("arquivo local extra (trabalho do advogado) e invisivel ao plano", () => {
  const manifest = [
    { name: "alpha", status: "active", files: { "CLAUDE.md": { md5: "aa" } } },
  ];
  const local = { alpha: { "CLAUDE.md": "aa", "minha-peca.md": "zz" } };
  const plan = planActions(manifest, local);
  assert.deepEqual(plan.download, []);
});

test("orfao detectado (estava no baseline = sincronizado, sumiu da VM); exclusoes nunca viram orfao", () => {
  const manifest = [{ name: "alpha", status: "active", files: {} }];
  const local = { alpha: {}, morto: {}, _archive: {}, _template: {}, scripts: {}, ".claude": {} };
  const baseline = { morto: { "CLAUDE.md": "x" } }; // morto foi sincronizado antes
  const plan = planActions(manifest, local, baseline);
  assert.deepEqual(plan.orphans, ["morto"]);
});

test("pasta criada localmente (ausente do baseline) NUNCA vira orfao", () => {
  const manifest = [{ name: "alpha", status: "active", files: {} }];
  const local = { alpha: {}, "glenmark-rd-incineracao": {} };
  const baseline = { alpha: { "CLAUDE.md": "x" } }; // alpha sincronizado; glenmark nunca
  const plan = planActions(manifest, local, baseline);
  assert.deepEqual(plan.orphans, []);
});

test("manifest vazio NUNCA gera orfaos (defesa contra bug/erro servidor)", () => {
  const plan = planActions([], { alpha: {}, beta: {} });
  assert.deepEqual(plan.orphans, []);
  assert.deepEqual(plan.mkdir, []);
});

test("isExcluded cobre dotfiles e pastas reservadas", () => {
  for (const n of ["_archive", "_template", "scripts", ".claude", ".sync.log", ".sync-state.json"]) {
    assert.ok(isExcluded(n), n);
  }
  assert.ok(!isExcluded("bianka-salesforce"));
});

test("manifest com arquivo fora de BRIEFING_FILES e ignorado", () => {
  const manifest = [
    { name: "alpha", status: "active", files: { "CLAUDE.md": { md5: "aa" }, "..\\evil.exe": { md5: "xx" }, "outro.txt": { md5: "yy" } } },
  ];
  const plan = planActions(manifest, { alpha: { "CLAUDE.md": "aa" } });
  assert.deepEqual(plan.download, []);
});

test("name remoto com path separator ou reservado (scripts/_archive) e ignorado", () => {
  const manifest = [
    { name: "../etc", status: "active", files: { "CLAUDE.md": { md5: "aa" } } },
    { name: "a/b", status: "active", files: { "CLAUDE.md": { md5: "aa" } } },
    { name: "a\\b", status: "active", files: { "CLAUDE.md": { md5: "aa" } } },
    { name: ".oculto", status: "active", files: { "CLAUDE.md": { md5: "aa" } } },
    { name: "scripts", status: "active", files: { "CLAUDE.md": { md5: "aa" } } },
    { name: "_archive", status: "active", files: { "CLAUDE.md": { md5: "aa" } } },
    { name: "valido", status: "active", files: { "CLAUDE.md": { md5: "aa" } } },
  ];
  const plan = planActions(manifest, {});
  assert.deepEqual(plan.mkdir, ["valido"]);
  assert.deepEqual(plan.download, [{ name: "valido", files: ["CLAUDE.md"] }]);
});

test("caixa divergente (NTFS): casa com dir local existente, nunca orfao", () => {
  const manifest = [
    { name: "Alpha", status: "active", files: { "CLAUDE.md": { md5: "NEW" } } },
  ];
  const local = { alpha: { "CLAUDE.md": "OLD" } };
  const baseline = { alpha: { "CLAUDE.md": "OLD" } };
  const plan = planActions(manifest, local, baseline);
  assert.deepEqual(plan.mkdir, []);
  assert.deepEqual(plan.download, [{ name: "alpha", files: ["CLAUDE.md"] }]);
  assert.deepEqual(plan.orphans, []);
});

test("archiveTarget sufixa com data em colisao", () => {
  const taken = new Set(["morto"]);
  assert.equal(archiveTarget("livre", taken), "livre");
  assert.match(archiveTarget("morto", taken), /^morto-\d{8}$/);
});

test("computeBaseline: arquivo baixado vira md5 da VM", () => {
  const manifest = [{ name: "alpha", status: "active", files: { "CLAUDE.md": { md5: "VM" } } }];
  const local = { alpha: { "CLAUDE.md": "OLD" } };
  const succeeded = new Set(["alpha CLAUDE.md"]);
  const next = computeBaseline(manifest, local, {}, succeeded);
  assert.deepEqual(next, { alpha: { "CLAUDE.md": "VM" } });
});

test("computeBaseline: arquivo ja sincronizado (local==vm) adota o md5 da VM", () => {
  const manifest = [{ name: "alpha", status: "active", files: { "CLAUDE.md": { md5: "VM" } } }];
  const local = { alpha: { "CLAUDE.md": "VM" } };
  const next = computeBaseline(manifest, local, {}, new Set());
  assert.deepEqual(next, { alpha: { "CLAUDE.md": "VM" } });
});

test("computeBaseline: conflito mantem o baseline anterior (nao avanca)", () => {
  const manifest = [{ name: "alpha", status: "active", files: { "CLAUDE.md": { md5: "VM" } } }];
  const local = { alpha: { "CLAUDE.md": "EDITADO" } };
  const prev = { alpha: { "CLAUDE.md": "BAIXADO_ANTES" } };
  const next = computeBaseline(manifest, local, prev, new Set());
  assert.deepEqual(next, { alpha: { "CLAUDE.md": "BAIXADO_ANTES" } });
});

test("computeBaseline: orfao (sumiu do manifest) e removido do baseline", () => {
  const manifest = [{ name: "alpha", status: "active", files: { "CLAUDE.md": { md5: "VM" } } }];
  const local = { alpha: { "CLAUDE.md": "VM" }, morto: { "CLAUDE.md": "x" } };
  const prev = { alpha: { "CLAUDE.md": "VM" }, morto: { "CLAUDE.md": "x" } };
  const next = computeBaseline(manifest, local, prev, new Set());
  assert.deepEqual(next, { alpha: { "CLAUDE.md": "VM" } });
});

// --- buildLocalSettings (provisionamento de outputStyle por caso) ---

test("buildLocalSettings: materializa outputStyle e permissions do scaffolding", async () => {
  const { buildLocalSettings } = await import("./sync-cases.mjs");
  const raw = JSON.stringify({
    outputStyle: "Legal Main Agent",
    permissions: { allow: ["Read", "Glob"] },
  });
  const out = buildLocalSettings(raw);
  assert.deepEqual(JSON.parse(out), {
    outputStyle: "Legal Main Agent",
    permissions: { allow: ["Read", "Glob"] },
  });
});

test("buildLocalSettings: sem outputStyle no scaffolding -> null (no-op)", async () => {
  const { buildLocalSettings } = await import("./sync-cases.mjs");
  assert.equal(buildLocalSettings(JSON.stringify({ permissions: {} })), null);
  assert.equal(buildLocalSettings(null), null);
  assert.equal(buildLocalSettings(undefined), null);
});

test("buildLocalSettings: JSON invalido -> null, nunca lanca", async () => {
  const { buildLocalSettings } = await import("./sync-cases.mjs");
  assert.equal(buildLocalSettings("{nao é json"), null);
});

// --- extractOutputStyle (override por caso via case.yaml) ---

test("extractOutputStyle: acha o campo plano, com aspas e com acento", async () => {
  const { extractOutputStyle } = await import("./sync-cases.mjs");
  assert.equal(extractOutputStyle("tipo: material\noutput_style: Legal Societário\ntags: []"), "Legal Societário");
  assert.equal(extractOutputStyle('output_style: "Legal Societário"'), "Legal Societário");
  assert.equal(extractOutputStyle("output_style: 'Legal Main Agent'"), "Legal Main Agent");
  assert.equal(extractOutputStyle("output_style: Legal Societário # consultivo"), "Legal Societário");
});

test("extractOutputStyle: ausente, comentado, vazio ou input nulo -> null", async () => {
  const { extractOutputStyle } = await import("./sync-cases.mjs");
  assert.equal(extractOutputStyle("tipo: processo\ntags: []"), null);
  assert.equal(extractOutputStyle("# output_style: Legal Societário"), null);
  assert.equal(extractOutputStyle("output_style:"), null);
  assert.equal(extractOutputStyle(null), null);
  assert.equal(extractOutputStyle(undefined), null);
});

test("buildLocalSettings: override de style do case.yaml vence o default do scaffolding", async () => {
  const { buildLocalSettings } = await import("./sync-cases.mjs");
  const scaffolding = JSON.stringify({
    outputStyle: "Legal Main Agent",
    permissions: { allow: ["Read"] },
  });
  const out = JSON.parse(buildLocalSettings(scaffolding, "Legal Societário"));
  assert.equal(out.outputStyle, "Legal Societário");
  assert.deepEqual(out.permissions, { allow: ["Read"] });
  // sem override, mantem o default
  const def = JSON.parse(buildLocalSettings(scaffolding));
  assert.equal(def.outputStyle, "Legal Main Agent");
  // override vazio/nulo nao derruba o default
  const nul = JSON.parse(buildLocalSettings(scaffolding, null));
  assert.equal(nul.outputStyle, "Legal Main Agent");
});

// --- autoMemoryDirectory por-caso (CMR-138) ---

test("buildLocalSettings inclui autoMemoryDirectory quando passado", async () => {
  const { buildLocalSettings } = await import("./sync-cases.mjs");
  const raw = JSON.stringify({ outputStyle: "Legal Main Agent", permissions: { allow: ["Read"] } });
  const out = JSON.parse(buildLocalSettings(raw, null, "C:/Users/pedro/cases/x/.memoria/42"));
  assert.equal(out.autoMemoryDirectory, "C:/Users/pedro/cases/x/.memoria/42");
  assert.equal(out.outputStyle, "Legal Main Agent");
});

test("mergeAutoMemoryDir preserva chaves e adiciona", async () => {
  const { mergeAutoMemoryDir } = await import("./sync-cases.mjs");
  const r = JSON.parse(mergeAutoMemoryDir(JSON.stringify({ outputStyle: "X", permissions: {} }), "/abs/.memoria/42"));
  assert.equal(r.autoMemoryDirectory, "/abs/.memoria/42");
  assert.equal(r.outputStyle, "X");
});

test("mergeAutoMemoryDir em JSON invalido -> null", async () => {
  const { mergeAutoMemoryDir } = await import("./sync-cases.mjs");
  assert.equal(mergeAutoMemoryDir("{quebrado", "/x"), null);
});

test("mergeAutoMemoryDir: raw que ja contem autoMemoryDirectory preserva a escolha local", async () => {
  const { mergeAutoMemoryDir } = await import("./sync-cases.mjs");
  const raw = JSON.stringify({ outputStyle: "X", autoMemoryDirectory: "/escolha/local" });
  const r = JSON.parse(mergeAutoMemoryDir(raw, "/nova/.memoria/42"));
  // nao sobrescreve escolha local ja presente
  assert.equal(r.autoMemoryDirectory, "/escolha/local");
  assert.equal(r.outputStyle, "X");
});
