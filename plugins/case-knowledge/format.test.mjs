import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateContent, previewResult, renderLines, buildCappedPayload, capContextChunks } from "./format.mjs";

test("truncateContent: content curto retorna intacto", () => {
  const r = truncateContent("texto curto", 1200);
  assert.equal(r.text, "texto curto");
  assert.equal(r.truncated, false);
});

test("truncateContent: content longo trunca em fronteira de palavra com sufixo", () => {
  const content = "palavra ".repeat(300); // 2400 chars
  const r = truncateContent(content, 1200);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 1200 + 6, `len=${r.text.length}`);
  assert.ok(r.text.endsWith(" […]"));
  const body = r.text.slice(0, -" […]".length);
  assert.ok(!body.endsWith("palavr"), "cortou no meio da palavra");
});

test("truncateContent: maxChars 0 desativa truncamento", () => {
  const content = "x".repeat(5000);
  const r = truncateContent(content, 0);
  assert.equal(r.text, content);
  assert.equal(r.truncated, false);
});

test("truncateContent: sem espaco proximo do corte, corta seco", () => {
  const content = "a".repeat(3000); // sem espacos
  const r = truncateContent(content, 1200);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 1200 + 6);
});

test("previewResult: trunca content e adiciona content_len/content_truncated", () => {
  const original = { score: 0.9, chunk_id: "c1", content: "y".repeat(5000), peca: "inicial" };
  const out = previewResult(original, 1200);
  assert.equal(out.content_truncated, true);
  assert.equal(out.content_len, 5000);
  assert.ok(out.content.length < 5000);
  assert.equal(out.peca, "inicial"); // demais campos preservados
  // nao muta o original
  assert.equal(original.content.length, 5000);
  assert.equal(original.content_truncated, undefined);
});

test("previewResult: content curto retorna o mesmo objeto sem campos extras", () => {
  const original = { score: 0.9, chunk_id: "c1", content: "curto" };
  const out = previewResult(original, 1200);
  assert.equal(out, original);
});

test("previewResult: result sem content string retorna intacto", () => {
  const original = { score: 0.9, chunk_id: "c1" };
  assert.equal(previewResult(original, 1200), original);
});

// --- Task 2: renderLines + buildCappedPayload ---

test("renderLines: array vazio vira []", () => {
  assert.equal(renderLines([]), "[]");
});

test("renderLines: 1 objeto por linha, JSON parseavel", () => {
  const items = [{ a: 1 }, { b: "dois" }];
  const out = renderLines(items);
  assert.deepEqual(JSON.parse(out), items);
  const lines = out.split("\n");
  // formato: "[", "{...},", "{...}", "]"
  assert.equal(lines[0], "[");
  assert.equal(lines.at(-1), "]");
  assert.equal(lines.length, 4);
});

function makeResult(i, contentLen) {
  return {
    score: 0.9 - i * 0.01,
    chunk_id: `c${i}`,
    chunk_index: i,
    documento: "doc.json",
    peca: "inicial",
    content: ("palavra ".repeat(Math.ceil(contentLen / 8))).slice(0, contentLen),
  };
}

test("buildCappedPayload: payload pequeno passa sem degrade", () => {
  const lists = [[makeResult(0, 500), makeResult(1, 500)]];
  const { text, degraded } = buildCappedPayload({
    lists,
    render: (pls) => renderLines(pls[0]),
    contentChars: 1200,
    globalCap: 60000,
  });
  assert.equal(degraded, null);
  assert.ok(JSON.parse(text).length === 2);
});

test("buildCappedPayload: preview default aplicado (content 5000 -> ~1200)", () => {
  const lists = [[makeResult(0, 5000)]];
  const { text, degraded } = buildCappedPayload({
    lists,
    render: (pls) => renderLines(pls[0]),
    contentChars: 1200,
    globalCap: 60000,
  });
  assert.equal(degraded, null); // preview default NAO conta como degrade
  const parsed = JSON.parse(text);
  assert.equal(parsed[0].content_truncated, true);
  assert.equal(parsed[0].content_len, 5000);
  assert.ok(parsed[0].content.length <= 1206);
});

