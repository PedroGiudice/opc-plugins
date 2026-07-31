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
  isSafeMemoriaCase,
  isSafeMemoriaAuthor,
  isSafeMemoriaFile,
  md5hex,
  readMemoriaState,
  readFeedbackState,
  buildPeersIndex,
  buildFeedbackIndex,
  syncMemoria,
  postJson,
  provisionCaseSettings,
  migrateAuthorDirs,
  updateAutoMemoryDirIfAliased,
  transcriptRoots,
  isCaseTranscriptDir,
  expectedTranscriptDirPrefix,
  readBlockedDirs,
  isValidSessionId,
  listTranscriptFiles,
  alignToLineStart,
  planTranscriptUploads,
  syncTranscripts,
  TRANSCRIPT_MAX_REQUEST_BYTES,
  TRANSCRIPT_MAX_CYCLE_BYTES,
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

test("syncMemoria: selfAuthor null -> so os manifests (migracao) e skip do resto", async () => {
  const base = mkdtempSync(join(tmpdir(), "cmr138-noself-"));
  try {
    // Os 2 GETs de manifest passaram a ser feitos ANTES do gate de autor: e deles
    // que vem `aliases`, que dirige a migracao dos dirs de peers (independente de
    // haver credencial). Sem autor, o resto do ciclo (download/upload/baseline)
    // segue pulado.
    const gets = [];
    const deps = {
      getJson: async (url) => {
        gets.push(url);
        return url.includes("feedback-manifest") ? { authors: {} } : { cases: {} };
      },
      postJson: async () => { throw new Error("nao deveria chamar"); },
    };
    await syncMemoria("http://t/api", base, null, deps);
    assert.equal(gets.length, 2);
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

// ---------- CMR-138 (review adversarial): traversal via manifest forjado ----------
// Manifest e DADO REMOTO nao-confiavel. Um autor forjado `../../PWNED/x` no
// pool de feedback fazia `join(caseDir, author)` escapar de casesBase e gravar
// arquivo arbitrario na maquina cliente. O sync de briefing ja valida com
// VALID_CASE_NAME; o caminho de memoria largou o guard.

test("syncMemoria: autor forjado com path traversal NAO grava fora de casesBase (repro review)", async () => {
  const base = mkdtempSync(join(tmpdir(), "cmr138-traversal-"));
  const outside = join(base, "..", "PWNED"); // alvo do traversal (fora de base)
  try {
    // pool remoto forjado: autor com `../../PWNED/x` -> join escaparia de base.
    const { deps } = makeFakeApi({
      get: {
        "/memoria-manifest": { cases: {} },
        "/feedback-manifest": { authors: { "../../PWNED/x": { "evil.md": "hx" } } },
        // conteudo (nunca deve ser buscado nem escrito apos o fix)
        [`/feedback/${encodeURIComponent("../../PWNED/x")}`]: {
          files: { "evil.md": { content: "PWNED", md5: "hx" } },
        },
      },
      post: {},
    });

    await syncMemoria("http://t/api", base, "42", deps);

    // NADA pode ter sido escrito fora de casesBase.
    assert.ok(!existsSync(outside), "traversal gravou fora de casesBase");
    assert.ok(!existsSync(join(outside, "x", "evil.md")), "arquivo forjado materializado fora de base");
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true }); // limpa poluicao do RED, no-op pos-fix
  }
});

test("syncMemoria: caso forjado com `..` NAO cria dir fora de casesBase", async () => {
  const base = mkdtempSync(join(tmpdir(), "cmr138-caso-traversal-"));
  const outside = join(base, "..", "PWNED2");
  try {
    const { deps } = makeFakeApi({
      get: {
        // caso forjado com traversal no manifest de memoria
        "/memoria-manifest": { cases: { "../PWNED2": { "42": { "evil.md": "hx" } } } },
        "/feedback-manifest": { authors: {} },
        [`/cases/${encodeURIComponent("../PWNED2")}/memoria/42`]: {
          files: { "evil.md": { content: "PWNED", md5: "hx" } },
        },
      },
      post: {},
    });

    await syncMemoria("http://t/api", base, "42", deps);

    assert.ok(!existsSync(outside), "caso forjado escapou de casesBase");
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ---------- CMR-138: Camada 1 (planMemoriaActions descarta segmentos inseguros) ----------

test("planMemoriaActions: autor forjado `../../PWNED/x` no pool -> descartado do plano + warning", () => {
  const remote = { ".feedback": { "../../PWNED/x": { "evil.md": "hx" }, "42": { "ok.md": "hh" } } };
  const plan = planMemoriaActions(remote, {}, {}, "42");
  // o autor forjado nunca entra em downloadAuthors
  assert.ok(!plan.downloadAuthors.some((d) => d.author.includes("PWNED")), "autor forjado vazou pro plano");
  // o autor legitimo do mesmo pool segue baixando (seed)
  assert.ok(plan.downloadAuthors.some((d) => d.case === ".feedback" && d.author === "42"));
  assert.ok(plan.warnings.some((w) => /autor com nome inseguro/.test(w) && w.includes("../../PWNED/x")));
});

test("planMemoriaActions: caso com `..` ou `/` -> descartado + warning", () => {
  const remote = {
    "../evil": { "42": { "a.md": "h" } },
    "a/b": { "42": { "a.md": "h" } },
    "ok-caso": { "42": { "a.md": "h" } },
  };
  const plan = planMemoriaActions(remote, {}, {}, "42");
  assert.deepEqual(plan.downloadAuthors.map((d) => d.case), ["ok-caso"]);
  assert.equal(plan.warnings.filter((w) => /caso com nome inseguro/.test(w)).length, 2);
});

test("planMemoriaActions: arquivo `../evil.md` ou `x.txt` -> descartado + warning", () => {
  const remote = { "caso": { "42": { "../evil.md": "h1", "x.txt": "h2", "bom.md": "h3" } } };
  const plan = planMemoriaActions(remote, {}, {}, "42");
  assert.deepEqual(plan.downloadAuthors, [{ case: "caso", author: "42", files: ["bom.md"] }]);
  assert.equal(plan.warnings.filter((w) => /arquivo com nome inseguro/.test(w)).length, 2);
});

test("planMemoriaActions: caso legitimo + pool .feedback + autor 42 + nota.md -> caminho feliz intacto", () => {
  const remote = {
    "novartis-anais-prado": { "42": { "nota.md": "h1" } },
    ".feedback": { "42": { "feedback_lig.md": "h2" } },
  };
  const plan = planMemoriaActions(remote, {}, {}, "42");
  assert.deepEqual(
    plan.downloadAuthors.map((d) => `${d.case}/${d.author}/${d.files.join(",")}`).sort(),
    [".feedback/42/feedback_lig.md", "novartis-anais-prado/42/nota.md"],
  );
  assert.deepEqual(plan.warnings, []);
});

test("planMemoriaActions: upload com arquivo inseguro no estado local -> descartado + warning (camada 1)", () => {
  // defense-in-depth do lado do upload: nome de arquivo com traversal nunca vira POST.
  const local = { "caso": { "42": { "../evil.md": { md5: "x", content: "meu" }, "bom.md": { md5: "y", content: "ok" } } } };
  const plan = planMemoriaActions({}, local, {}, "42");
  assert.deepEqual(plan.uploadFiles.map((u) => u.name), ["bom.md"]);
  assert.ok(plan.warnings.some((w) => /upload: entrada com nome inseguro/.test(w)));
});

// ---------- CMR-138: Camada 2 (helpers puras de validacao de segmento) ----------

test("isSafeMemoriaCase: aceita caso valido e o pseudo-caso .feedback; rejeita traversal", () => {
  for (const ok of ["caso", "caso-a", "t1-case-novartis", ".feedback", "a.b_c-1"]) {
    assert.equal(isSafeMemoriaCase(ok), true, `deveria aceitar ${ok}`);
  }
  for (const bad of ["..", "../x", ".hidden", "a/b", "a\\b", ".", "", 42, null, undefined]) {
    assert.equal(isSafeMemoriaCase(bad), false, `deveria rejeitar ${String(bad)}`);
  }
});

test("isSafeMemoriaAuthor: aceita id/slug; rejeita `.`, `..`, `/`, `\\` e nao-string", () => {
  for (const ok of ["42", "carlos-magno", "a.b", "user_1", "X"]) {
    assert.equal(isSafeMemoriaAuthor(ok), true, `deveria aceitar ${ok}`);
  }
  for (const bad of [".", "..", "../../PWNED/x", "a/b", "a\\b", "", "x y", 7, null, undefined]) {
    assert.equal(isSafeMemoriaAuthor(bad), false, `deveria rejeitar ${String(bad)}`);
  }
});

test("isSafeMemoriaFile: aceita *.md comum; rejeita traversal, nao-.md e artefatos", () => {
  for (const ok of ["nota.md", "feedback_x.md", "recursos-agravo.md"]) {
    assert.equal(isSafeMemoriaFile(ok), true, `deveria aceitar ${ok}`);
  }
  for (const bad of ["../evil.md", "a/b.md", "a\\b.md", "x.txt", "evil", "PEERS.md", "FEEDBACK.md", "..md", "", null, undefined]) {
    assert.equal(isSafeMemoriaFile(bad), false, `deveria rejeitar ${String(bad)}`);
  }
});

// ---------- Migracao dos dirs de autor para slug legivel (author_dir) ----------

/** Semeia `<base>/<caso>/.memoria/<autor>/<arq>` com conteudo. */
function seedMem(base, caso, autor, arquivos) {
  const dir = join(base, caso, ".memoria", autor);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(arquivos)) {
    writeFileSync(join(dir, name), content, "utf-8");
  }
  return dir;
}

test("migrateAuthorDirs: rename simples quando o destino nao existe", () => {
  withCasesBase((base) => {
    seedMem(base, "caso-a", "1", { "nota.md": "minha nota" });
    const out = migrateAuthorDirs(base, { 1: "pedro-giudice" }, {});
    assert.equal(existsSync(join(base, "caso-a", ".memoria", "1")), false);
    assert.equal(
      readFileSync(join(base, "caso-a", ".memoria", "pedro-giudice", "nota.md"), "utf-8"),
      "minha nota",
    );
    assert.equal(out.renames.length, 1);
    assert.deepEqual(out.renames[0], {
      case: "caso-a",
      from: "1",
      to: "pedro-giudice",
      mode: "rename",
    });
    assert.equal(out.changed, true);
  });
});

test("migrateAuthorDirs: merge conservador — conflito preserva o destino, ausente e movido", () => {
  withCasesBase((base) => {
    seedMem(base, "caso-a", "1", { "nota.md": "versao ANTIGA", "so-no-velho.md": "unico" });
    seedMem(base, "caso-a", "pedro-giudice", { "nota.md": "versao NOVA" });

    const out = migrateAuthorDirs(base, { 1: "pedro-giudice" }, {});

    const novo = join(base, "caso-a", ".memoria", "pedro-giudice");
    // conflito: destino intocado
    assert.equal(readFileSync(join(novo, "nota.md"), "utf-8"), "versao NOVA");
    // ausente no destino: movido
    assert.equal(readFileSync(join(novo, "so-no-velho.md"), "utf-8"), "unico");
    // o dir velho sobrevive SO com o conflito (nada e destruido)
    const velho = join(base, "caso-a", ".memoria", "1");
    assert.equal(existsSync(velho), true);
    assert.deepEqual(readdirSync(velho), ["nota.md"]);
    assert.equal(readFileSync(join(velho, "nota.md"), "utf-8"), "versao ANTIGA");

    assert.equal(out.renames[0].mode, "merge");
    assert.deepEqual(out.conflicts, [
      { case: "caso-a", from: "1", to: "pedro-giudice", file: "nota.md" },
    ]);
  });
});

test("migrateAuthorDirs: merge sem conflito remove o dir velho vazio", () => {
  withCasesBase((base) => {
    seedMem(base, "caso-a", "1", { "a.md": "a" });
    seedMem(base, "caso-a", "pedro-giudice", { "b.md": "b" });
    migrateAuthorDirs(base, { 1: "pedro-giudice" }, {});
    assert.equal(existsSync(join(base, "caso-a", ".memoria", "1")), false);
    const novo = join(base, "caso-a", ".memoria", "pedro-giudice");
    assert.deepEqual(readdirSync(novo).sort(), ["a.md", "b.md"]);
  });
});

test("migrateAuthorDirs: pseudo-caso .feedback tambem migra", () => {
  withCasesBase((base) => {
    const fb = join(base, ".feedback", "6");
    mkdirSync(fb, { recursive: true });
    writeFileSync(join(fb, "aprendizado.md"), "licao", "utf-8");
    const out = migrateAuthorDirs(base, { 6: "ana-beatriz-paoli" }, {});
    assert.equal(existsSync(join(base, ".feedback", "6")), false);
    assert.equal(
      readFileSync(join(base, ".feedback", "ana-beatriz-paoli", "aprendizado.md"), "utf-8"),
      "licao",
    );
    assert.ok(out.renames.some((r) => r.case === ".feedback" && r.to === "ana-beatriz-paoli"));
  });
});

test("migrateAuthorDirs: baseline rekeyed (casos + .feedback), conteudo preservado", () => {
  withCasesBase((base) => {
    seedMem(base, "caso-a", "1", { "nota.md": "x" });
    const state = {
      "caso-a": { 1: { "nota.md": "md5a" }, 6: { "peer.md": "md5p" } },
      ".feedback": { 1: { "fb.md": "md5f" } },
      "caso-sem-dir-local": { 1: { "y.md": "md5y" } },
    };
    const out = migrateAuthorDirs(
      base,
      { 1: "pedro-giudice", 6: "ana-beatriz-paoli" },
      state,
    );
    assert.deepEqual(out.baseline, {
      "caso-a": {
        "pedro-giudice": { "nota.md": "md5a" },
        "ana-beatriz-paoli": { "peer.md": "md5p" },
      },
      ".feedback": { "pedro-giudice": { "fb.md": "md5f" } },
      "caso-sem-dir-local": { "pedro-giudice": { "y.md": "md5y" } },
    });
    // input nao e mutado
    assert.ok("1" in state["caso-a"]);
    assert.equal(out.changed, true);
  });
});

test("migrateAuthorDirs: baseline com chave nova ja presente — merge sem sobrescrever", () => {
  withCasesBase((base) => {
    const state = {
      "caso-a": {
        1: { "nota.md": "velho", "so-velho.md": "v" },
        "pedro-giudice": { "nota.md": "novo" },
      },
    };
    const out = migrateAuthorDirs(base, { 1: "pedro-giudice" }, state);
    assert.deepEqual(out.baseline["caso-a"]["pedro-giudice"], {
      "nota.md": "novo",
      "so-velho.md": "v",
    });
    assert.equal("1" in out.baseline["caso-a"], false);
  });
});

test("migrateAuthorDirs: idempotente — 2a rodada e no-op", () => {
  withCasesBase((base) => {
    seedMem(base, "caso-a", "1", { "nota.md": "x" });
    const first = migrateAuthorDirs(base, { 1: "pedro-giudice" }, { "caso-a": { 1: { "nota.md": "m" } } });
    assert.equal(first.changed, true);
    const second = migrateAuthorDirs(base, { 1: "pedro-giudice" }, first.baseline);
    assert.deepEqual(second.renames, []);
    assert.deepEqual(second.conflicts, []);
    assert.deepEqual(second.settings, []);
    assert.equal(second.changed, false);
    assert.deepEqual(second.baseline, first.baseline);
  });
});

test("migrateAuthorDirs: alias identidade, invalido ou traversal e ignorado", () => {
  withCasesBase((base) => {
    seedMem(base, "caso-a", "1", { "nota.md": "x" });
    seedMem(base, "caso-a", "2", { "y.md": "y" });
    const out = migrateAuthorDirs(
      base,
      { 1: "1", 2: "../../PWNED", 3: "", 4: null, "../x": "slug" },
      {},
    );
    assert.deepEqual(out.renames, []);
    assert.equal(existsSync(join(base, "caso-a", ".memoria", "1")), true);
    assert.equal(existsSync(join(base, "caso-a", ".memoria", "2")), true);
    assert.equal(existsSync(join(base, "PWNED")), false);
  });
});

test("migrateAuthorDirs: aliases vazio/ausente -> no-op sem erro", () => {
  withCasesBase((base) => {
    seedMem(base, "caso-a", "1", { "nota.md": "x" });
    for (const aliases of [undefined, null, {}, "nao-e-objeto"]) {
      const out = migrateAuthorDirs(base, aliases, {});
      assert.equal(out.changed, false);
      assert.deepEqual(out.renames, []);
    }
    assert.equal(existsSync(join(base, "caso-a", ".memoria", "1")), true);
  });
});

test("migrateAuthorDirs: _archive e dirs sem .memoria sao ignorados", () => {
  withCasesBase((base) => {
    seedMem(base, "_archive", "1", { "nota.md": "arquivado" });
    mkdirSync(join(base, "caso-sem-memoria"), { recursive: true });
    const out = migrateAuthorDirs(base, { 1: "pedro-giudice" }, {});
    assert.deepEqual(out.renames, []);
    assert.equal(existsSync(join(base, "_archive", ".memoria", "1")), true);
  });
});

test("migrateAuthorDirs: atualiza autoMemoryDirectory do settings.local.json de cada caso", () => {
  withCasesBase((base) => {
    seedMem(base, "caso-a", "1", { "nota.md": "x" });
    const claudeDir = join(base, "caso-a", ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const target = join(claudeDir, "settings.local.json");
    writeFileSync(
      target,
      JSON.stringify({ outputStyle: "Legal Main Agent", autoMemoryDirectory: `${base}/caso-a/.memoria/1`.replace(/\\/g, "/") }, null, 2),
      "utf-8",
    );

    const out = migrateAuthorDirs(base, { 1: "pedro-giudice" }, {});
    const settings = JSON.parse(readFileSync(target, "utf-8"));
    assert.equal(
      settings.autoMemoryDirectory,
      `${base}/caso-a/.memoria/pedro-giudice`.replace(/\\/g, "/"),
    );
    assert.equal(settings.outputStyle, "Legal Main Agent");
    assert.equal(existsSync(`${target}.bak`), true);
    assert.deepEqual(out.settings, [{ case: "caso-a", from: "1", to: "pedro-giudice" }]);
  });
});

test("migrateAuthorDirs: settings atualizado mesmo sem dir de memoria local", () => {
  withCasesBase((base) => {
    // caso existe, tem settings apontando pro dir velho, mas nunca teve memoria
    const claudeDir = join(base, "caso-b", ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const target = join(claudeDir, "settings.local.json");
    writeFileSync(target, JSON.stringify({ autoMemoryDirectory: `${base}/caso-b/.memoria/1` }, null, 2), "utf-8");
    const out = migrateAuthorDirs(base, { 1: "pedro-giudice" }, {});
    assert.deepEqual(out.renames, []);
    assert.equal(out.settings.length, 1);
    assert.equal(out.changed, true);
    assert.match(JSON.parse(readFileSync(target, "utf-8")).autoMemoryDirectory, /\/pedro-giudice$/);
  });
});

test("updateAutoMemoryDirIfAliased: so o sufixo EXATO e regravado", () => {
  withCasesBase((base) => {
    const write = (name, obj) => {
      const p = join(base, name);
      writeFileSync(p, JSON.stringify(obj, null, 2), "utf-8");
      return p;
    };
    // sufixo exato -> troca
    const ok = write("ok.json", { autoMemoryDirectory: "C:/Users/x/cases/caso-a/.memoria/1", outros: 7 });
    assert.equal(updateAutoMemoryDirIfAliased(ok, "1", "pedro-giudice"), true);
    const okOut = JSON.parse(readFileSync(ok, "utf-8"));
    assert.equal(okOut.autoMemoryDirectory, "C:/Users/x/cases/caso-a/.memoria/pedro-giudice");
    assert.equal(okOut.outros, 7);

    // prefixo do segmento (11 vs 1) NAO casa
    const p11 = write("p11.json", { autoMemoryDirectory: "/c/caso-a/.memoria/11" });
    assert.equal(updateAutoMemoryDirIfAliased(p11, "1", "pedro-giudice"), false);
    assert.equal(JSON.parse(readFileSync(p11, "utf-8")).autoMemoryDirectory, "/c/caso-a/.memoria/11");

    // valor apontando pra fora de .memoria -> intocado
    const fora = write("fora.json", { autoMemoryDirectory: "/c/outro/lugar/1" });
    assert.equal(updateAutoMemoryDirIfAliased(fora, "1", "pedro-giudice"), false);
    assert.equal(existsSync(`${fora}.bak`), false);

    // ja migrado -> no-op
    const migrado = write("migrado.json", { autoMemoryDirectory: "/c/caso-a/.memoria/pedro-giudice" });
    assert.equal(updateAutoMemoryDirIfAliased(migrado, "1", "pedro-giudice"), false);

    // sem o campo / corrompido / ausente
    const semCampo = write("sem.json", { outputStyle: "x" });
    assert.equal(updateAutoMemoryDirIfAliased(semCampo, "1", "pedro-giudice"), false);
    const corrompido = join(base, "bad.json");
    writeFileSync(corrompido, "{nao e json", "utf-8");
    assert.equal(updateAutoMemoryDirIfAliased(corrompido, "1", "pedro-giudice"), false);
    assert.equal(readFileSync(corrompido, "utf-8"), "{nao e json");
    assert.equal(updateAutoMemoryDirIfAliased(join(base, "nao-existe.json"), "1", "p"), false);
  });
});

test("syncMemoria: ciclo completo migra dirs antigos, rekeya baseline, atualiza settings e gera PEERS legivel", async () => {
  const base = mkdtempSync(join(tmpdir(), "author-dir-"));
  try {
    // self=1 (agora "pedro-giudice" pelo claim) e peer=6 ainda em dirs numericos
    seedMem(base, "caso-a", "1", { "estrategia.md": "minha estrategia" });
    seedMem(base, "caso-a", "6", { "peer.md": "nota da peer" });
    const claudeDir = join(base, "caso-a", ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, "settings.local.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ outputStyle: "Legal Main Agent", autoMemoryDirectory: `${base}/caso-a/.memoria/1`.replace(/\\/g, "/") }, null, 2),
      "utf-8",
    );
    // baseline antigo chaveado por sub
    writeFileSync(
      join(base, ".memoria-state.json"),
      JSON.stringify({ "caso-a": { 1: { "estrategia.md": md5hex(Buffer.from("minha estrategia")) }, 6: { "peer.md": md5hex(Buffer.from("nota da peer")) } } }),
      "utf-8",
    );
    writeFileSync(join(base, ".sync-state.json"), '{"SENTINELA":true}', "utf-8");

    const aliases = { 1: "pedro-giudice", 6: "ana-beatriz-paoli" };
    const { deps } = makeFakeApi({
      get: {
        // pos-rename no server: manifest ja fala em slugs
        "/memoria-manifest": {
          cases: { "caso-a": { "ana-beatriz-paoli": { "peer.md": md5hex(Buffer.from("nota da peer")) } } },
          aliases,
        },
        "/feedback-manifest": { authors: {}, aliases },
      },
      post: {
        "/cases/caso-a/memoria": (body) => ({ author: "pedro-giudice", case: "caso-a", count: body.files.length, written: body.files.map((f) => f.name) }),
      },
    });

    await syncMemoria("http://t/api", base, "pedro-giudice", deps);

    const memDir = join(base, "caso-a", ".memoria");
    assert.equal(existsSync(join(memDir, "1")), false);
    assert.equal(existsSync(join(memDir, "6")), false);
    assert.equal(readFileSync(join(memDir, "pedro-giudice", "estrategia.md"), "utf-8"), "minha estrategia");
    assert.equal(readFileSync(join(memDir, "ana-beatriz-paoli", "peer.md"), "utf-8"), "nota da peer");

    // PEERS.md legivel: heading com o slug, e sem o self
    const peers = readFileSync(join(memDir, "PEERS.md"), "utf-8");
    assert.match(peers, /## Autor ana-beatriz-paoli/);
    assert.ok(!peers.includes("## Autor 6"));
    assert.ok(!peers.includes("## Autor pedro-giudice"));

    // baseline rekeyed (e nao re-sobe nem re-baixa nada: local == VM)
    const st = JSON.parse(readFileSync(join(base, ".memoria-state.json"), "utf-8"));
    assert.ok("pedro-giudice" in st["caso-a"]);
    assert.ok("ana-beatriz-paoli" in st["caso-a"]);
    assert.ok(!("1" in st["caso-a"]));
    assert.ok(!("6" in st["caso-a"]));

    // settings apontando pro dir novo
    assert.equal(
      JSON.parse(readFileSync(settingsPath, "utf-8")).autoMemoryDirectory,
      `${base}/caso-a/.memoria/pedro-giudice`.replace(/\\/g, "/"),
    );

    // invariante dura: .sync-state.json intocado
    assert.equal(readFileSync(join(base, ".sync-state.json"), "utf-8"), '{"SENTINELA":true}');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("syncMemoria: migracao roda SEM selfAuthor (dirs de peers migram; upload segue pulado)", async () => {
  const base = mkdtempSync(join(tmpdir(), "author-dir-noself-"));
  try {
    seedMem(base, "caso-a", "6", { "peer.md": "nota da peer" });
    const aliases = { 1: "pedro-giudice", 6: "ana-beatriz-paoli" };
    const { deps, posts } = makeFakeApi({
      get: {
        "/memoria-manifest": { cases: {}, aliases },
        "/feedback-manifest": { authors: {}, aliases },
      },
    });

    await syncMemoria("http://t/api", base, null, deps);

    assert.equal(existsSync(join(base, "caso-a", ".memoria", "6")), false);
    assert.equal(
      readFileSync(join(base, "caso-a", ".memoria", "ana-beatriz-paoli", "peer.md"), "utf-8"),
      "nota da peer",
    );
    assert.deepEqual(posts, []);
    const log = readFileSync(join(base, ".sync.log"), "utf-8");
    assert.match(log, /sem autor/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("syncMemoria: manifest indisponivel -> nenhuma migracao (sem aliases nao ha o que dirigir)", async () => {
  const base = mkdtempSync(join(tmpdir(), "author-dir-nomanifest-"));
  try {
    seedMem(base, "caso-a", "1", { "nota.md": "x" });
    const deps = { getJson: async () => { throw new Error("401"); }, postJson: async () => { throw new Error("nao"); } };
    await syncMemoria("http://t/api", base, "pedro-giudice", deps);
    assert.equal(existsSync(join(base, "caso-a", ".memoria", "1")), true);
    const log = readFileSync(join(base, ".sync.log"), "utf-8");
    assert.match(log, /erro manifest/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("migrateAuthorDirs: duplicata byte-identica no destino e removida da origem (janela do rename do server)", () => {
  withCasesBase((base) => {
    // Estado real pos-rename no server: o client baixou o dir novo como "peer"
    // e o dir antigo ficou com copia IDENTICA do mesmo arquivo.
    seedMem(base, "caso-a", "1", { "nota.md": "mesmo conteudo", "divergente.md": "versao A" });
    seedMem(base, "caso-a", "pedro-giudice", { "nota.md": "mesmo conteudo", "divergente.md": "versao B" });

    const out = migrateAuthorDirs(base, { 1: "pedro-giudice" }, {});

    const novo = join(base, "caso-a", ".memoria", "pedro-giudice");
    const velho = join(base, "caso-a", ".memoria", "1");
    // destino intocado nos dois casos
    assert.equal(readFileSync(join(novo, "nota.md"), "utf-8"), "mesmo conteudo");
    assert.equal(readFileSync(join(novo, "divergente.md"), "utf-8"), "versao B");
    // identico sumiu da origem; divergente permanece (conflito real)
    assert.deepEqual(readdirSync(velho), ["divergente.md"]);
    assert.deepEqual(out.conflicts, [
      { case: "caso-a", from: "1", to: "pedro-giudice", file: "divergente.md" },
    ]);
  });
});

test("migrateAuthorDirs: dir antigo 100% duplicado some por completo (2a rodada no-op)", () => {
  withCasesBase((base) => {
    seedMem(base, "caso-a", "1", { "nota.md": "igual", "outra.md": "igual2" });
    seedMem(base, "caso-a", "pedro-giudice", { "nota.md": "igual", "outra.md": "igual2" });
    const first = migrateAuthorDirs(base, { 1: "pedro-giudice" }, {});
    assert.equal(existsSync(join(base, "caso-a", ".memoria", "1")), false);
    assert.deepEqual(first.conflicts, []);
    const second = migrateAuthorDirs(base, { 1: "pedro-giudice" }, first.baseline);
    assert.deepEqual(second.renames, []);
    assert.equal(second.changed, false);
  });
});

// ---------- CMR-135 Task 9: uploader de transcripts ----------

test("transcriptRoots: <home>/.claude/projects nas duas plataformas", () => {
  assert.deepEqual(transcriptRoots("C:\\Users\\pedro", "win32"), [
    join("C:\\Users\\pedro", ".claude", "projects"),
  ]);
  assert.deepEqual(transcriptRoots("/home/opc", "linux"), [
    join("/home/opc", ".claude", "projects"),
  ]);
});

test("expectedTranscriptDirPrefix: encode do path absoluto no formato do CC", () => {
  assert.equal(expectedTranscriptDirPrefix("C:\\Users\\pedro\\cases"), "C--Users-pedro-cases-");
  assert.equal(expectedTranscriptDirPrefix("C:\\Users\\pedro\\cases\\"), "C--Users-pedro-cases-");
  assert.equal(expectedTranscriptDirPrefix("/home/opc/case-docs/cases"), "-home-opc-case-docs-cases-");
  // tudo que nao e alfanumerico vira `-` (o CC faz isso com `_`, espaco e acento)
  assert.equal(expectedTranscriptDirPrefix("/home/op c/meus_casos"), "-home-op-c-meus-casos-");
  assert.equal(expectedTranscriptDirPrefix(""), "");
});

test("isCaseTranscriptDir: prefixo derivado do casesBase, nao substring", () => {
  const win = expectedTranscriptDirPrefix("C:\\Users\\pedro\\cases");
  const nix = expectedTranscriptDirPrefix("/home/opc/case-docs/cases");

  assert.equal(isCaseTranscriptDir("-home-opc-case-docs-cases-bianka-salesforce", nix, "linux"), true);
  assert.equal(isCaseTranscriptDir("C--Users-pedro-cases-novartis", win, "win32"), true);
  // NTFS e case-insensitive: caixa divergente nao pode desabilitar o filtro
  assert.equal(isCaseTranscriptDir("c--users-PEDRO-cases-novartis", win, "win32"), true);
  assert.equal(isCaseTranscriptDir("c--users-pedro-cases-novartis", nix, "linux"), false);

  // sessoes pessoais/dev NUNCA sobem
  assert.equal(isCaseTranscriptDir("-home-opc-legal-cogmem", nix, "linux"), false);
  // a raiz da base (sessao aberta em cases/) nao e um caso
  assert.equal(isCaseTranscriptDir("-home-opc-case-docs-cases", nix, "linux"), false);
  // classe de bug do substring: outro dir com `cases` no caminho nao sobe
  assert.equal(isCaseTranscriptDir("-home-opc-foo-cases-lib-src", nix, "linux"), false);
  assert.equal(isCaseTranscriptDir("-tmp-cases-qualquer", nix, "linux"), false);
  // fail-closed: sem prefixo, nada e elegivel
  assert.equal(isCaseTranscriptDir("-home-opc-case-docs-cases-alpha", "", "linux"), false);
  assert.equal(isCaseTranscriptDir("", nix, "linux"), false);
});

test("isValidSessionId: alfabeto fechado do servidor", () => {
  assert.equal(isValidSessionId("2155ea8d-2969-432a-8993-3bcbb595fcc7"), true);
  assert.equal(isValidSessionId("a.b_c-1"), true);
  assert.equal(isValidSessionId(""), false);
  assert.equal(isValidSessionId("com espaco"), false);
  assert.equal(isValidSessionId("../evil"), false);
  assert.equal(isValidSessionId("x".repeat(129)), false);
  assert.equal(isValidSessionId(null), false);
});

/** Cria <root>/<dir>/<sessao>.jsonl com `linhas` (uma por turno) e devolve o path. */
function seedTranscript(root, dir, sessao, linhas) {
  const d = join(root, dir);
  mkdirSync(d, { recursive: true });
  const p = join(d, `${sessao}.jsonl`);
  writeFileSync(p, linhas.join("\n") + "\n");
  return p;
}

test("listTranscriptFiles: so .jsonl de dirs -cases-; sessionId = basename; root ausente -> []", () => {
  const root = mkdtempSync(join(tmpdir(), "cmr135-list-"));
  try {
    seedTranscript(root, "-home-opc-case-docs-cases-alpha", "sess-1", ['{"a":1}']);
    seedTranscript(root, "-home-opc-legal-cogmem", "sess-dev", ['{"a":1}']);
    writeFileSync(join(root, "-home-opc-case-docs-cases-alpha", "nota.txt"), "x");

    const files = listTranscriptFiles([root, join(root, "nao-existe")], "-home-opc-case-docs-cases-");
    assert.equal(files.length, 1);
    assert.equal(files[0].sessionId, "sess-1");
    assert.ok(files[0].path.endsWith("sess-1.jsonl"));
    assert.equal(files[0].size, Buffer.byteLength('{"a":1}\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("alignToLineStart: recua ate o inicio da linha do offset; offset ja alinhado nao move", () => {
  const dir = mkdtempSync(join(tmpdir(), "cmr135-align-"));
  try {
    const p = join(dir, "t.jsonl");
    writeFileSync(p, "aaaa\nbbbb\ncccc\n"); // \n em 4, 9, 14
    assert.equal(alignToLineStart(p, 0), 0);
    assert.equal(alignToLineStart(p, 5), 5); // ja e inicio de linha
    assert.equal(alignToLineStart(p, 7), 5); // meio de "bbbb" -> volta pro inicio
    assert.equal(alignToLineStart(p, 12), 10);
    assert.equal(alignToLineStart(p, 3), 0); // primeira linha
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("alignToLineStart: lookback limita o recuo (garante progresso)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cmr135-align2-"));
  try {
    const p = join(dir, "t.jsonl");
    writeFileSync(p, "x".repeat(500) + "\n"); // 1 linha gigante, sem \n antes
    // lookback 10: nao acha \n na janela e NAO recua (progresso garantido)
    assert.equal(alignToLineStart(p, 400, 10), 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planTranscriptUploads: arquivo novo sobe inteiro; ja sincronizado nao entra", () => {
  const root = mkdtempSync(join(tmpdir(), "cmr135-plan-"));
  try {
    const p = seedTranscript(root, "-x-cases-a", "s1", ['{"n":1}', '{"n":2}']);
    const size = statSync(p).size;
    const novo = planTranscriptUploads([{ path: p, sessionId: "s1", size }], {});
    assert.deepEqual(novo, [{ path: p, sessionId: "s1", from: 0, to: size }]);
    assert.deepEqual(planTranscriptUploads([{ path: p, sessionId: "s1", size }], { [p]: size }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planTranscriptUploads: delta alinhado a linha (overlap absorvido pelo dedupe)", () => {
  const root = mkdtempSync(join(tmpdir(), "cmr135-plan2-"));
  try {
    const p = seedTranscript(root, "-x-cases-a", "s1", ["aaaa", "bbbb", "cccc"]);
    const size = statSync(p).size; // 15
    // offset salvo no MEIO de "bbbb" (7) -> recua pro inicio da linha (5)
    const plan = planTranscriptUploads([{ path: p, sessionId: "s1", size }], { [p]: 7 });
    assert.deepEqual(plan, [{ path: p, sessionId: "s1", from: 5, to: size }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planTranscriptUploads: truncamento (size < offset) reseta from=0", () => {
  const root = mkdtempSync(join(tmpdir(), "cmr135-plan3-"));
  try {
    const p = seedTranscript(root, "-x-cases-a", "s1", ["aaaa"]);
    const size = statSync(p).size; // 5
    const plan = planTranscriptUploads([{ path: p, sessionId: "s1", size }], { [p]: 99999 });
    assert.deepEqual(plan, [{ path: p, sessionId: "s1", from: 0, to: size }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planTranscriptUploads: arquivo maior que o cap -> janela por ciclo, continua no proximo", () => {
  const root = mkdtempSync(join(tmpdir(), "cmr135-plan4-"));
  try {
    // 10 linhas de 10 bytes ("012345678\n") = 100 bytes
    const p = seedTranscript(root, "-x-cases-a", "s1", Array.from({ length: 10 }, () => "012345678"));
    const size = statSync(p).size; // 100
    const caps = { maxRequestBytes: 40, maxCycleBytes: 1000 };
    const file = { path: p, sessionId: "s1", size };

    const c1 = planTranscriptUploads([file], {}, caps);
    assert.deepEqual(c1, [{ path: p, sessionId: "s1", from: 0, to: 40 }]);
    // ciclo 2 continua do offset salvo, alinhando a linha (40 ja e inicio de linha)
    const c2 = planTranscriptUploads([file], { [p]: 40 }, caps);
    assert.deepEqual(c2, [{ path: p, sessionId: "s1", from: 40, to: 80 }]);
    const c3 = planTranscriptUploads([file], { [p]: 80 }, caps);
    assert.deepEqual(c3, [{ path: p, sessionId: "s1", from: 80, to: 100 }]);
    assert.deepEqual(planTranscriptUploads([file], { [p]: 100 }, caps), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planTranscriptUploads: cap de ciclo corta o total enviado (resto no proximo ciclo)", () => {
  const root = mkdtempSync(join(tmpdir(), "cmr135-plan5-"));
  try {
    const linhas = Array.from({ length: 10 }, () => "012345678"); // 100 bytes
    const a = seedTranscript(root, "-x-cases-a", "s1", linhas);
    const b = seedTranscript(root, "-x-cases-b", "s2", linhas);
    const c = seedTranscript(root, "-x-cases-c", "s3", linhas);
    const files = [
      { path: a, sessionId: "s1", size: 100 },
      { path: b, sessionId: "s2", size: 100 },
      { path: c, sessionId: "s3", size: 100 },
    ];
    const plan = planTranscriptUploads(files, {}, { maxRequestBytes: 40, maxCycleBytes: 90 });
    // 40 + 40 = 80; sobra 10 para o terceiro
    assert.deepEqual(plan.map((w) => [w.sessionId, w.from, w.to]), [
      ["s1", 0, 40],
      ["s2", 0, 40],
      ["s3", 0, 10],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("caps default do uploader: 3 MiB por request, 12 MiB por ciclo", () => {
  assert.equal(TRANSCRIPT_MAX_REQUEST_BYTES, 3 * 1024 * 1024);
  assert.equal(TRANSCRIPT_MAX_CYCLE_BYTES, 12 * 1024 * 1024);
});

// --- wiring ---

/** deps padrao de syncTranscripts com postFn colecionavel. */
function fakeUploader(postImpl) {
  const posts = [];
  return {
    posts,
    deps: {
      dirPrefix: "-x-cases-",
      readCredential: () => ({ access_jwt: "jwt-fake" }),
      postTranscript: async (url, body) => {
        posts.push({ url, body });
        return postImpl ? postImpl(posts.length, body) : { ok: true, status: 200, json: { status: "ok", captured: 1, total_turns: 1, skipped: false } };
      },
    },
  };
}

test("syncTranscripts: 2xx -> POST com session_id+jsonl, offset persistido, estados vizinhos intocados", async () => {
  const base = mkdtempSync(join(tmpdir(), "cmr135-w1-"));
  const home = mkdtempSync(join(tmpdir(), "cmr135-h1-"));
  try {
    writeFileSync(join(base, ".sync-state.json"), '{"SENTINELA":true}');
    writeFileSync(join(base, ".memoria-state.json"), '{"SENTINELA":true}');
    const root = join(home, ".claude", "projects");
    const p = seedTranscript(root, "-x-cases-alpha", "sess-1", ['{"type":"user","cwd":"/x/cases/alpha"}']);
    const size = statSync(p).size;

    const { deps, posts } = fakeUploader();
    await syncTranscripts("http://t/api", base, { ...deps, roots: [root] });

    assert.equal(posts.length, 1);
    assert.ok(posts[0].url.endsWith("/ingest-transcript"));
    assert.equal(posts[0].body.session_id, "sess-1");
    assert.ok(posts[0].body.jsonl.includes('"cwd":"/x/cases/alpha"'));

    const st = JSON.parse(readFileSync(join(base, ".transcripts-state.json"), "utf-8"));
    assert.equal(st[p], size);
    assert.equal(readFileSync(join(base, ".sync-state.json"), "utf-8"), '{"SENTINELA":true}');
    assert.equal(readFileSync(join(base, ".memoria-state.json"), "utf-8"), '{"SENTINELA":true}');
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("syncTranscripts: 500 (captura parcial) NAO avanca o offset", async () => {
  const base = mkdtempSync(join(tmpdir(), "cmr135-w2-"));
  const home = mkdtempSync(join(tmpdir(), "cmr135-h2-"));
  try {
    const root = join(home, ".claude", "projects");
    seedTranscript(root, "-x-cases-alpha", "sess-1", ['{"type":"user","cwd":"/x/cases/alpha"}']);

    const { deps, posts } = fakeUploader(() => ({
      ok: false,
      status: 500,
      json: { error: "captura parcial: 3 falhas" },
      text: '{"error":"captura parcial: 3 falhas"}',
    }));
    await syncTranscripts("http://t/api", base, { ...deps, roots: [root] });

    assert.equal(posts.length, 1);
    assert.ok(!existsSync(join(base, ".transcripts-state.json")), "offset nao pode avancar em 500");
    assert.match(readFileSync(join(base, ".sync.log"), "utf-8"), /transcripts: HTTP 500/);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("syncTranscripts: 413 em TEXTO (nao-JSON) e tratado como falha, sem crash", async () => {
  const base = mkdtempSync(join(tmpdir(), "cmr135-w3-"));
  const home = mkdtempSync(join(tmpdir(), "cmr135-h3-"));
  try {
    const root = join(home, ".claude", "projects");
    seedTranscript(root, "-x-cases-alpha", "sess-1", ['{"type":"user","cwd":"/x/cases/alpha"}']);
    const { deps } = fakeUploader(() => ({ ok: false, status: 413, json: null, text: "length limit exceeded" }));
    await syncTranscripts("http://t/api", base, { ...deps, roots: [root] });
    assert.ok(!existsSync(join(base, ".transcripts-state.json")));
    assert.match(readFileSync(join(base, ".sync.log"), "utf-8"), /transcripts: HTTP 413/);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("syncTranscripts: kill no meio do ciclo preserva o que ja foi postado", async () => {
  const base = mkdtempSync(join(tmpdir(), "cmr135-w4-"));
  const home = mkdtempSync(join(tmpdir(), "cmr135-h4-"));
  try {
    const root = join(home, ".claude", "projects");
    const a = seedTranscript(root, "-x-cases-alpha", "sess-a", ['{"type":"user","cwd":"/x/cases/alpha"}']);
    const b = seedTranscript(root, "-x-cases-beta", "sess-b", ['{"type":"user","cwd":"/x/cases/beta"}']);

    // 1o POST ok; 2o simula o kill do scheduler (5 min de ExecutionTimeLimit)
    const { deps } = fakeUploader((n) => {
      if (n === 1) return { ok: true, status: 200, json: { status: "ok", captured: 1, total_turns: 1 } };
      throw new Error("processo morto no meio do ciclo");
    });
    await syncTranscripts("http://t/api", base, { ...deps, roots: [root] });

    const st = JSON.parse(readFileSync(join(base, ".transcripts-state.json"), "utf-8"));
    const [primeiro, segundo] = [a, b].sort();
    assert.equal(st[primeiro], statSync(primeiro).size, "o arquivo ja postado tem offset persistido");
    assert.ok(!(segundo in st), "o arquivo interrompido nao avanca");
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("syncTranscripts: sem credencial -> 1 log e skip (nenhum POST)", async () => {
  const base = mkdtempSync(join(tmpdir(), "cmr135-w5-"));
  const home = mkdtempSync(join(tmpdir(), "cmr135-h5-"));
  try {
    const root = join(home, ".claude", "projects");
    seedTranscript(root, "-x-cases-alpha", "sess-1", ['{"type":"user","cwd":"/x/cases/alpha"}']);
    const posts = [];
    await syncTranscripts("http://t/api", base, {
      roots: [root],
      dirPrefix: "-x-cases-",
      readCredential: () => null,
      postTranscript: async (url, body) => { posts.push({ url, body }); return { ok: true, status: 200, json: {} }; },
    });
    assert.equal(posts.length, 0);
    const log = readFileSync(join(base, ".sync.log"), "utf-8");
    assert.match(log, /transcripts: sem credencial/);
    assert.equal(log.trim().split("\n").length, 1, "exatamente 1 linha de log");
    assert.ok(!existsSync(join(base, ".transcripts-state.json")));
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("syncTranscripts: session_id invalido e pulado com log (nunca vira POST)", async () => {
  const base = mkdtempSync(join(tmpdir(), "cmr135-w6-"));
  const home = mkdtempSync(join(tmpdir(), "cmr135-h6-"));
  try {
    const root = join(home, ".claude", "projects");
    seedTranscript(root, "-x-cases-alpha", "sess com espaco", ['{"type":"user","cwd":"/x/cases/alpha"}']);
    seedTranscript(root, "-x-cases-alpha", "sess-ok", ['{"type":"user","cwd":"/x/cases/alpha"}']);
    const { deps, posts } = fakeUploader();
    await syncTranscripts("http://t/api", base, { ...deps, roots: [root] });
    assert.deepEqual(posts.map((p) => p.body.session_id), ["sess-ok"]);
    assert.match(readFileSync(join(base, ".sync.log"), "utf-8"), /session_id invalido/);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("syncTranscripts: 200 skipped (sessao fora de caso) avanca o offset sem re-enviar", async () => {
  const base = mkdtempSync(join(tmpdir(), "cmr135-w7-"));
  const home = mkdtempSync(join(tmpdir(), "cmr135-h7-"));
  try {
    const root = join(home, ".claude", "projects");
    const p = seedTranscript(root, "-x-cases-alpha", "sess-1", ['{"type":"assistant","message":{}}']);
    const { deps, posts } = fakeUploader(() => ({
      ok: true, status: 200, json: { status: "ok", captured: 0, total_turns: 0, skipped: true },
    }));
    await syncTranscripts("http://t/api", base, { ...deps, roots: [root] });
    assert.equal(posts.length, 1);
    const st = JSON.parse(readFileSync(join(base, ".transcripts-state.json"), "utf-8"));
    assert.equal(st[p], statSync(p).size);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("syncTranscripts: nada novo -> nenhum POST e nenhuma escrita de estado", async () => {
  const base = mkdtempSync(join(tmpdir(), "cmr135-w8-"));
  const home = mkdtempSync(join(tmpdir(), "cmr135-h8-"));
  try {
    const root = join(home, ".claude", "projects");
    const p = seedTranscript(root, "-x-cases-alpha", "sess-1", ['{"type":"user","cwd":"/x/cases/alpha"}']);
    writeFileSync(join(base, ".transcripts-state.json"), JSON.stringify({ [p]: statSync(p).size }));
    const { deps, posts } = fakeUploader();
    await syncTranscripts("http://t/api", base, { ...deps, roots: [root] });
    assert.equal(posts.length, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// --- bloqueio POR DIRETORIO com TTL ---

test("readBlockedDirs: normaliza o formato novo e DESCARTA o antigo (por arquivo)", () => {
  assert.deepEqual(readBlockedDirs({}), {});
  assert.deepEqual(readBlockedDirs({ __blocked: "lixo" }), {});
  // formato v0.15.1: path -> size numerico. Migracao = descarte.
  assert.deepEqual(readBlockedDirs({ __blocked: { "C:\\x\\y.jsonl": 1234 } }), {});
  const novo = { "-x-cases-a": { ts: 10, status: 403 } };
  assert.deepEqual(readBlockedDirs({ __blocked: novo }), novo);
});

test("planTranscriptUploads: dir bloqueado sai INTEIRO do plano dentro do TTL", () => {
  const root = mkdtempSync(join(tmpdir(), "cmr135-blk1-"));
  try {
    const a = seedTranscript(root, "-x-cases-ruim", "s1", ['{"n":1}']);
    const b = seedTranscript(root, "-x-cases-ruim", "s2", ['{"n":2}']);
    const c = seedTranscript(root, "-x-cases-bom", "s3", ['{"n":3}']);
    const files = [
      { path: a, sessionId: "s1", size: statSync(a).size },
      { path: b, sessionId: "s2", size: statSync(b).size },
      { path: c, sessionId: "s3", size: statSync(c).size },
    ];
    const agora = 1_000_000_000;
    const state = { __blocked: { "-x-cases-ruim": { ts: agora - 60_000, status: 403 } } };
    const plan = planTranscriptUploads(files, state, {}, agora);
    assert.deepEqual(plan.map((w) => w.sessionId), ["s3"], "os DOIS arquivos do dir bloqueado ficam fora");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planTranscriptUploads: TTL expirado libera UMA sonda por dir", () => {
  const root = mkdtempSync(join(tmpdir(), "cmr135-blk2-"));
  try {
    const a = seedTranscript(root, "-x-cases-ruim", "s1", ['{"n":1}']);
    const b = seedTranscript(root, "-x-cases-ruim", "s2", ['{"n":2}']);
    const files = [
      { path: a, sessionId: "s1", size: statSync(a).size },
      { path: b, sessionId: "s2", size: statSync(b).size },
    ];
    const agora = 1_000_000_000;
    const seisHorasEUm = 6 * 60 * 60 * 1000 + 1;
    const state = { __blocked: { "-x-cases-ruim": { ts: agora - seisHorasEUm, status: 400 } } };
    const plan = planTranscriptUploads(files, state, {}, agora);
    assert.deepEqual(plan.map((w) => w.sessionId), ["s1"], "exatamente 1 sonda por dir");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncTranscripts: 400 bloqueia o DIR (1 request para 2 arquivos) e o ciclo seguinte nao tenta", async () => {
  const base = mkdtempSync(join(tmpdir(), "cmr135-w9-"));
  const home = mkdtempSync(join(tmpdir(), "cmr135-h9-"));
  try {
    const root = join(home, ".claude", "projects");
    seedTranscript(root, "-x-cases-analise de relatorios", "sess-1", ['{"type":"user","cwd":"/x/cases/x y"}']);
    seedTranscript(root, "-x-cases-analise de relatorios", "sess-2", ['{"type":"user","cwd":"/x/cases/x y"}']);
    const { deps, posts } = fakeUploader(() => ({
      ok: false, status: 400, json: { status: "error", message: "slug de caso invalido" }, text: "{}",
    }));
    await syncTranscripts("http://t/api", base, { ...deps, roots: [root] });

    assert.equal(posts.length, 1, "o 2o arquivo do MESMO dir nao gasta request");
    const st = JSON.parse(readFileSync(join(base, ".transcripts-state.json"), "utf-8"));
    assert.equal(Object.keys(st).filter((k) => k !== "__blocked").length, 0, "nenhum offset avanca");
    const blk = st.__blocked["-x-cases-analise de relatorios"];
    assert.equal(blk.status, 400);
    assert.ok(typeof blk.ts === "number" && blk.ts > 0);
    const log = readFileSync(join(base, ".sync.log"), "utf-8");
    assert.match(log, /dir -x-cases-analise de relatorios bloqueado por 6h \(recusa 400\)/);
    assert.match(log, /transcripts: erros janelas=0 capturados=0 falhas=1 bloqueados=1/);

    await syncTranscripts("http://t/api", base, { ...deps, roots: [root] });
    assert.equal(posts.length, 1, "dentro do TTL nem sonda sai");
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("syncTranscripts: 403 tambem bloqueia o dir (posse e propriedade do diretorio)", async () => {
  const base = mkdtempSync(join(tmpdir(), "cmr135-w10-"));
  const home = mkdtempSync(join(tmpdir(), "cmr135-h10-"));
  try {
    const root = join(home, ".claude", "projects");
    seedTranscript(root, "-x-cases-spike", "sess-1", ['{"type":"user","cwd":"/x/cases/spike"}']);
    const { deps } = fakeUploader(() => ({
      ok: false, status: 403, json: { error: "caso nao pertence ao tenant" }, text: "{}",
    }));
    await syncTranscripts("http://t/api", base, { ...deps, roots: [root] });
    const st = JSON.parse(readFileSync(join(base, ".transcripts-state.json"), "utf-8"));
    assert.equal(st.__blocked["-x-cases-spike"].status, 403);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("syncTranscripts: sonda aceita (2xx) desbloqueia o dir", async () => {
  const base = mkdtempSync(join(tmpdir(), "cmr135-w11-"));
  const home = mkdtempSync(join(tmpdir(), "cmr135-h11-"));
  try {
    const root = join(home, ".claude", "projects");
    const p = seedTranscript(root, "-x-cases-alpha", "sess-1", ['{"type":"user","cwd":"/x/cases/alpha"}']);
    // bloqueio VENCIDO -> a sonda sai
    writeFileSync(
      join(base, ".transcripts-state.json"),
      JSON.stringify({ __blocked: { "-x-cases-alpha": { ts: Date.now() - 7 * 60 * 60 * 1000, status: 403 } } }),
    );
    const { deps, posts } = fakeUploader();
    await syncTranscripts("http://t/api", base, { ...deps, roots: [root] });
    assert.equal(posts.length, 1);
    const st = JSON.parse(readFileSync(join(base, ".transcripts-state.json"), "utf-8"));
    assert.equal(st[p], statSync(p).size);
    assert.deepEqual(st.__blocked, {});
    assert.match(readFileSync(join(base, ".sync.log"), "utf-8"), /desbloqueado \(sonda aceita\)/);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("syncTranscripts: 401 LANCA (contrato real do requestWithAuth) -> falha sem bloqueio", async () => {
  const base = mkdtempSync(join(tmpdir(), "cmr135-w12-"));
  const home = mkdtempSync(join(tmpdir(), "cmr135-h12-"));
  try {
    const root = join(home, ".claude", "projects");
    seedTranscript(root, "-x-cases-alpha", "sess-1", ['{"type":"user","cwd":"/x/cases/alpha"}']);
    // requestWithAuth LANCA nesse caminho; nao devolve {ok:false,status:401}
    const { deps, posts } = fakeUploader(() => {
      throw new Error("Nao autorizado (401) apos refresh. Rode: node <plugin>/server.mjs login");
    });
    await syncTranscripts("http://t/api", base, { ...deps, roots: [root] });
    const st1 = existsSync(join(base, ".transcripts-state.json"))
      ? JSON.parse(readFileSync(join(base, ".transcripts-state.json"), "utf-8"))
      : {};
    assert.deepEqual(readBlockedDirs(st1), {}, "401 nunca bloqueia");
    const log = readFileSync(join(base, ".sync.log"), "utf-8");
    assert.match(log, /erro no POST sess-1: Nao autorizado \(401\) apos refresh/);
    assert.match(log, /transcripts: erros janelas=0 capturados=0 falhas=1/);

    // proximo ciclo continua tentando (transitorio)
    await syncTranscripts("http://t/api", base, { ...deps, roots: [root] });
    assert.equal(posts.length, 2);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("syncTranscripts: poda offsets de arquivos que sumiram do disco", async () => {
  const base = mkdtempSync(join(tmpdir(), "cmr135-w13-"));
  const home = mkdtempSync(join(tmpdir(), "cmr135-h13-"));
  try {
    const root = join(home, ".claude", "projects");
    const p = seedTranscript(root, "-x-cases-alpha", "sess-1", ['{"type":"user","cwd":"/x/cases/alpha"}']);
    const fantasma = join(root, "-x-cases-alpha", "sumiu.jsonl");
    writeFileSync(
      join(base, ".transcripts-state.json"),
      JSON.stringify({ [p]: statSync(p).size, [fantasma]: 999 }),
    );
    const { deps, posts } = fakeUploader();
    await syncTranscripts("http://t/api", base, { ...deps, roots: [root] });
    assert.equal(posts.length, 0, "nada novo a enviar");
    const st = JSON.parse(readFileSync(join(base, ".transcripts-state.json"), "utf-8"));
    assert.equal(st[fantasma], undefined, "entrada morta podada");
    assert.equal(st[p], statSync(p).size, "entrada viva preservada");
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
