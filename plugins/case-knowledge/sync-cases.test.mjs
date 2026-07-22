import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planActions,
  computeBaseline,
  isExcluded,
  archiveTarget,
  planMemoriaActions,
  computeMemoriaBaseline,
  memFileType,
  md5hex,
  readMemoriaState,
  readFeedbackState,
  buildPeersIndex,
  buildFeedbackIndex,
} from "./sync-cases.mjs";

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

// ---------- CMR-138: memoria de caso sincronizavel (funcoes puras) ----------

// --- memFileType: roteamento por frontmatter (primario) + prefixo (fallback) ---

test("memFileType: frontmatter metadata.type feedback (nome livre) -> feedback", () => {
  const content = "---\nmetadata:\n  type: feedback\n  tags: [x]\n---\ncorpo";
  assert.equal(memFileType("recursos-preferir-agravo.md", content), "feedback");
});

test("memFileType: frontmatter type project (nome livre) -> memoria", () => {
  const content = "---\nmetadata:\n  type: project\n---\ncorpo";
  assert.equal(memFileType("recursos-preferir-agravo.md", content), "memoria");
});

test("memFileType: frontmatter type feedback top-level -> feedback", () => {
  const content = "---\ntype: feedback\n---\ncorpo";
  assert.equal(memFileType("nota-solta.md", content), "feedback");
});

test("memFileType: MEMORY.md sem frontmatter -> memoria", () => {
  assert.equal(memFileType("MEMORY.md", "# indice\n- a\n- b"), "memoria");
});

test("memFileType: fallback legado prefixo feedback_ sem frontmatter -> feedback", () => {
  assert.equal(memFileType("feedback_y.md", "sem frontmatter"), "feedback");
});

test("memFileType: content ausente/nao-string -> so o fallback de prefixo", () => {
  assert.equal(memFileType("feedback_z.md", undefined), "feedback");
  assert.equal(memFileType("project_z.md", null), "memoria");
});

test("memFileType: frontmatter tolerante a CRLF e aspas", () => {
  const content = "---\r\nmetadata:\r\n  type: \"feedback\"\r\n---\r\ncorpo";
  assert.equal(memFileType("qualquer.md", content), "feedback");
});

// --- planMemoriaActions: upload roteia por-autor e por-tipo ---

test("upload roteia feedback_ para feedback e resto para memoria", () => {
  const plan = planMemoriaActions({}, { "caso": { "42": { "project_x.md": { md5: "a", content: "..." }, "feedback_y.md": { md5: "b", content: "..." } } } }, {}, "42");
  const targets = Object.fromEntries(plan.uploadFiles.map((u) => [u.name, u.target]));
  assert.equal(targets["project_x.md"], "memoria");
  assert.equal(targets["feedback_y.md"], "feedback");
});

test("upload: nome-livre com frontmatter metadata.type feedback -> target feedback", () => {
  const plan = planMemoriaActions({}, { "caso": { "42": { "recursos-agravo.md": { md5: "a", content: "---\nmetadata:\n  type: feedback\n---\nx" } } } }, {}, "42");
  assert.equal(plan.uploadFiles.length, 1);
  assert.equal(plan.uploadFiles[0].target, "feedback");
});

test("upload: nome-livre com frontmatter type project -> target memoria", () => {
  const plan = planMemoriaActions({}, { "caso": { "42": { "estrategia.md": { md5: "a", content: "---\nmetadata:\n  type: project\n---\nx" } } } }, {}, "42");
  assert.equal(plan.uploadFiles[0].target, "memoria");
});

test("upload deriva SO do self, ignora subdirs de peers ja baixados", () => {
  const local = { "caso": { "42": { "a.md": { md5: "x", content: "meu" } }, "99": { "b.md": { md5: "y", content: "alheio" } } } };
  const plan = planMemoriaActions({}, local, {}, "42");
  assert.deepEqual(plan.uploadFiles.map((u) => u.name), ["a.md"]);
});

test("upload: selfAuthor null -> nenhum upload (defensivo)", () => {
  const local = { "caso": { "42": { "a.md": { md5: "x", content: "meu" } } } };
  const plan = planMemoriaActions({}, local, {}, null);
  assert.deepEqual(plan.uploadFiles, []);
});

test("upload: PEERS.md nunca e considerado arquivo de autor", () => {
  const local = { "caso": { "42": { "PEERS.md": { md5: "p", content: "indice" }, "a.md": { md5: "x", content: "meu" } } } };
  const plan = planMemoriaActions({}, local, {}, "42");
  assert.deepEqual(plan.uploadFiles.map((u) => u.name), ["a.md"]);
});

// --- planMemoriaActions: download inclui self sob never-overwrite ---

