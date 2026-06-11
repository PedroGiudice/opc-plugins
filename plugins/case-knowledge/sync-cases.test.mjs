import { test } from "node:test";
import assert from "node:assert/strict";
import { planActions, isExcluded, archiveTarget } from "./sync-cases.mjs";

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

test("md5 divergente: baixa so o arquivo que mudou", () => {
  const manifest = [
    { name: "alpha", status: "active", files: { "CLAUDE.md": { md5: "aa" }, "case.yaml": { md5: "NEW" } } },
  ];
  const local = { alpha: { "CLAUDE.md": "aa", "case.yaml": "OLD" } };
  const plan = planActions(manifest, local);
  assert.deepEqual(plan.download, [{ name: "alpha", files: ["case.yaml"] }]);
});

test("arquivo local extra (trabalho do advogado) e invisivel ao plano", () => {
  const manifest = [
    { name: "alpha", status: "active", files: { "CLAUDE.md": { md5: "aa" } } },
  ];
  const local = { alpha: { "CLAUDE.md": "aa", "minha-peca.md": "zz" } };
  const plan = planActions(manifest, local);
  assert.deepEqual(plan.download, []);
});

test("orfao detectado; exclusoes nunca viram orfao", () => {
  const manifest = [{ name: "alpha", status: "active", files: {} }];
  const local = { alpha: {}, morto: {}, _archive: {}, _template: {}, scripts: {}, ".claude": {} };
  const plan = planActions(manifest, local);
  assert.deepEqual(plan.orphans, ["morto"]);
});

test("manifest vazio NUNCA gera orfaos (defesa contra bug/erro servidor)", () => {
  const plan = planActions([], { alpha: {}, beta: {} });
  assert.deepEqual(plan.orphans, []);
  assert.deepEqual(plan.mkdir, []);
});

test("isExcluded cobre dotfiles e pastas reservadas", () => {
  for (const n of ["_archive", "_template", "scripts", ".claude", ".sync.log"]) {
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
  const plan = planActions(manifest, local);
  assert.deepEqual(plan.mkdir, []);
  assert.deepEqual(plan.download, [{ name: "alpha", files: ["CLAUDE.md"] }]);
  assert.deepEqual(plan.orphans, []);
});

test("archiveTarget sufixa com data em colisao", () => {
  const taken = new Set(["morto"]);
  assert.equal(archiveTarget("livre", taken), "livre");
  assert.match(archiveTarget("morto", taken), /^morto-\d{8}$/);
});
