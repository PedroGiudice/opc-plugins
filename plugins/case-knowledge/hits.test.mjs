import { test } from "node:test";
import assert from "node:assert/strict";
import { OUTPUT_CAP_CHARS, renderLines, previewResult, renderHitsComTeto } from "./format.mjs";

// Hit no shape real de buscar_cronologico/interseccao (API Rust, with_payload).
function hit(i, contentLen, extra = {}) {
  return {
    score: 0.5,
    chunk_id: `c${String(i).padStart(4, "0")}`,
    content: `inicio ${i} ` + "palavra ".repeat(Math.ceil(contentLen / 8)).slice(0, contentLen),
    documento: "Copia Integral.json",
    peca: "contestacao",
    fase: "conhecimento",
    chunk_index: i,
    token_count: 900,
    doc_order: 3,
    data_juntada: "2025-03-10T00:00:00Z",
    posicao_relativa: 0.4,
    page_start: 10,
    page_end: 12,
    segmento_id: "Copia Integral.json#p0010",
    tipo_conteudo: "peca",
    chunk_kind: "page",
    ...extra,
  };
}

const linhasJson = (text) =>
  text.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l.replace(/,$/, "")));

test("renderHitsComTeto: lista que cabe sai igual ao search (preview 1200), sem aviso", () => {
  const hits = [hit(0, 3000), hit(1, 500)];
  const text = renderHitsComTeto([{ hits }]);
  assert.equal(text, renderLines(hits.map((h) => previewResult(h, 1200))));
});

test("renderHitsComTeto: lista longa degrada, fica no teto e avisa no topo, na ordem original", () => {
  const hits = Array.from({ length: 30 }, (_, i) => hit(i, 5000));
  const text = renderHitsComTeto([{ hits }]);
  assert.ok(text.length <= OUTPUT_CAP_CHARS, `len=${text.length}`);
  assert.ok(text.startsWith("[aviso:"), text.slice(0, 80));
  const lidos = linhasJson(text);
  assert.ok(lidos.length >= 1);
  assert.deepEqual(lidos.map((h) => h.chunk_index), lidos.map((_, i) => i));
});

test("renderHitsComTeto: content_chars 0 entrega content integral e corta a cauda", () => {
  const hits = Array.from({ length: 30 }, (_, i) => hit(i, 3000));
  const text = renderHitsComTeto([{ hits }], { contentChars: 0 });
  assert.ok(text.length <= OUTPUT_CAP_CHARS, `len=${text.length}`);
  const lidos = linhasJson(text);
  assert.ok(lidos.length < hits.length);
  for (const h of lidos) assert.equal(h.content, hits[h.chunk_index].content);
});

test("renderHitsComTeto: grupos levam o cabecalho de cada lista", () => {
  const text = renderHitsComTeto([
    { cabecalho: "documento: A.json", hits: [hit(0, 100)] },
    { cabecalho: "documento: B.json", hits: [hit(1, 100)] },
  ]);
  assert.match(text, /^=== documento: A\.json ===\n\[/);
  assert.match(text, /\n\n=== documento: B\.json ===\n\[/);
});

test("renderHitsComTeto: grupos que nao cabem nem no minimo saem do fim, com aviso", () => {
  const citados = Array.from({ length: 60 }, (_, k) => `REsp ${1000000 + k}/SP`);
  const listas = Array.from({ length: 60 }, (_, i) => ({
    cabecalho: `documento: doc${i}.json`,
    hits: [hit(i, 2000, { recursos_citados: citados })],
  }));
  const text = renderHitsComTeto(listas, { rotuloLista: "grupo(s)" });
  assert.ok(text.length <= OUTPUT_CAP_CHARS, `len=${text.length}`);
  assert.match(text, /=== documento: doc0\.json ===/);
  assert.doesNotMatch(text, /=== documento: doc59\.json ===/);
  assert.match(text, /\[aviso: \d+ grupo\(s\) do fim omitido\(s\)/);
});

test("renderHitsComTeto: um hit sozinho acima do teto com content_chars 0 sai inteiro", () => {
  const unico = hit(0, 30000);
  const text = renderHitsComTeto([{ hits: [unico] }], { contentChars: 0 });
  assert.equal(linhasJson(text)[0].content, unico.content);
});