test("maquina nova baixa o proprio self para semear (local ausente)", () => {
  const plan = planMemoriaActions({ "caso": { "42": { "a.md": { md5: "x" } } } }, {}, {}, "42");
  assert.equal(plan.downloadAuthors.filter((d) => d.author === "42").length, 1);
});

test("download peer: local intocado desde o baseline e VM mudou -> baixa", () => {
  const remote = { "caso": { "99": { "b.md": { md5: "vm-novo" } } } };
  const local = { "caso": { "99": { "b.md": "base-antigo" } } };
  const baseline = { "caso": { "99": { "b.md": "base-antigo" } } };
  const plan = planMemoriaActions(remote, local, baseline, "42");
  assert.deepEqual(plan.downloadAuthors, [{ case: "caso", author: "99", files: ["b.md"] }]);
});

test("self editado localmente desde o baseline NAO e baixado (preserva)", () => {
  const remote = { "caso": { "42": { "a.md": { md5: "vm-novo" } } } };
  const local = { "caso": { "42": { "a.md": "local-editado" } } };
  const baseline = { "caso": { "42": { "a.md": "base-antigo" } } }; // local != base => editado
  const plan = planMemoriaActions(remote, local, baseline, "42");
  assert.equal(plan.downloadAuthors.filter((d) => d.author === "42").length, 0);
});

test("download: local == baseline == VM (ja sincronizado) -> nao baixa", () => {
  const remote = { "caso": { "42": { "a.md": { md5: "x" } } } };
  const local = { "caso": { "42": { "a.md": "x" } } };
  const baseline = { "caso": { "42": { "a.md": "x" } } };
  const plan = planMemoriaActions(remote, local, baseline, "42");
  assert.deepEqual(plan.downloadAuthors, []);
});

test("download: PEERS.md do manifest nunca e baixado como arquivo de autor", () => {
  const remote = { "caso": { "42": { "PEERS.md": { md5: "p" }, "a.md": { md5: "x" } } } };
  const plan = planMemoriaActions(remote, {}, {}, "42");
  assert.deepEqual(plan.downloadAuthors, [{ case: "caso", author: "42", files: ["a.md"] }]);
});

// --- computeMemoriaBaseline: registra md5 de download E upload self ---

test("computeMemoriaBaseline registra md5 de arquivo self uploadado (evita ping-pong)", () => {
  // self "42" escreveu a.md local (md5 x), ainda ausente na VM -> foi uploadado
  const remote = {};
  const local = { "caso": { "42": { "a.md": { md5: "x", content: "meu" } } } };
  const uploaded = new Set(["caso 42 a.md"]);
  const base = computeMemoriaBaseline(remote, local, {}, new Set(), uploaded, "42");
  assert.equal(base["caso"]["42"]["a.md"], "x");
});

test("computeMemoriaBaseline registra md5 da VM para arquivo baixado", () => {
  const remote = { "caso": { "99": { "b.md": { md5: "vm-novo" } } } };
  const local = {};
  const succeeded = new Set(["caso 99 b.md"]);
  const base = computeMemoriaBaseline(remote, local, {}, succeeded, new Set(), "42");
  assert.equal(base["caso"]["99"]["b.md"], "vm-novo");
});

test("computeMemoriaBaseline preserva prev em conflito (nao baixado, nao sincronizado)", () => {
  const remote = { "caso": { "42": { "a.md": { md5: "vm-novo" } } } };
  const local = { "caso": { "42": { "a.md": "local-editado" } } };
  const prev = { "caso": { "42": { "a.md": "base-antigo" } } };
  const base = computeMemoriaBaseline(remote, local, prev, new Set(), new Set(), "42");
  assert.equal(base["caso"]["42"]["a.md"], "base-antigo");
});

test("computeMemoriaBaseline adota md5 da VM quando local ja == VM", () => {
  const remote = { "caso": { "42": { "a.md": { md5: "x" } } } };
  const local = { "caso": { "42": { "a.md": "x" } } };
  const base = computeMemoriaBaseline(remote, local, {}, new Set(), new Set(), "42");
  assert.equal(base["caso"]["42"]["a.md"], "x");
});

// --- FIX 1 (CMR-138): delecao local nao pode ser ressuscitada ---

test("download: local ausente + baseline presente + VM tem -> NAO baixa (delecao preservada)", () => {
  // usuario deletou a.md localmente apos o baseline; a auto-memory deleta
  // memorias erradas por design -> ressuscitar e nocivo.
  const remote = { "caso": { "42": { "a.md": { md5: "vm" } } } };
  const local = {}; // a.md ausente local
  const baseline = { "caso": { "42": { "a.md": "base" } } }; // ja foi baixado antes
  const plan = planMemoriaActions(remote, local, baseline, "42");
  assert.deepEqual(plan.downloadAuthors, []);
});

