import { test } from "node:test";
import assert from "node:assert/strict";
import { caseFromPath, casesFromRoots, buildSessionCases } from "./casos.mjs";

const BASE = "/home/opc/case-docs/cases";

test("caseFromPath: cwd dentro de um caso devolve nome e dir", () => {
  const c = caseFromPath(`${BASE}/arrais-inventario-bento/base`, BASE);
  assert.deepEqual(c, { name: "arrais-inventario-bento", dir: `${BASE}/arrais-inventario-bento` });
});

test("caseFromPath: cwd na raiz dos casos ou fora dela devolve null", () => {
  assert.equal(caseFromPath(BASE, BASE), null);
  assert.equal(caseFromPath("/home/opc/outro", BASE), null);
});

test("caseFromPath: drive Windows compara sem caixa e preserva o nome original", () => {
  const c = caseFromPath("c:\\Users\\pedro\\cases\\LaVioletera-Salesforce", "C:\\Users\\pedro\\cases");
  assert.equal(c.name, "LaVioletera-Salesforce");
});

test("caseFromPath: aplica realpath nos dois lados", () => {
  const realpath = (p) => p.replace("/home/opc/case-docs/cases", "/home/opc/tenants/1/cases");
  const c = caseFromPath(`${BASE}/x`, BASE, { realpath });
  assert.equal(c.name, "x");
});

test("casesFromRoots: converte file:// em casos, ignora fora da base, deduplica em ordem", () => {
  const roots = [
    { uri: `file://${BASE}/arrais-inventario-bento` },
    { uri: "file:///home/opc/case-docs" },
    { uri: `file://${BASE}/arrais-inventario-francisco/base` },
    { uri: `file://${BASE}/arrais-inventario-bento` },
    { uri: "https://exemplo.invalido/x" },
  ];
  const cs = casesFromRoots(roots, BASE);
  assert.deepEqual(cs.map((c) => c.name), ["arrais-inventario-bento", "arrais-inventario-francisco"]);
});

test("casesFromRoots: URI malformada nao derruba a lista", () => {
  const cs = casesFromRoots([{ uri: "file://%zz" }, { uri: `file://${BASE}/a` }], BASE);
  assert.deepEqual(cs.map((c) => c.name), ["a"]);
});

function sessao(over = {}) {
  return buildSessionCases({
    cwdCase: { name: "bento", dir: `${BASE}/bento` },
    rootCases: [{ name: "bento", dir: `${BASE}/bento` }, { name: "francisco", dir: `${BASE}/francisco` }],
    relacionados: ["carlos"],
    base: BASE,
    ...over,
  });
}

test("buildSessionCases: principal = cwd; adicionados = roots menos o principal; relacionados do yaml", () => {
  const s = sessao();
  assert.equal(s.primary.name, "bento");
  assert.deepEqual(s.adicionados.map((c) => c.name), ["francisco"]);
  assert.deepEqual(s.relacionados.map((c) => c.name), ["carlos"]);
  assert.equal(s.relacionados[0].dir, `${BASE}/carlos`);
  assert.deepEqual(s.ativos().map((c) => c.name), ["bento", "francisco"]);
  assert.deepEqual(s.permitidos().map((c) => c.name), ["bento", "francisco", "carlos"]);
});

test("buildSessionCases: sem cwd de caso, o primeiro root vira principal", () => {
  const s = sessao({ cwdCase: null });
  assert.equal(s.primary.name, "bento");
  assert.deepEqual(s.adicionados.map((c) => c.name), ["francisco"]);
});

test("buildSessionCases: relacionado que tambem e ativo nao duplica", () => {
  const s = sessao({ relacionados: ["francisco", "carlos"] });
  assert.deepEqual(s.permitidos().map((c) => c.name), ["bento", "francisco", "carlos"]);
});

test("resolve: sem nome devolve o principal; nome permitido devolve o caso; fora lanca", () => {
  const s = sessao();
  assert.equal(s.resolve().name, "bento");
  assert.equal(s.resolve("carlos").name, "carlos");
  assert.throws(() => s.resolve("outro"), /Caso nao permitido nesta sessao: outro/);
});

test("resolve: sem principal lanca 'Sessao nao esta dentro de um caso.'", () => {
  const s = buildSessionCases({ cwdCase: null, rootCases: [], relacionados: [], base: BASE });
  assert.equal(s.primary, null);
  assert.throws(() => s.resolve(), /Sessao nao esta dentro de um caso\./);
});

test("escopo: omitido = ativos; lista = subconjunto validado; 'relacionados' expande", () => {
  const s = sessao();
  assert.deepEqual(s.escopo().map((c) => c.name), ["bento", "francisco"]);
  assert.deepEqual(s.escopo(["francisco"]).map((c) => c.name), ["francisco"]);
  assert.deepEqual(s.escopo(["relacionados"]).map((c) => c.name), ["carlos"]);
  assert.deepEqual(s.escopo(["bento", "relacionados", "bento"]).map((c) => c.name), ["bento", "carlos"]);
  assert.throws(() => s.escopo(["outro"]), /Caso nao permitido nesta sessao: outro/);
});

test("escopo: lista vazia equivale a omitida", () => {
  const s = sessao();
  assert.deepEqual(s.escopo([]).map((c) => c.name), ["bento", "francisco"]);
});