test("buildCappedPayload: payload grande degrada preview progressivamente", () => {
  // 50 results de 8000 chars: com preview 1200 = ~60k+ chars -> degrada
  const lists = [Array.from({ length: 50 }, (_, i) => makeResult(i, 8000))];
  const { text, degraded } = buildCappedPayload({
    lists,
    render: (pls) => renderLines(pls[0]),
    contentChars: 1200,
    globalCap: 30000,
  });
  assert.ok(degraded !== null);
  assert.ok(text.length <= 30000, `len=${text.length}`);
});

test("buildCappedPayload: content_chars=0 nunca trunca content, corta cauda", () => {
  // 10 results de 30k chars cada, cap 65k -> precisa cortar pra ~2 results
  const lists = [Array.from({ length: 10 }, (_, i) => makeResult(i, 30000))];
  const { text, degraded } = buildCappedPayload({
    lists,
    render: (pls) => renderLines(pls[0]),
    contentChars: 0,
    globalCap: 65000,
  });
  assert.ok(degraded !== null);
  assert.ok(degraded.kept !== null && degraded.kept < 10);
  const parsed = JSON.parse(text);
  // content integral preservado nos que sobraram
  assert.equal(parsed[0].content.length, 30000);
  assert.equal(parsed[0].content_truncated, undefined);
});

test("buildCappedPayload: melhor esforco quando nada cabe (nao lanca)", () => {
  const lists = [[makeResult(0, 200000)]];
  const { text } = buildCappedPayload({
    lists,
    render: (pls) => renderLines(pls[0]),
    contentChars: 0, // integra de 1 result gigante: impossivel caber
    globalCap: 1000,
  });
  assert.ok(typeof text === "string" && text.length > 0);
});

test("buildCappedPayload: multiplas listas (batch) cortadas em paralelo", () => {
  const lists = [
    Array.from({ length: 10 }, (_, i) => makeResult(i, 4000)),
    Array.from({ length: 10 }, (_, i) => makeResult(i + 10, 4000)),
  ];
  const { text, degraded } = buildCappedPayload({
    lists,
    render: (pls) => pls.map((l) => renderLines(l)).join("\n---\n"),
    contentChars: 1200,
    globalCap: 12000,
  });
  assert.ok(degraded !== null);
  assert.ok(text.length <= 12000);
});

// --- Task 3: capContextChunks ---

function makeChunk(idx, len) {
  return { chunk_index: idx, content: "z".repeat(len) };
}

test("capContextChunks: janela que cabe retorna intacta", () => {
  const chunks = [makeChunk(4, 1000), makeChunk(5, 1000), makeChunk(6, 1000)];
  const { chunks: out, reduced } = capContextChunks(chunks, 5, 60000);
  assert.equal(out.length, 3);
  assert.equal(reduced, false);
});

test("capContextChunks: remove extremidades mais distantes do central, preserva central", () => {
  // 7 chunks de 10k chars = 70k > cap 35k -> precisa dropar ~4
  const chunks = [2, 3, 4, 5, 6, 7, 8].map((i) => makeChunk(i, 10000));
  const { chunks: out, reduced } = capContextChunks(chunks, 5, 35000);
  assert.equal(reduced, true);
  assert.ok(out.some((c) => c.chunk_index === 5), "central removido");
  // os que sobram sao os mais proximos do central
  const indices = out.map((c) => c.chunk_index);
  const maxDist = Math.max(...indices.map((i) => Math.abs(i - 5)));
  const droppedMinDist = Math.min(
    ...[2, 3, 4, 5, 6, 7, 8].filter((i) => !indices.includes(i)).map((i) => Math.abs(i - 5))
  );
  assert.ok(maxDist <= droppedMinDist, "dropou chunk mais proximo que um mantido");
});

test("capContextChunks: central gigante sozinho nunca e removido", () => {
  const chunks = [makeChunk(5, 100000)];
  const { chunks: out } = capContextChunks(chunks, 5, 1000);
  assert.equal(out.length, 1);
  assert.equal(out[0].chunk_index, 5);
  assert.equal(out[0].content.length, 100000); // central jamais truncado
});
