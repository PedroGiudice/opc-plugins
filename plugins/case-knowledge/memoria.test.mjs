import { test } from "node:test";
import assert from "node:assert/strict";
import { memoriaSearch, formatMemoriaResults } from "./memoria.mjs";

test("memoriaSearch monta o request e formata resultados", async () => {
  let captured;
  const fakeFetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return {
      ok: true,
      json: async () => ({
        status: "ok",
        chunks: [{ score: 0.8, content: "decidimos X", session_id: "s1", timestamp: "2026-06-10T00:00:00Z" }],
      }),
    };
  };
  const out = await memoriaSearch(
    { query: "o que decidimos", limit: 3 },
    { dir: "C:\\Users\\pedro\\cases\\caso-x", name: "caso-x" },
    fakeFetch,
  );
  assert.ok(captured.url.endsWith("/search"));
  assert.equal(captured.body.repo_path, "C:\\Users\\pedro\\cases\\caso-x");
  assert.equal(captured.body.limit, 3);
  assert.ok(out.includes("decidimos X"));
  assert.ok(out.includes("0.80"));
});

test("memoriaSearch: sem resultados -> mensagem amigavel", async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ status: "ok", chunks: [] }) });
  const out = await memoriaSearch({ query: "q de teste valida" }, { dir: "/x/cases/y", name: "y" }, fakeFetch);
  assert.ok(out.includes("nenhuma memoria"));
});

test("memoriaSearch: erro HTTP -> mensagem legivel, sem throw", async () => {
  const fakeFetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  const out = await memoriaSearch({ query: "q de teste valida" }, { dir: "/x/cases/y", name: "y" }, fakeFetch);
  assert.ok(out.toLowerCase().includes("indisponivel"));
});
