import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isWorkdocPath,
  conflictPath,
  planWorkdocsSync,
  computeWorkdocsBaseline,
  planWorkdocUploadBatches,
  WORKDOC_MAX_FILE_BYTES,
  WORKDOC_MAX_BATCH_BYTES,
  WORKDOC_MAX_TICK_BYTES,
} from "./workdocs.mjs";

// ---------- allowlist (espelho do servidor) ----------

test("isWorkdocPath: aceita .md e .py na raiz e em subpasta", () => {
  assert.equal(isWorkdocPath("pesquisa.md"), true);
  assert.equal(isWorkdocPath("scripts/gerar_peca.py"), true);
  assert.equal(isWorkdocPath("notas/2026/apelacao.md"), true);
});

test("isWorkdocPath: rejeita os 3 arquivos de briefing (trilho proprio)", () => {
  assert.equal(isWorkdocPath("CLAUDE.md"), false);
  assert.equal(isWorkdocPath("case.yaml"), false);
  assert.equal(isWorkdocPath("documentos.yaml"), false);
});

test("isWorkdocPath: rejeita autos e derivados do pipeline", () => {
  assert.equal(isWorkdocPath("base/x.md"), false);
  assert.equal(isWorkdocPath("base_classifier/x.md"), false);
  assert.equal(isWorkdocPath("_archive/x.md"), false);
});

test("isWorkdocPath: rejeita dotfile/dot-dir em qualquer segmento", () => {
  assert.equal(isWorkdocPath(".memoria/a/x.md"), false);
  assert.equal(isWorkdocPath("a/.claude/x.md"), false);
  assert.equal(isWorkdocPath(".oculto.md"), false);
  assert.equal(isWorkdocPath("a/b/.x.py"), false);
});

test("isWorkdocPath: rejeita opt-out *.local.md / *.local.py", () => {
  assert.equal(isWorkdocPath("rascunho.local.md"), false);
  assert.equal(isWorkdocPath("notas/util.local.py"), false);
});

test("isWorkdocPath: rejeita extensao fora da allowlist", () => {
  assert.equal(isWorkdocPath("peca.docx"), false);
  assert.equal(isWorkdocPath("planilha.xlsx"), false);
  assert.equal(isWorkdocPath("notas/relatorio.pdf"), false);
  assert.equal(isWorkdocPath("sem-extensao"), false);
});

test("isWorkdocPath: rejeita traversal, absoluto e separador nao-canonico", () => {
  assert.equal(isWorkdocPath("../x.md"), false);
  assert.equal(isWorkdocPath("a/../../x.md"), false);
  assert.equal(isWorkdocPath("/etc/x.md"), false);
  assert.equal(isWorkdocPath("C:/temp/x.md"), false);
  assert.equal(isWorkdocPath("notas\\x.md"), false);
  assert.equal(isWorkdocPath("a//x.md"), false);
  assert.equal(isWorkdocPath(""), false);
  assert.equal(isWorkdocPath(null), false);
  assert.equal(isWorkdocPath(42), false);
});

// ---------- nome do arquivo de conflito ----------

test("conflictPath: insere .conflito-<slug> antes da extensao, preservando a pasta", () => {
  assert.equal(conflictPath("pesquisa.md", "pedro-giudice"), "pesquisa.conflito-pedro-giudice.md");
  assert.equal(
    conflictPath("notas/2026/apelacao.md", "bia"),
    "notas/2026/apelacao.conflito-bia.md",
  );
  assert.equal(conflictPath("scripts/gerar.py", "bia"), "scripts/gerar.conflito-bia.py");
});

test("conflictPath: resultado continua sendo um workdoc valido", () => {
  assert.equal(isWorkdocPath(conflictPath("notas/a.md", "pedro-giudice")), true);
});

test("conflictPath: slug ou path invalido -> null (nunca vira escrita)", () => {
  assert.equal(conflictPath("pesquisa.md", "../etc"), null);
  assert.equal(conflictPath("pesquisa.md", ".."), null);
  assert.equal(conflictPath("pesquisa.md", "a/b"), null);
  assert.equal(conflictPath("pesquisa.md", ""), null);
  assert.equal(conflictPath("pesquisa.md", null), null);
  assert.equal(conflictPath("../x.md", "bia"), null);
});

// ---------- plano de sync ----------

test("plano: server mudou + local intocado -> download", () => {
  const plan = planWorkdocsSync({
    manifest: { "a.md": { md5: "v2" } },
    localFiles: { "a.md": "v1" },
    baseline: { "a.md": "v1" },
  });
  assert.deepEqual(plan.downloads, ["a.md"]);
  assert.deepEqual(plan.uploads, []);
  assert.deepEqual(plan.conflicts, []);
});

test("plano: local mudou + server intocado -> upload", () => {
  const plan = planWorkdocsSync({
    manifest: { "a.md": { md5: "v1" } },
    localFiles: { "a.md": "vLocal" },
    baseline: { "a.md": "v1" },
  });
  assert.deepEqual(plan.uploads, ["a.md"]);
  assert.deepEqual(plan.downloads, []);
  assert.deepEqual(plan.conflicts, []);
});

