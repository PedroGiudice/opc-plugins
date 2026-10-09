import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OUTPUT_CAP_CHARS, paresMaisSimilares } from "./format.mjs";

// A API repassa `limit` ao search_matrix_pairs do Qdrant, onde ele e o numero
// de vizinhos POR PONTO da amostra: com sample 200 e limit 20 chegavam 4.000
// pares, agrupados por ponto (medido em 09/10/2026: 344 mil chars no padrao).
function matriz(sample, limit) {
  const pairs = [];
  for (let i = 0; i < sample; i++) {
    for (let j = 1; j <= limit; j++) {
      const b = (i + j) % sample;
      pairs.push({ a: `chunk-${String(i).padStart(4, "0")}-0000-0000-0000-000000000000`, b: `chunk-${String(b).padStart(4, "0")}-0000-0000-0000-000000000000`, score: Math.round((1 - (((i * 7 + j * 13) % 997) / 1000)) * 1e6) / 1e6 });
    }
  }
  return pairs;
}

test("devolve os limit pares mais similares, do maior score para o menor", () => {
  const pares = paresMaisSimilares(matriz(200, 20), 20);
  assert.equal(pares.length, 20);
  for (let i = 1; i < pares.length; i++) assert.ok(pares[i - 1].score >= pares[i].score);
  const chave = (p) => [p.a, p.b].sort().join(" ");
  const dentro = new Set(pares.map(chave));
  const corte = pares.at(-1).score;
  const fora = matriz(200, 20).filter((p) => !dentro.has(chave(p)));
  assert.ok(fora.every((p) => p.score <= corte), "deixou de fora par mais similar que o ultimo entregue");
});

test("o mesmo par nos dois sentidos conta uma vez", () => {
  const pares = paresMaisSimilares([
    { a: "x", b: "y", score: 0.99 },
    { a: "y", b: "x", score: 0.99 },
    { a: "x", b: "z", score: 0.5 },
  ], 10);
  assert.deepEqual(pares, [{ a: "x", b: "y", score: 0.99 }, { a: "x", b: "z", score: 0.5 }]);
});

test("com os maiores parametros da tool o texto cabe no teto", () => {
  const pares = paresMaisSimilares(matriz(1000, 100), 100);
  const texto = pares.map((p) => `[${p.score.toFixed(3)}] ${p.a} <-> ${p.b}`).join("\n");
  assert.equal(pares.length, 100);
  assert.ok(texto.length <= OUTPUT_CAP_CHARS, `${texto.length} chars`);
});

test("tool comparar entrega os pares pelo paresMaisSimilares", () => {
  const src = readFileSync(new URL("./server.mjs", import.meta.url), "utf-8");
  const tool = src.slice(src.indexOf('"comparar",'), src.indexOf("// Tool: discover"));
  assert.match(tool, /paresMaisSimilares\(data\.pairs,\s*limit\)/);
});
