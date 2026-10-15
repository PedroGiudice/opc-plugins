import { test } from "node:test";
import assert from "node:assert/strict";
import { resolverSaidaHook, pastaDoCaso, PREFIXO } from "./extracao-sessao.mjs";

test("resolverSaidaHook: fora de ~/cases devolve {} sem chamar o extrator", async () => {
  let chamado = false;
  const out = await resolverSaidaHook("/outro/lugar", "/home/x/cases", { extrairCaso: async () => { chamado = true; } });
  assert.deepEqual(out, {});
  assert.equal(chamado, false);
});

test("resolverSaidaHook: na raiz de ~/cases devolve {} (não é pasta de caso)", async () => {
  const out = await resolverSaidaHook("/home/x/cases", "/home/x/cases", { extrairCaso: async () => ({ extraidos: [], adiados: [] }) });
  assert.deepEqual(out, {});
});

test("resolverSaidaHook: subpasta do caso resolve para a pasta do caso e embrulha o resumo", async () => {
  const chamadas = [];
  const out = await resolverSaidaHook("C:\\Users\\p\\cases\\meu-caso\\emails", "C:\\Users\\p\\cases", {
    extrairCaso: async (dir, opts) => { chamadas.push([dir, opts.orcamentoMs]); return { extraidos: [{ rel: "a.docx", sidecar: "a.docx.md", detalhe: "0 revisores, 0 comentários" }], adiados: [], pulados: 0, naoTocados: [], erros: [] }; },
  });
  assert.deepEqual(chamadas, [["C:\\Users\\p\\cases\\meu-caso", 60000]]);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.ok(out.hookSpecificOutput.additionalContext.startsWith(PREFIXO));
  assert.ok(out.hookSpecificOutput.additionalContext.includes("- a.docx.md (0 revisores, 0 comentários)"));
});

test("resolverSaidaHook: nada extraído nem adiado devolve {}; extrator que lança devolve {}", async () => {
  const vazio = await resolverSaidaHook("/h/cases/c", "/h/cases", { extrairCaso: async () => ({ extraidos: [], adiados: [], pulados: 2, naoTocados: [], erros: [] }) });
  assert.deepEqual(vazio, {});
  const erro = await resolverSaidaHook("/h/cases/c", "/h/cases", { extrairCaso: async () => { throw new Error("x"); } });
  assert.deepEqual(erro, {});
});

test("pastaDoCaso: pastas reservadas e ocultas não são caso; drive do Windows ignora caixa", () => {
  for (const nome of [".memoria", "_archive", "_template", "scripts"]) {
    assert.equal(pastaDoCaso(`/h/cases/${nome}/x`, "/h/cases"), null, nome);
  }
  assert.equal(pastaDoCaso("c:\\users\\p\\cases\\caso\\sub", "C:\\Users\\p\\cases"), "C:\\Users\\p\\cases\\caso");
  assert.equal(pastaDoCaso("/h/cases-outro/c", "/h/cases"), null);
});