test("download: local ausente + baseline ausente -> baixa (seed)", () => {
  const remote = { "caso": { "42": { "a.md": { md5: "vm" } } } };
  const plan = planMemoriaActions(remote, {}, {}, "42");
  assert.deepEqual(plan.downloadAuthors, [{ case: "caso", author: "42", files: ["a.md"] }]);
});

test("download: local existe, baseline ausente e VM difere -> NAO baixa (preserva bootstrap divergente)", () => {
  const remote = { "caso": { "42": { "a.md": { md5: "vm-novo" } } } };
  const local = { "caso": { "42": { "a.md": "local-existente" } } };
  const baseline = {}; // nunca registrado no baseline
  const plan = planMemoriaActions(remote, local, baseline, "42");
  assert.deepEqual(plan.downloadAuthors, []);
});

// --- FIX 2 (CMR-138): gate de upload por divergencia ---

test("upload: self local == baseline e VM mudou -> download SIM, upload NAO", () => {
  const remote = { "caso": { "42": { "a.md": { md5: "vm-novo", content: "vm" } } } };
  const local = { "caso": { "42": { "a.md": { md5: "base", content: "local" } } } };
  const baseline = { "caso": { "42": { "a.md": "base" } } };
  const plan = planMemoriaActions(remote, local, baseline, "42");
  assert.deepEqual(plan.downloadAuthors, [{ case: "caso", author: "42", files: ["a.md"] }]);
  assert.deepEqual(plan.uploadFiles, []); // nao reverte a versao mais nova da VM
});

test("upload: self editado (!=baseline) e VM mudou -> download NAO, upload SIM (last-write-wins)", () => {
  const remote = { "caso": { "42": { "a.md": { md5: "vm-novo", content: "vm" } } } };
  const local = { "caso": { "42": { "a.md": { md5: "local-editado", content: "meu" } } } };
  const baseline = { "caso": { "42": { "a.md": "base-antigo" } } };
  const plan = planMemoriaActions(remote, local, baseline, "42");
  assert.deepEqual(plan.downloadAuthors, []); // edicao local preservada
  assert.deepEqual(plan.uploadFiles.map((u) => u.name), ["a.md"]);
});

test("upload: self local == remote -> nem download nem upload", () => {
  const remote = { "caso": { "42": { "a.md": { md5: "x", content: "vm" } } } };
  const local = { "caso": { "42": { "a.md": { md5: "x", content: "meu" } } } };
  const baseline = { "caso": { "42": { "a.md": "x" } } };
  const plan = planMemoriaActions(remote, local, baseline, "42");
  assert.deepEqual(plan.downloadAuthors, []);
  assert.deepEqual(plan.uploadFiles, []);
});

test("upload: self so-local (VM nao tem) -> upload", () => {
  const remote = {}; // VM nao tem o caso/autor
  const local = { "caso": { "42": { "a.md": { md5: "x", content: "meu" } } } };
  const plan = planMemoriaActions(remote, local, {}, "42");
  assert.deepEqual(plan.uploadFiles.map((u) => u.name), ["a.md"]);
});

// --- FIX 3 (CMR-138): frontmatter conhecido vence o prefixo nos dois sentidos ---

test("memFileType: feedback_ com frontmatter type project -> memoria (frontmatter primario)", () => {
  const content = "---\nmetadata:\n  type: project\n---\ncorpo";
  assert.equal(memFileType("feedback_x.md", content), "memoria");
});

test("memFileType: feedback_ sem frontmatter -> feedback (fallback prefixo mantido)", () => {
  assert.equal(memFileType("feedback_y.md", "sem frontmatter"), "feedback");
});

test("memFileType: feedback_ com frontmatter type desconhecido -> feedback (fallback prefixo)", () => {
  const content = "---\ntype: decision\n---\ncorpo";
  assert.equal(memFileType("feedback_z.md", content), "feedback");
});

// ---------- Task 9: leitura local (readMemoriaState/readFeedbackState) ----------

