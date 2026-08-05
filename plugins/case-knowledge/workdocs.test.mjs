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

test("isWorkdocPath: rejeita os 3 arquivos de briefing (trilho próprio)", () => {
  assert.equal(isWorkdocPath("CLAUDE.md"), false);
  assert.equal(isWorkdocPath("case.yaml"), false);
  assert.equal(isWorkdocPath("documentos.yaml"), false);
});

test("isWorkdocPath: rejeita autos e derivados do pipeline em QUALQUER segmento", () => {
  assert.equal(isWorkdocPath("base/x.md"), false);
  assert.equal(isWorkdocPath("base_classifier/x.md"), false);
  assert.equal(isWorkdocPath("_archive/x.md"), false);
  // fronteira com o servidor: a exclusão vale em qualquer segmento de diretório
  assert.equal(isWorkdocPath("notas/base/x.md"), false);
  assert.equal(isWorkdocPath("a/b/_archive/c/x.py"), false);
  // ...mas o nome do ARQUIVO não é diretório
  assert.equal(isWorkdocPath("notas/base.md"), true);
});

test("isWorkdocPath: rejeita árvore de dependência em qualquer segmento", () => {
  assert.equal(isWorkdocPath("venv/lib/x.py"), false);
  assert.equal(isWorkdocPath("scripts/venv/lib/x.py"), false);
  assert.equal(isWorkdocPath("node_modules/pacote/x.md"), false);
  assert.equal(isWorkdocPath("scripts/__pycache__/x.py"), false);
  assert.equal(isWorkdocPath("a/site-packages/b/x.py"), false);
});

test("isWorkdocPath: rejeita CLAUDE.md por BASENAME em qualquer profundidade", () => {
  assert.equal(isWorkdocPath("notas/CLAUDE.md"), false);
  assert.equal(isWorkdocPath("a/b/CLAUDE.md"), false);
});

test("isWorkdocPath: extensão é case-insensitive (comparada em minúsculas)", () => {
  assert.equal(isWorkdocPath("NOTA.MD"), true);
  assert.equal(isWorkdocPath("notas/Script.Py"), true);
  assert.equal(isWorkdocPath("RASCUNHO.LOCAL.MD"), false); // opt-out também
});