test("plano: ambos mudaram -> conflito", () => {
  const plan = planWorkdocsSync({
    manifest: { "a.md": { md5: "vRemoto" } },
    localFiles: { "a.md": "vLocal" },
    baseline: { "a.md": "v0" },
  });
  assert.deepEqual(plan.conflicts, ["a.md"]);
  assert.deepEqual(plan.downloads, []);
  assert.deepEqual(plan.uploads, []);
});

test("plano: divergencia sem baseline (bootstrap) -> conflito, nunca sobrescreve", () => {
  const plan = planWorkdocsSync({
    manifest: { "a.md": { md5: "vRemoto" } },
    localFiles: { "a.md": "vLocal" },
    baseline: {},
  });
  assert.deepEqual(plan.conflicts, ["a.md"]);
});

test("plano: iguais nos dois lados -> nenhuma acao", () => {
  const plan = planWorkdocsSync({
    manifest: { "a.md": { md5: "v1" } },
    localFiles: { "a.md": "v1" },
    baseline: {},
  });
  assert.deepEqual(plan, { downloads: [], uploads: [], conflicts: [], warnings: [] });
});

test("plano: ausente local com baseline -> download (delecao local NAO propaga)", () => {
  const plan = planWorkdocsSync({
    manifest: { "a.md": { md5: "v1" } },
    localFiles: {},
    baseline: { "a.md": "v1" },
  });
  assert.deepEqual(plan.downloads, ["a.md"]);
  assert.deepEqual(plan.uploads, []);
});

test("plano: arquivo novo no server (sem local, sem baseline) -> download", () => {
  const plan = planWorkdocsSync({
    manifest: { "novo.md": { md5: "v1" } },
    localFiles: {},
    baseline: {},
  });
  assert.deepEqual(plan.downloads, ["novo.md"]);
});

test("plano: ausente no server + sem baseline -> upload (arquivo novo local)", () => {
  const plan = planWorkdocsSync({
    manifest: {},
    localFiles: { "novo.md": "v1" },
    baseline: {},
  });
  assert.deepEqual(plan.uploads, ["novo.md"]);
  assert.deepEqual(plan.downloads, []);
});

test("plano: ausente no server + com baseline -> nenhuma acao (delecao no server nao destroi local)", () => {
  const plan = planWorkdocsSync({
    manifest: {},
    localFiles: { "a.md": "v1" },
    baseline: { "a.md": "v1" },
  });
  assert.deepEqual(plan, { downloads: [], uploads: [], conflicts: [], warnings: [] });
});

test("plano: path remoto fora da allowlist e descartado com aviso", () => {
  const plan = planWorkdocsSync({
    manifest: { "../fora.md": { md5: "x" }, "CLAUDE.md": { md5: "y" }, "ok.md": { md5: "z" } },
    localFiles: {},
    baseline: {},
  });
  assert.deepEqual(plan.downloads, ["ok.md"]);
  assert.equal(plan.warnings.length, 2);
});

test("plano: local fora da allowlist nunca vira upload", () => {
  const plan = planWorkdocsSync({
    manifest: {},
    localFiles: { "CLAUDE.md": "x", "rascunho.local.md": "y", "ok.py": "z" },
    baseline: {},
  });
  assert.deepEqual(plan.uploads, ["ok.py"]);
});

test("plano: aceita md5 plano ou objeto {md5} no manifest", () => {
  const plan = planWorkdocsSync({
    manifest: { "a.md": "v1" },
    localFiles: { "a.md": "v1" },
    baseline: {},
  });
  assert.deepEqual(plan.downloads, []);
});

test("plano: entradas ordenadas (deterministico)", () => {
  const plan = planWorkdocsSync({
    manifest: { "z.md": { md5: "1" }, "a.md": { md5: "1" }, "m.md": { md5: "1" } },
    localFiles: {},
    baseline: {},
  });
  assert.deepEqual(plan.downloads, ["a.md", "m.md", "z.md"]);
});

test("plano: tolera entradas ausentes/nulas", () => {
  assert.deepEqual(planWorkdocsSync({}), {
    downloads: [],
    uploads: [],
    conflicts: [],
    warnings: [],
  });
  assert.deepEqual(planWorkdocsSync({ manifest: null, localFiles: null, baseline: null }), {
    downloads: [],
    uploads: [],
    conflicts: [],
    warnings: [],
  });
});

// ---------- baseline ----------

test("baseline: download bem-sucedido adota o md5 do server", () => {
  const next = computeWorkdocsBaseline({
    manifest: { "a.md": { md5: "v2" } },
    localFiles: { "a.md": "v1" },
    baseline: { "a.md": "v1" },
    downloaded: new Set(["a.md"]),
  });
  assert.deepEqual(next, { "a.md": "v2" });
});