test("readMemoriaState: le caso/autor/*.md com md5+content, ignora PEERS.md e nao-.md", () => {
  const base = mkdtempSync(join(tmpdir(), "cmr138-mem-"));
  try {
    const a42 = join(base, "caso-x", ".memoria", "42");
    mkdirSync(a42, { recursive: true });
    writeFileSync(join(a42, "nota.md"), "conteudo A");
    writeFileSync(join(a42, "PEERS.md"), "indice gerado pelo sync");
    writeFileSync(join(a42, "raw.txt"), "nao markdown");
    const a77 = join(base, "caso-x", ".memoria", "77");
    mkdirSync(a77, { recursive: true });
    writeFileSync(join(a77, "b.md"), "conteudo B");
    // caso sem .memoria -> ausente do resultado
    mkdirSync(join(base, "caso-y"), { recursive: true });

    const state = readMemoriaState(base);
    assert.deepEqual(Object.keys(state), ["caso-x"]);
    assert.deepEqual(Object.keys(state["caso-x"]).sort(), ["42", "77"]);
    assert.deepEqual(Object.keys(state["caso-x"]["42"]), ["nota.md"]); // PEERS.md e raw.txt fora
    assert.equal(state["caso-x"]["42"]["nota.md"].content, "conteudo A");
    assert.equal(state["caso-x"]["42"]["nota.md"].md5, md5hex(Buffer.from("conteudo A")));
    assert.equal(state["caso-x"]["77"]["b.md"].content, "conteudo B");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("readMemoriaState: casesBase ausente -> {} (tolerante, nunca lanca)", () => {
  assert.deepEqual(readMemoriaState(join(tmpdir(), "cmr138-nao-existe-abc123")), {});
});

test("readFeedbackState: le .feedback/autor/*.md, ignora FEEDBACK.md e nao-.md", () => {
  const base = mkdtempSync(join(tmpdir(), "cmr138-fb-"));
  try {
    const fb = join(base, ".feedback");
    mkdirSync(join(fb, "42"), { recursive: true });
    writeFileSync(join(fb, "FEEDBACK.md"), "indice na raiz");            // raiz de .feedback, nao e autor
    writeFileSync(join(fb, "42", "feedback_x.md"), "aprendizado X");
    writeFileSync(join(fb, "42", "FEEDBACK.md"), "defensivo em subdir"); // ignorado em qualquer nivel
    writeFileSync(join(fb, "42", "nota.txt"), "nao md");

    const state = readFeedbackState(base);
    assert.deepEqual(Object.keys(state), ["42"]);
    assert.deepEqual(Object.keys(state["42"]), ["feedback_x.md"]);
    assert.equal(state["42"]["feedback_x.md"].content, "aprendizado X");
    assert.equal(state["42"]["feedback_x.md"].md5, md5hex(Buffer.from("aprendizado X")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("readFeedbackState: .feedback ausente -> {}", () => {
  const base = mkdtempSync(join(tmpdir(), "cmr138-fb2-"));
  try {
    assert.deepEqual(readFeedbackState(base), {});
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------- Task 9: indices agregados (buildPeersIndex/buildFeedbackIndex) ----------

test("buildPeersIndex: 2 autores geram marcador `## Autor` por autor com conteudo", () => {
  const trees = {
    "42": { "nota.md": { md5: "a", content: "prefira agravo" } },
    "77": { "estrategia.md": { md5: "b", content: "foco na nulidade" } },
  };
  const idx = buildPeersIndex(trees);
  assert.match(idx, /## Autor 42/);
  assert.match(idx, /## Autor 77/);
  assert.match(idx, /nota\.md/);
  assert.match(idx, /prefira agravo/);
  assert.match(idx, /foco na nulidade/);
  assert.ok(Buffer.byteLength(idx, "utf-8") <= 25 * 1024);
  assert.ok(!/itens omitidos/.test(idx)); // cabe sem truncar
});

test("buildPeersIndex: entrada gigante trunca <=25KB com trailer visivel", () => {
  const trees = {};
  // 100 autores x ~1KB cada -> ~100KB, estoura o cap de 25KB
  for (let i = 0; i < 100; i++) {
    trees[`autor${i}`] = { [`nota${i}.md`]: { md5: "x", content: "L".repeat(1000) } };
  }
  const idx = buildPeersIndex(trees);
  assert.ok(Buffer.byteLength(idx, "utf-8") <= 25 * 1024, "index deve caber em 25KB");
  assert.match(idx, /> \[sync\] \d+ itens omitidos por limite de tamanho/);
});

test("buildPeersIndex: entrada vazia -> so header, sem trailer, nunca lanca", () => {
  const idx = buildPeersIndex({});
  assert.equal(typeof idx, "string");
  assert.ok(!/itens omitidos/.test(idx));
});

test("buildFeedbackIndex: agrega por autor; trunca com trailer quando estoura", () => {
  const small = { "42": { "feedback_a.md": { md5: "a", content: "erro comum X" } } };
  const idxSmall = buildFeedbackIndex(small);
  assert.match(idxSmall, /## Autor 42/);
  assert.match(idxSmall, /erro comum X/);
  assert.ok(!/itens omitidos/.test(idxSmall)); // sem omissao quando cabe

  const big = {};
  for (let i = 0; i < 100; i++) {
    big[`autor${i}`] = { [`f${i}.md`]: { md5: "x", content: "Z".repeat(1000) } };
  }
  const idxBig = buildFeedbackIndex(big);
  assert.ok(Buffer.byteLength(idxBig, "utf-8") <= 25 * 1024);
  assert.match(idxBig, /> \[sync\] \d+ itens omitidos por limite de tamanho/);
});
