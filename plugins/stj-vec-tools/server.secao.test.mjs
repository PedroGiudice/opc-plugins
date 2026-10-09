import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dirname, "server.mjs"), "utf-8");

test("secaoValues lista os rotulos novos do chunker v3", () => {
  const m = src.match(/const secaoValues =\s*"([^"]+)"/);
  assert.ok(m, "secaoValues nao encontrado");
  for (const r of ["voto_vencido", "voto_vista", "voto_vogal", "ementa_origem", "ementa_citada", "dispositivo"]) {
    assert.ok(m[1].split(", ").includes(r), `falta ${r}`);
  }
});

test("descricoes avisam que voto vencido nao e a posicao do colegiado", () => {
  assert.match(src, /voto_vencido = voto que FICOU VENCIDO, NAO e a posicao do colegiado/);
  const usos = src.match(/^\s+avisoSecoes,$/gm) || [];
  assert.equal(usos.length, 3, "avisoSecoes deve entrar em search, search_formula e document");
});

test("ementa_origem e identificada como do tribunal de origem", () => {
  assert.match(src, /ementa_origem = ementa do acordao recorrido transcrita \(tribunal de origem, NAO do STJ\)/);
});
