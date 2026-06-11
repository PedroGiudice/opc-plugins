import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateContent, previewResult } from "./format.mjs";

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