test("isWorkdocPath: cópia de conflito não é workdoc elegível (I4)", () => {
  assert.equal(isWorkdocPath("tese.conflito-pedro-giudice.md"), false);
  assert.equal(isWorkdocPath("notas/tese.conflito-bia-2.md"), false);
  assert.equal(isWorkdocPath("scripts/gerar.conflito-bia.py"), false);
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

test("isWorkdocPath: rejeita extensão fora da allowlist", () => {
  assert.equal(isWorkdocPath("peca.docx"), false);
  assert.equal(isWorkdocPath("planilha.xlsx"), false);
  assert.equal(isWorkdocPath("notas/relatorio.pdf"), false);
  assert.equal(isWorkdocPath("sem-extensao"), false);
});

test("isWorkdocPath: rejeita traversal, absoluto e separador não-canônico", () => {
  assert.equal(isWorkdocPath("../x.md"), false);
  assert.equal(isWorkdocPath("a/../../x.md"), false);
  assert.equal(isWorkdocPath("/etc/x.md"), false);
  assert.equal(isWorkdocPath("C:/temp/x.md"), false);
  assert.equal(isWorkdocPath("notas\\x.md"), false);
  assert.equal(isWorkdocPath("a//x.md"), false);
  assert.equal(isWorkdocPath("nota.md/"), false);
  assert.equal(isWorkdocPath("a:b.md"), false); // qualquer `:`, como o servidor
  assert.equal(isWorkdocPath("nota\u0007.md"), false); // caractere de controle
  assert.equal(isWorkdocPath(""), false);
  assert.equal(isWorkdocPath(null), false);
  assert.equal(isWorkdocPath(42), false);
});

// ---------- nome do arquivo de conflito ----------

test("conflictPath: insere .conflito-<slug> antes da extensão, preservando a pasta", () => {
  assert.equal(conflictPath("pesquisa.md", "pedro-giudice"), "pesquisa.conflito-pedro-giudice.md");
  assert.equal(
    conflictPath("notas/2026/apelacao.md", "bia"),
    "notas/2026/apelacao.conflito-bia.md",
  );
  assert.equal(conflictPath("scripts/gerar.py", "bia"), "scripts/gerar.conflito-bia.py");
});

test("conflictPath: a cópia NÃO é workdoc (material de reconciliação local, I4)", () => {
  assert.equal(isWorkdocPath(conflictPath("notas/a.md", "pedro-giudice")), false);
});

test("conflictPath: preserva a caixa da extensão original", () => {
  assert.equal(conflictPath("NOTA.MD", "bia"), "NOTA.conflito-bia.MD");
});

test("conflictPath: slug ou path inválido -> null (nunca vira escrita)", () => {
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

test("plano: os dois lados mudaram -> conflito", () => {
  const plan = planWorkdocsSync({
    manifest: { "a.md": { md5: "vRemoto" } },
    localFiles: { "a.md": "vLocal" },
    baseline: { "a.md": "v0" },
  });
  assert.deepEqual(plan.conflicts, ["a.md"]);
  assert.deepEqual(plan.downloads, []);
  assert.deepEqual(plan.uploads, []);
});

test("plano: divergência sem baseline (bootstrap) -> conflito, nunca sobrescreve", () => {
  const plan = planWorkdocsSync({
    manifest: { "a.md": { md5: "vRemoto" } },
    localFiles: { "a.md": "vLocal" },
    baseline: {},
  });
  assert.deepEqual(plan.conflicts, ["a.md"]);
});

test("plano: iguais nos dois lados -> nenhuma ação", () => {
  const plan = planWorkdocsSync({
    manifest: { "a.md": { md5: "v1" } },
    localFiles: { "a.md": "v1" },
    baseline: {},
  });
  assert.deepEqual(plan, { downloads: [], uploads: [], conflicts: [], warnings: [] });
});

test("plano: ausente local com baseline -> download (deleção local NÃO propaga)", () => {
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

test("plano: ausente no server + com baseline -> nenhuma ação (deleção no server não destrói local)", () => {
  const plan = planWorkdocsSync({
    manifest: {},
    localFiles: { "a.md": "v1" },
    baseline: { "a.md": "v1" },
  });
  assert.deepEqual(plan, { downloads: [], uploads: [], conflicts: [], warnings: [] });
});

test("plano: local presente mas inelegível (acima de 2 MiB) nunca vira download (C1)", () => {
  const plan = planWorkdocsSync({
    manifest: { "a.md": { md5: "vRemoto" } },
    localFiles: { "a.md": { oversize: true } },
    baseline: { "a.md": "v0" },
  });
  assert.deepEqual(plan.downloads, [], "sobrescreveria trabalho local");
  assert.deepEqual(plan.uploads, []);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /a\.md/);
});

test("plano: local inelegível sem remoto também é inerte", () => {
  const plan = planWorkdocsSync({
    manifest: {},
    localFiles: { "a.md": { oversize: true } },
    baseline: {},
  });
  assert.deepEqual(plan.uploads, []);
  assert.deepEqual(plan.downloads, []);
});

test("plano: path remoto fora da allowlist é descartado com aviso", () => {
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

test("plano: entradas ordenadas (determinístico)", () => {
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

test("baseline: download adota o md5 dos BYTES GRAVADOS, não o do manifest (I3)", () => {
  const next = computeWorkdocsBaseline({
    manifest: { "a.md": { md5: "vManifest" } },
    localFiles: { "a.md": "v1" },
    baseline: { "a.md": "v1" },
    // servidor mudou entre o manifest e o fetch: o que está no disco é vEscrito
    downloaded: new Map([["a.md", "vEscrito"]]),
  });
  assert.deepEqual(next, { "a.md": "vEscrito" });
});

test("baseline: download sem md5 real (Set) cai no md5 do manifest", () => {
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

test("baseline: conflito materializado adota o md5 do server (local vence no próximo ciclo)", () => {
  const next = computeWorkdocsBaseline({
    manifest: { "a.md": { md5: "vRemoto" } },
    localFiles: { "a.md": "vLocal" },
    baseline: { "a.md": "v0" },
    conflicted: new Map([["a.md", "vRemoto"]]),
  });
  assert.deepEqual(next, { "a.md": "vRemoto" });
});

test("baseline: conflito NÃO materializado mantém o baseline anterior (I5)", () => {
  const next = computeWorkdocsBaseline({
    manifest: { "a.md": { md5: "vRemoto" } },
    localFiles: { "a.md": "vLocal" },
    baseline: { "a.md": "v0" },
    conflicted: new Map(), // nenhum slot livre: nada foi escrito no disco
  });
  assert.deepEqual(next, { "a.md": "v0" }, "adotar vRemoto destruiria a versão da VM");
});

test("baseline: falha (nem baixado, nem subido, nem materializado) mantém o anterior", () => {
  const next = computeWorkdocsBaseline({
    manifest: { "a.md": { md5: "v2" } },
    localFiles: { "a.md": "v1" },
    baseline: { "a.md": "v1" },
  });
  assert.deepEqual(next, { "a.md": "v1" });
});

test("baseline: já sincronizado adota o md5 comum mesmo sem baseline prévio", () => {
  const next = computeWorkdocsBaseline({
    manifest: { "a.md": { md5: "v1" } },
    localFiles: { "a.md": "v1" },
    baseline: {},
  });
  assert.deepEqual(next, { "a.md": "v1" });
});

test("baseline: arquivo local ausente do server mantém entrada (não re-sobe como novo)", () => {
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

test("batches: agrupa respeitando o teto por requisição", () => {
  const meio = Math.floor(WORKDOC_MAX_BATCH_BYTES / 2); // custo base64 ~4/3 -> 2 não cabem
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

test("batches: arquivo acima do teto por arquivo é pulado, nunca derruba o resto", () => {
  const { batches, skipped } = planWorkdocUploadBatches([
    { case: "c", path: "grande.md", size: WORKDOC_MAX_FILE_BYTES + 1 },
    { case: "c", path: "ok.md", size: 10 },
  ]);
  assert.deepEqual(skipped.map((s) => s.path), ["grande.md"]);
  assert.match(skipped[0].reason, /2 MiB/);
  assert.deepEqual(batches[0].map((f) => f.path), ["ok.md"]);
});

test("batches: teto por ciclo adia o excedente para o próximo tick", () => {
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

test("isWorkdocPath: guards de nome comparam SEM caixa (como o servidor)", () => {
  // diretório do pipeline em qualquer caixa
  assert.equal(isWorkdocPath("notas/Base/x.md"), false);
  assert.equal(isWorkdocPath("BASE_CLASSIFIER/x.md"), false);
  assert.equal(isWorkdocPath("a/_Archive/x.py"), false);
  // árvore de dependência em qualquer caixa
  assert.equal(isWorkdocPath("Node_Modules/pacote/x.md"), false);
  // briefing por basename em qualquer caixa e profundidade
  assert.equal(isWorkdocPath("notas/CLAUDE.MD"), false);
  assert.equal(isWorkdocPath("claude.md"), false);
  assert.equal(isWorkdocPath("Case.YAML"), false);
  // marcador de conflito em qualquer caixa
  assert.equal(isWorkdocPath("x.CONFLITO-bia.md"), false);
});

test("plano: motivo da inelegibilidade aparece no aviso", () => {
  const plan = planWorkdocsSync({
    manifest: { "a.md": { md5: "vRemoto" } },
    localFiles: { "a.md": { motivo: "ilegível: EACCES" } },
    baseline: {},
  });
  assert.deepEqual(plan.downloads, []);
  assert.match(plan.warnings[0], /ilegível: EACCES/);
  assert.match(plan.warnings[0], /a\.md/);
});

test("isWorkdocPath: rejeita a faixa de controle C1 (paridade com is_control do servidor)", () => {
  assert.equal(isWorkdocPath("nota\u0085.md"), false); // NEL, aceito em nome NTFS
  assert.equal(isWorkdocPath("nota\u0080.md"), false);
  assert.equal(isWorkdocPath("nota\u009F.md"), false);
  assert.equal(isWorkdocPath("notas\u0085/x.md"), false);
  assert.equal(isWorkdocPath("nota\u007F.md"), false); // DEL segue barrado
  assert.equal(isWorkdocPath("nota\u00A0.md"), true); // NBSP nao e controle
});
