import { test } from "node:test";
import assert from "node:assert/strict";
import { OUTPUT_CAP_CHARS, paginarDocumento } from "./saida.mjs";

// Shape real do GET /api/document/{doc_id} do stj-vec-search (types.rs::DocumentResponse).
function julgado(n, tamanho, { indices } = {}) {
  const chunks = Array.from({ length: n }, (_, i) => ({
    id: `ch${i}`,
    chunk_index: indices ? indices[i] : i,
    content: `chunk ${i}: ` + "texto do acordao ".repeat(Math.ceil(tamanho / 17)).slice(0, tamanho),
    token_count: 500,
    section: i === 0 ? "ementa" : "voto",
  }));
  return {
    document: {
      id: "241605110", processo: "REsp 1234567", classe: "RESP", ministro: "NANCY ANDRIGHI",
      orgao_julgador: "TERCEIRA TURMA", data_julgamento: "2024-05-07", data_publicacao: "2024-05-10",
      tipo: "ACÓRDÃO", assuntos: "",
    },
    chunks,
    total_chunks: n,
  };
}

// Shape real do GET /api/document/{doc_id} do legal-vec-api: sem chunk_index,
// na ordem do scroll do Qdrant.
function dispositivo(n, tamanho) {
  return {
    doc_id: "simples_nacional_art_18",
    total_chunks: n,
    chunks: Array.from({ length: n }, (_, i) => ({
      chunk_id: `p${i}`, doc_id: "simples_nacional_art_18", score: 1.0, dense_score: null, sparse_score: null,
      content: `parte ${i}: ` + "inciso ".repeat(Math.ceil(tamanho / 7)).slice(0, tamanho),
    })),
  };
}

// O que o painel do aidv-autos faz com a saida: JSON a partir do primeiro "{".
const jsonDe = (text) => JSON.parse(text.slice(text.indexOf("{")));

test("documento que cabe sai identico ao JSON da API, sem aviso", () => {
  const data = julgado(3, 2000);
  const out = paginarDocumento(data);
  assert.equal(out.text, JSON.stringify(data, null, 2));
  assert.equal(out.next_from, null);
});

test("documento grande sai no teto, com aviso e from_chunk do primeiro chunk que ficou de fora", () => {
  const data = julgado(62, 1800);
  const out = paginarDocumento(data, { rotulo: "julgado" });
  assert.ok(out.text.length <= OUTPUT_CAP_CHARS, `len=${out.text.length}`);
  assert.match(out.text, /^\[aviso: julgado maior que o limite de output — entregue até o chunk \d+ de 62\. Continue com from_chunk=\d+\.\]\n\{/);
  const o = jsonDe(out.text);
  const idx = o.chunks.map((c) => c.chunk_index);
  assert.deepEqual(idx, idx.map((_, i) => i));
  assert.equal(o.next_from, idx.length);
  assert.equal(out.text.match(/from_chunk=(\d+)/)[1], String(idx.length));
});

test("os chunks entregues sao o texto literal da API, nunca partidos", () => {
  const data = julgado(40, 2500);
  const o = jsonDe(paginarDocumento(data).text);
  for (const c of o.chunks) assert.deepEqual(c, data.chunks[c.chunk_index]);
});

test("metadados do julgado vem antes dos chunks (aidv-passos le o cabecalho antes de \"chunks\")", () => {
  const out = paginarDocumento(julgado(62, 1800));
  const fim = out.text.indexOf('"chunks"');
  assert.ok(fim > 0);
  assert.match(out.text.slice(0, fim), /"processo": "REsp 1234567"/);
  assert.match(out.text.slice(0, fim), /"total_chunks": 62/);
});

test("from_chunk continua de onde parou e as paginas cobrem o documento inteiro, em ordem, sem repetir", () => {
  const data = julgado(62, 1800);
  const lidos = [];
  let from = 0;
  for (let voltas = 0; voltas < 20 && from !== null; voltas++) {
    const out = paginarDocumento(data, { fromChunk: from });
    assert.ok(out.text.length <= OUTPUT_CAP_CHARS, `len=${out.text.length}`);
    lidos.push(...jsonDe(out.text).chunks.map((c) => c.chunk_index));
    from = out.next_from;
  }
  assert.deepEqual(lidos, data.chunks.map((c) => c.chunk_index));
});

test("ultima pagina de uma continuacao diz quais chunks entregou e nao traz aviso nem next_from", () => {
  const data = julgado(30, 1500);
  const out = paginarDocumento(data, { fromChunk: 25 });
  assert.doesNotMatch(out.text, /from_chunk=/);
  const o = jsonDe(out.text);
  assert.equal(o.chunks_entregues, "25-29");
  assert.equal(o.next_from, undefined);
});

test("chunk sozinho acima do teto sai inteiro (nunca entrega zero, nunca parte chunk)", () => {
  const data = julgado(3, 30000);
  const out = paginarDocumento(data);
  const o = jsonDe(out.text);
  assert.equal(o.chunks.length, 1);
  assert.equal(o.chunks[0].content, data.chunks[0].content);
  assert.equal(out.next_from, 1);
});

test("chunks fora de ordem com chunk_index saem ordenados", () => {
  const data = julgado(4, 100, { indices: [2, 0, 3, 1] });
  const o = jsonDe(paginarDocumento(data).text);
  assert.deepEqual(o.chunks.map((c) => c.chunk_index), [0, 1, 2, 3]);
});

test("legislacao sem chunk_index: from_chunk e a posicao na ordem da API", () => {
  const data = dispositivo(11, 3000);
  const p1 = paginarDocumento(data, { rotulo: "dispositivo" });
  assert.match(p1.text, /^\[aviso: dispositivo maior que o limite de output/);
  const o1 = jsonDe(p1.text);
  assert.deepEqual(o1.chunks, data.chunks.slice(0, o1.chunks.length));
  const o2 = jsonDe(paginarDocumento(data, { fromChunk: p1.next_from }).text);
  assert.equal(o2.chunks[0].chunk_id, data.chunks[p1.next_from].chunk_id);
});

test("from_chunk alem do fim responde sem chunk e sem from_chunk= (o painel nao entra em laco)", () => {
  const out = paginarDocumento(julgado(5, 100), { fromChunk: 9, rotulo: "julgado" });
  assert.equal(out.delivered, 0);
  assert.doesNotMatch(out.text, /from_chunk=/);
  assert.match(out.text, /Nenhum chunk com índice >= 9 neste julgado \(total: 5 chunks\)/);
});