test("baseline: upload bem-sucedido adota o md5 local", () => {
  const next = computeWorkdocsBaseline({
    manifest: { "a.md": { md5: "v1" } },
    localFiles: { "a.md": "vLocal" },
    baseline: { "a.md": "v1" },
    uploaded: new Set(["a.md"]),
  });
  assert.deepEqual(next, { "a.md": "vLocal" });
});

test("baseline: conflito materializado adota o md5 do server (local vence no proximo ciclo)", () => {
  const next = computeWorkdocsBaseline({
    manifest: { "a.md": { md5: "vRemoto" } },
    localFiles: { "a.md": "vLocal" },
    baseline: { "a.md": "v0" },
    conflicted: new Set(["a.md"]),
  });
  assert.deepEqual(next, { "a.md": "vRemoto" });
});

test("baseline: falha (nem baixado, nem subido, nem materializado) mantem o anterior", () => {
  const next = computeWorkdocsBaseline({
    manifest: { "a.md": { md5: "v2" } },
    localFiles: { "a.md": "v1" },
    baseline: { "a.md": "v1" },
  });
  assert.deepEqual(next, { "a.md": "v1" });
});

test("baseline: ja sincronizado adota o md5 comum mesmo sem baseline previo", () => {
  const next = computeWorkdocsBaseline({
    manifest: { "a.md": { md5: "v1" } },
    localFiles: { "a.md": "v1" },
    baseline: {},
  });
  assert.deepEqual(next, { "a.md": "v1" });
});

test("baseline: arquivo local ausente do server mantem entrada (nao re-sobe como novo)", () => {
  const next = computeWorkdocsBaseline({
    manifest: {},
    localFiles: { "a.md": "v1" },
    baseline: { "a.md": "v1" },
  });
  assert.deepEqual(next, { "a.md": "v1" });
});

test("baseline: sumiu dos dois lados -> entrada removida", () => {
  const next = computeWorkdocsBaseline({
    manifest: {},
    localFiles: {},
    baseline: { "a.md": "v1" },
  });
  assert.deepEqual(next, {});
});

test("baseline: path fora da allowlist nunca entra", () => {
  const next = computeWorkdocsBaseline({
    manifest: { "CLAUDE.md": { md5: "x" } },
    localFiles: { "CLAUDE.md": "x" },
    baseline: {},
  });
  assert.deepEqual(next, {});
});

// ---------- batches de upload ----------

test("batches: agrupa respeitando o teto por requisicao", () => {
  const meio = Math.floor(WORKDOC_MAX_BATCH_BYTES / 2); // custo base64 ~4/3 -> 2 nao cabem
  const { batches, skipped, deferred } = planWorkdocUploadBatches([
    { case: "c", path: "a.md", size: meio },
    { case: "c", path: "b.md", size: meio },
  ]);
  assert.equal(skipped.length, 0);
  assert.equal(deferred.length, 0);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches.map((b) => b.map((f) => f.path)), [["a.md"], ["b.md"]]);
});

test("batches: arquivos pequenos cabem no mesmo batch", () => {
  const { batches } = planWorkdocUploadBatches([
    { case: "c", path: "a.md", size: 10 },
    { case: "c", path: "b.md", size: 20 },
    { case: "d", path: "c.py", size: 30 },
  ]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 3);
});

test("batches: arquivo acima do teto por arquivo e pulado, nunca derruba o resto", () => {
  const { batches, skipped } = planWorkdocUploadBatches([
    { case: "c", path: "grande.md", size: WORKDOC_MAX_FILE_BYTES + 1 },
    { case: "c", path: "ok.md", size: 10 },
  ]);
  assert.deepEqual(skipped.map((s) => s.path), ["grande.md"]);
  assert.match(skipped[0].reason, /2 MiB/);
  assert.deepEqual(batches[0].map((f) => f.path), ["ok.md"]);
});

test("batches: teto por ciclo adia o excedente para o proximo tick", () => {
  const files = [];
  for (let i = 0; i < 12; i++) {
    files.push({ case: "c", path: `f${i}.md`, size: WORKDOC_MAX_FILE_BYTES });
  }
  const { batches, deferred } = planWorkdocUploadBatches(files);
  const enviados = batches.flat().length;
  assert.ok(enviados > 0 && enviados < 12, `esperado corte por ciclo, enviados=${enviados}`);
  assert.equal(enviados + deferred.length, 12);
  // custo base64 (~4/3) do que foi enviado cabe no teto do ciclo
  assert.ok(enviados * Math.ceil(WORKDOC_MAX_FILE_BYTES / 3) * 4 <= WORKDOC_MAX_TICK_BYTES);
});

test("batches: lista vazia -> nada", () => {
  assert.deepEqual(planWorkdocUploadBatches([]), { batches: [], skipped: [], deferred: [] });
  assert.deepEqual(planWorkdocUploadBatches(null), { batches: [], skipped: [], deferred: [] });
});
