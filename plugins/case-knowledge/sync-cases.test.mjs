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
  syncMemoria,
  postJson,
  provisionCaseSettings,
} from "./sync-cases.mjs";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";

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

// --- provisionCaseSettings: injecao de autoMemoryDirectory em disco (tmpdir real) ---

function withCasesBase(fn) {
  const base = mkdtempSync(join(tmpdir(), "ck-sync-"));
  try {
    return fn(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const SCAFFOLDING = JSON.stringify({ outputStyle: "Legal Main Agent", permissions: { allow: ["Read"] } });

function seedScaffolding(base) {
  mkdirSync(join(base, ".claude"), { recursive: true });
  writeFileSync(join(base, ".claude", "settings.json"), SCAFFOLDING, "utf-8");
}

test("provisionCaseSettings: caso NOVO recebe settings.local.json com autoMemoryDirectory", () => {
  withCasesBase((base) => {
    seedScaffolding(base);
    mkdirSync(join(base, "alpha"), { recursive: true });
    const errors = [];
    const n = provisionCaseSettings(base, [{ name: "alpha" }], {}, "42", errors);
    assert.equal(n, 1);
    assert.deepEqual(errors, []);
    const target = join(base, "alpha", ".claude", "settings.local.json");
    const out = JSON.parse(readFileSync(target, "utf-8"));
    assert.equal(out.outputStyle, "Legal Main Agent");
    // path absoluto, normalizado para `/`, terminando em .memoria/<autor>
    assert.equal(out.autoMemoryDirectory, `${base}/alpha/.memoria/42`.replace(/\\/g, "/"));
  });
});

test("provisionCaseSettings: caso LEGADO recebe autoMemoryDirectory via merge (backup + preserva chaves)", () => {
  withCasesBase((base) => {
    seedScaffolding(base);
    const caseClaude = join(base, "beta", ".claude");
    mkdirSync(caseClaude, { recursive: true });
    const legacy = `${JSON.stringify({ outputStyle: "Legal Societário", permissions: { allow: ["Bash"] } }, null, 2)}\n`;
    const target = join(caseClaude, "settings.local.json");
    writeFileSync(target, legacy, "utf-8");

    const errors = [];
    const n = provisionCaseSettings(base, [{ name: "beta" }], {}, "42", errors);
    assert.equal(n, 1);
    assert.deepEqual(errors, []);
    const out = JSON.parse(readFileSync(target, "utf-8"));
    assert.equal(out.autoMemoryDirectory, `${base}/beta/.memoria/42`.replace(/\\/g, "/"));
    assert.equal(out.outputStyle, "Legal Societário"); // preservado
    assert.deepEqual(out.permissions, { allow: ["Bash"] });
    // backup do estado anterior, byte-a-byte
    assert.equal(readFileSync(`${target}.bak`, "utf-8"), legacy);
  });
});

test("provisionCaseSettings: LEGADO ja com autoMemoryDirectory -> arquivo NAO regravado (mtime/conteudo)", () => {
  withCasesBase((base) => {
    seedScaffolding(base);
    const caseClaude = join(base, "gamma", ".claude");
    mkdirSync(caseClaude, { recursive: true });
    // formato canonico (como o sync grava) ja com o campo -> merge devolve byte-igual
    const already = `${JSON.stringify({ outputStyle: "X", autoMemoryDirectory: "/escolha/local" }, null, 2)}\n`;
    const target = join(caseClaude, "settings.local.json");
    writeFileSync(target, already, "utf-8");
    const before = statSync(target).mtimeMs;

    const errors = [];
    const n = provisionCaseSettings(base, [{ name: "gamma" }], {}, "42", errors);
    assert.equal(n, 0);
    assert.deepEqual(errors, []);
    assert.equal(readFileSync(target, "utf-8"), already);
    assert.equal(statSync(target).mtimeMs, before);
    assert.equal(existsSync(`${target}.bak`), false); // no-op nao gera backup
  });
});

test("provisionCaseSettings: LEGADO corrompido -> intocado (nunca pisa), skip", () => {
  withCasesBase((base) => {
    seedScaffolding(base);
    const caseClaude = join(base, "delta", ".claude");
    mkdirSync(caseClaude, { recursive: true });
    const corrupt = '{ "outputStyle": "X"  <<< quebrado';
    const target = join(caseClaude, "settings.local.json");
    writeFileSync(target, corrupt, "utf-8");

    const errors = [];
    const n = provisionCaseSettings(base, [{ name: "delta" }], {}, "42", errors);
    assert.equal(n, 0);
    assert.equal(readFileSync(target, "utf-8"), corrupt); // intocado byte-a-byte
    assert.equal(existsSync(`${target}.bak`), false);
  });
});

test("provisionCaseSettings: selfAuthor null -> caso NOVO sem autoMemoryDirectory; LEGADO intocado", () => {
  withCasesBase((base) => {
    seedScaffolding(base);
    // caso novo (sem settings.local.json)
    mkdirSync(join(base, "novo"), { recursive: true });
    // caso legado (com settings.local.json sem o campo)
    const legadoClaude = join(base, "legado", ".claude");
    mkdirSync(legadoClaude, { recursive: true });
    const legadoRaw = `${JSON.stringify({ outputStyle: "X" }, null, 2)}\n`;
    const legadoTarget = join(legadoClaude, "settings.local.json");
    writeFileSync(legadoTarget, legadoRaw, "utf-8");
    const beforeMtime = statSync(legadoTarget).mtimeMs;

    const errors = [];
    provisionCaseSettings(base, [{ name: "novo" }, { name: "legado" }], {}, null, errors);

    // novo: settings.local.json criado, mas SEM autoMemoryDirectory
    const novoOut = JSON.parse(
      readFileSync(join(base, "novo", ".claude", "settings.local.json"), "utf-8"),
    );
    assert.equal(novoOut.outputStyle, "Legal Main Agent");
    assert.equal(novoOut.autoMemoryDirectory, undefined);
    // legado: intocado (sem injecao quando nao ha autor)
    assert.equal(readFileSync(legadoTarget, "utf-8"), legadoRaw);
    assert.equal(statSync(legadoTarget).mtimeMs, beforeMtime);
    assert.equal(existsSync(`${legadoTarget}.bak`), false);
  });
});

test("provisionCaseSettings: dir de caso ausente localmente -> skip sem erro", () => {
  withCasesBase((base) => {
    seedScaffolding(base);
    const errors = [];
    // manifest referencia caso que nao existe no disco local
    const n = provisionCaseSettings(base, [{ name: "inexistente" }], {}, "42", errors);
    assert.equal(n, 0);
    assert.deepEqual(errors, []);
    assert.equal(existsSync(join(base, "inexistente")), false);
  });
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

// --- FIX (CMR-138 review): gate de upload de feedback contra o POOL remoto ---
// O arquivo de feedback vive fisicamente em <caso>/.memoria/<self>/ mas remotamente
// no pool (.feedback). O gate deve comparar o md5 local contra o pool -- nao contra
// o remote do CASO, que nunca tem o arquivo (remoteMd5 sempre undefined -> re-upload
// perpetuo a cada ciclo, o ping-pong que este fix fecha).

test("upload feedback (a): sob caso, pool remoto SEM o arquivo -> uploada", () => {
  const local = { "caso-a": { "42": { "feedback_x.md": { md5: "X", content: "corpo" } } } };
  const plan = planMemoriaActions({}, local, {}, "42");
  assert.deepEqual(plan.uploadFiles.map((u) => u.name), ["feedback_x.md"]);
  assert.equal(plan.uploadFiles[0].target, "feedback");
});

test("upload feedback (b): sob caso, pool remoto com MESMO md5 -> NAO uploada (fecha ping-pong)", () => {
  const local = { "caso-a": { "42": { "feedback_x.md": { md5: "SAME", content: "corpo" } } } };
  const remote = { ".feedback": { "42": { "feedback_x.md": "SAME" } } };
  const plan = planMemoriaActions(remote, local, {}, "42");
  assert.deepEqual(plan.uploadFiles, []);
});

test("upload feedback (c): sob caso, pool remoto com md5 DIFERENTE -> uploada", () => {
  const local = { "caso-a": { "42": { "feedback_x.md": { md5: "NEW", content: "corpo novo" } } } };
  const remote = { ".feedback": { "42": { "feedback_x.md": "OLD" } } };
  const plan = planMemoriaActions(remote, local, {}, "42");
  assert.deepEqual(plan.uploadFiles.map((u) => u.name), ["feedback_x.md"]);
});

test("upload memoria (d): gate compara contra o remote do CASO (inalterado)", () => {
  // arquivo de memoria com mesmo md5 no remote do caso -> nao sobe (gate do caso).
  const local = { "caso-a": { "42": { "estrategia.md": { md5: "M", content: "corpo" } } } };
  const remote = { "caso-a": { "42": { "estrategia.md": "M" } } };
  const baseline = { "caso-a": { "42": { "estrategia.md": "M" } } };
  const plan = planMemoriaActions(remote, local, baseline, "42");
  assert.deepEqual(plan.uploadFiles, []);
});

test("upload feedback (e): copia local do pool (.feedback/<self>) == remote -> nao re-sobe", () => {
  const local = { ".feedback": { "42": { "feedback_meu.md": { md5: "SAME", content: "corpo" } } } };
  const remote = { ".feedback": { "42": { "feedback_meu.md": "SAME" } } };
  const plan = planMemoriaActions(remote, local, {}, "42");
  assert.deepEqual(plan.uploadFiles, []);
});

test("upload feedback (f): colisao de nome entre 2 casos com md5 distintos -> 1 upload (caso menor) + 1 warning", () => {
  const local = {
    "case-b": { "42": { "feedback_dup.md": { md5: "B", content: "corpo b" } } },
    "case-a": { "42": { "feedback_dup.md": { md5: "A", content: "corpo a" } } },
  };
  const plan = planMemoriaActions({}, local, {}, "42");
  assert.deepEqual(plan.uploadFiles.map((u) => `${u.case}/${u.name}`), ["case-a/feedback_dup.md"]);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /feedback_dup\.md/);
  assert.match(plan.warnings[0], /case-a/);
});

test("upload feedback (f'): colisao de nome com MESMO md5 -> 1 upload (menor), sem warning", () => {
  // mesmo conteudo em 2 casos: pool tem 1 slot -> sobe so o menor, mas nao e conflito.
  const local = {
    "case-b": { "42": { "feedback_dup.md": { md5: "SAME", content: "corpo" } } },
    "case-a": { "42": { "feedback_dup.md": { md5: "SAME", content: "corpo" } } },
  };
  const plan = planMemoriaActions({}, local, {}, "42");
  assert.deepEqual(plan.uploadFiles.map((u) => u.case), ["case-a"]);
  assert.deepEqual(plan.warnings, []);
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

// ---------- Task 10: syncMemoria (wiring download+upload) + postJson ----------

// exporta postJson (existe como funcao); a validacao de rede real e coberta
// indiretamente pelos testes de syncMemoria com fake injetavel.
test("postJson e exportado (funcao)", () => {
  assert.equal(typeof postJson, "function");
});

// Fabrica de deps fake para syncMemoria: getJson roteia por URL, postJson coleta.
function makeFakeApi(routes) {
  const gets = [];
  const posts = [];
  const getJson = async (url) => {
    gets.push(url);
    for (const [frag, val] of Object.entries(routes.get || {})) {
      if (url.endsWith(frag)) return typeof val === "function" ? val(url) : val;
    }
    throw new Error(`404 ${url}`);
  };
  const postJson = async (url, body) => {
    posts.push({ url, body });
    for (const [frag, val] of Object.entries(routes.post || {})) {
      if (url.endsWith(frag)) return typeof val === "function" ? val(body) : val;
    }
    throw new Error(`404 POST ${url}`);
  };
  return { deps: { getJson, postJson }, gets, posts };
}

test("syncMemoria: ciclo download peer + upload roteado; grava .memoria-state.json; nao toca .sync-state.json", async () => {
  const base = mkdtempSync(join(tmpdir(), "cmr138-sync-"));
  try {
    // self=42 tem memoria (estrategia.md) e um feedback (feedback_lig.md) em caso-a
    const self42 = join(base, "caso-a", ".memoria", "42");
    mkdirSync(self42, { recursive: true });
    writeFileSync(join(self42, "estrategia.md"), "estrategia do self");
    writeFileSync(join(self42, "feedback_lig.md"), "ligar pro cliente");
    // caso-ghost NAO existe como dir local -> download deve ser pulado

    // sentinel do sync de briefing: NUNCA deve ser tocado
    writeFileSync(join(base, ".sync-state.json"), '{"SENTINELA":true}');

    const { deps, gets, posts } = makeFakeApi({
      get: {
        "/memoria-manifest": {
          cases: {
            "caso-a": { "99": { "peer.md": "vmpeer" } },
            "caso-ghost": { "99": { "g.md": "gx" } },
          },
        },
        "/feedback-manifest": { authors: {} },
        "/cases/caso-a/memoria/99": { files: { "peer.md": { content: "conteudo do peer", md5: "vmpeer" } } },
      },
      post: {
        "/cases/caso-a/memoria": { author: "42", case: "caso-a", count: 1, written: ["estrategia.md"] },
        "/feedback": { author: "42", count: 1, written: ["feedback_lig.md"] },
      },
    });

    await syncMemoria("http://t/api", base, "42", deps);

    // peer baixado em caso-a/.memoria/99/peer.md
    assert.ok(existsSync(join(base, "caso-a", ".memoria", "99", "peer.md")));
    assert.equal(readFileSync(join(base, "caso-a", ".memoria", "99", "peer.md"), "utf-8"), "conteudo do peer");

    // caso-ghost pulado: nunca buscou o conteudo, nunca criou dir
    assert.ok(!gets.some((u) => u.includes("caso-ghost/memoria")));
    assert.ok(!existsSync(join(base, "caso-ghost")));

    // PEERS.md do caso-a inclui o peer 99, exclui o self 42
    const peers = readFileSync(join(base, "caso-a", ".memoria", "PEERS.md"), "utf-8");
    assert.match(peers, /## Autor 99/);
    assert.ok(!/## Autor 42/.test(peers), "PEERS.md nao pode listar o self");
    assert.match(peers, /conteudo do peer/);

    // uploads roteados: estrategia -> memoria do caso; feedback_lig -> pool
    const memPost = posts.find((p) => p.url.endsWith("/cases/caso-a/memoria"));
    const fbPost = posts.find((p) => p.url.endsWith("/feedback"));
    assert.ok(memPost, "esperava POST na memoria do caso");
    assert.deepEqual(memPost.body.files.map((f) => f.name), ["estrategia.md"]);
    assert.ok(fbPost, "esperava POST no pool de feedback");
    assert.deepEqual(fbPost.body.files.map((f) => f.name), ["feedback_lig.md"]);

    // baseline gravado com md5 do download (VM) e dos uploads (written)
    const st = JSON.parse(readFileSync(join(base, ".memoria-state.json"), "utf-8"));
    assert.equal(st["caso-a"]["99"]["peer.md"], "vmpeer");
    assert.equal(st["caso-a"]["42"]["estrategia.md"], md5hex(Buffer.from("estrategia do self")));
    assert.equal(st["caso-a"]["42"]["feedback_lig.md"], md5hex(Buffer.from("ligar pro cliente")));
    // caso-ghost nao entrou no baseline (nao foi baixado)
    assert.ok(!("caso-ghost" in st));

    // invariante dura: .sync-state.json intocado
    assert.equal(readFileSync(join(base, ".sync-state.json"), "utf-8"), '{"SENTINELA":true}');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("syncMemoria: arquivo self >1MiB e pulado (nunca no POST, nunca derruba o ciclo)", async () => {
  const base = mkdtempSync(join(tmpdir(), "cmr138-big-"));
  try {
    const self42 = join(base, "caso-a", ".memoria", "42");
    mkdirSync(self42, { recursive: true });
    writeFileSync(join(self42, "ok.md"), "curtinho");
    writeFileSync(join(self42, "big.md"), "L".repeat(1024 * 1024 + 10)); // > 1 MiB

    const { deps, posts } = makeFakeApi({
      get: {
        "/memoria-manifest": { cases: {} },
        "/feedback-manifest": { authors: {} },
      },
      post: {
        "/cases/caso-a/memoria": (body) => ({ author: "42", case: "caso-a", count: body.files.length, written: body.files.map((f) => f.name) }),
      },
    });

    await syncMemoria("http://t/api", base, "42", deps);

    const memPost = posts.find((p) => p.url.endsWith("/cases/caso-a/memoria"));
    assert.ok(memPost);
    const names = memPost.body.files.map((f) => f.name);
    assert.ok(names.includes("ok.md"));
    assert.ok(!names.includes("big.md"), "arquivo >1MiB nao pode ir no POST");

    // log de skip visivel
    const log = readFileSync(join(base, ".sync.log"), "utf-8");
    assert.match(log, /big\.md/);

    // baseline: ok.md gravado (uploaded), big.md ausente
    const st = JSON.parse(readFileSync(join(base, ".memoria-state.json"), "utf-8"));
    assert.equal(st["caso-a"]["42"]["ok.md"], md5hex(Buffer.from("curtinho")));
    assert.ok(!("big.md" in st["caso-a"]["42"]));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("syncMemoria: selfAuthor null -> skip total (sem rede, sem estado)", async () => {
  const base = mkdtempSync(join(tmpdir(), "cmr138-noself-"));
  try {
    let called = false;
    const deps = {
      getJson: async () => { called = true; throw new Error("nao deveria chamar"); },
      postJson: async () => { called = true; throw new Error("nao deveria chamar"); },
    };
    await syncMemoria("http://t/api", base, null, deps);
    assert.equal(called, false);
    assert.ok(!existsSync(join(base, ".memoria-state.json")));
    const log = readFileSync(join(base, ".sync.log"), "utf-8");
    assert.match(log, /sem autor/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("syncMemoria: arquivo self rejeitado pelo server (fora de written) NAO entra no baseline", async () => {
  const base = mkdtempSync(join(tmpdir(), "cmr138-rej-"));
  try {
    const self42 = join(base, "caso-a", ".memoria", "42");
    mkdirSync(self42, { recursive: true });
    writeFileSync(join(self42, "aceito.md"), "vai passar");
    writeFileSync(join(self42, "rejeitado.md"), "server recusa");

    const { deps } = makeFakeApi({
      get: {
        "/memoria-manifest": { cases: {} },
        "/feedback-manifest": { authors: {} },
      },
      post: {
        // server aceita so aceito.md
        "/cases/caso-a/memoria": { author: "42", case: "caso-a", count: 1, written: ["aceito.md"] },
      },
    });

    await syncMemoria("http://t/api", base, "42", deps);

    const st = JSON.parse(readFileSync(join(base, ".memoria-state.json"), "utf-8"));
    assert.equal(st["caso-a"]["42"]["aceito.md"], md5hex(Buffer.from("vai passar")));
    assert.ok(!("rejeitado.md" in st["caso-a"]["42"]), "arquivo rejeitado nao pode virar baseline");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("syncMemoria: download+upload de feedback do pool (.feedback como pseudo-caso)", async () => {
  const base = mkdtempSync(join(tmpdir(), "cmr138-pool-"));
  try {
    // self=42 tem um feedback proprio ja no pool local
    const poolSelf = join(base, ".feedback", "42");
    mkdirSync(poolSelf, { recursive: true });
    writeFileSync(join(poolSelf, "feedback_meu.md"), "meu aprendizado");

    const { deps, gets, posts } = makeFakeApi({
      get: {
        "/memoria-manifest": { cases: {} },
        // pool remoto tem feedback de um peer 99 (seed) e nao tem o do self
        "/feedback-manifest": { authors: { "99": { "feedback_peer.md": "vmfb" } } },
        "/feedback/99": { files: { "feedback_peer.md": { content: "aprendizado do peer", md5: "vmfb" } } },
      },
      post: {
        "/feedback": { author: "42", count: 1, written: ["feedback_meu.md"] },
      },
    });

    await syncMemoria("http://t/api", base, "42", deps);

    // peer do pool baixado em .feedback/99/
    assert.ok(existsSync(join(base, ".feedback", "99", "feedback_peer.md")));
    // FEEDBACK.md agregado gerado
    const fb = readFileSync(join(base, ".feedback", "FEEDBACK.md"), "utf-8");
    assert.match(fb, /## Autor 99/);
    assert.match(fb, /aprendizado do peer/);
    // upload do self ao pool
    const fbPost = posts.find((p) => p.url.endsWith("/feedback") && p.body);
    assert.ok(fbPost);
    assert.deepEqual(fbPost.body.files.map((f) => f.name), ["feedback_meu.md"]);
    // baseline usa .feedback como pseudo-caso
    const st = JSON.parse(readFileSync(join(base, ".memoria-state.json"), "utf-8"));
    assert.equal(st[".feedback"]["99"]["feedback_peer.md"], "vmfb");
    assert.equal(st[".feedback"]["42"]["feedback_meu.md"], md5hex(Buffer.from("meu aprendizado")));
    // nao baixou memoria de caso nenhuma
    assert.ok(!gets.some((u) => u.includes("/cases/")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("syncMemoria: feedback sob caso ja no pool (mesmo md5) NAO re-sobe (fecha ping-pong CMR-138)", async () => {
  const base = mkdtempSync(join(tmpdir(), "cmr138-pingpong-"));
  try {
    // feedback do self vive fisicamente SOB o caso; o pool remoto JA o tem com o
    // mesmo md5 -> nao pode re-subir todo ciclo (o defeito que o gate corrige).
    const self42 = join(base, "caso-a", ".memoria", "42");
    mkdirSync(self42, { recursive: true });
    writeFileSync(join(self42, "feedback_lig.md"), "ligar pro cliente");
    const md5 = md5hex(Buffer.from("ligar pro cliente"));

    const { deps, posts } = makeFakeApi({
      get: {
        "/memoria-manifest": { cases: {} },
        "/feedback-manifest": { authors: { "42": { "feedback_lig.md": md5 } } },
        "/feedback/42": { files: { "feedback_lig.md": { content: "ligar pro cliente", md5 } } },
      },
      post: {
        "/feedback": () => { throw new Error("NAO deveria postar feedback ja sincronizado"); },
      },
    });

    await syncMemoria("http://t/api", base, "42", deps);

    // nenhum POST de feedback: o pool ja tem o mesmo conteudo.
    assert.ok(!posts.some((p) => p.url.endsWith("/feedback")), "feedback ja no pool nao pode re-subir");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
