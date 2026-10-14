import { test } from "node:test";
import assert from "node:assert/strict";
import { textoCrossRefVazio } from "./format.mjs";

// Resposta da API para caso sem citacoes indexadas (CMR-294): vazia, com o
// aviso pronto. Vazio ali NAO e "ninguem cita o item".
const semCitacoes = {
  kind: "processo",
  value: "1001141-60.2026.5.02.0708",
  total_hits: 0,
  by_documento: [],
  citacoes_indexadas: false,
  aviso: "Este caso não tem citações indexadas (processos, recursos, súmulas, temas e dispositivos citados não foram extraídos dos autos), então o cross_ref não tem como dizer onde o item é citado. Use search com o item citado como consulta.",
};

test("caso sem citacoes indexadas devolve o aviso da API, nunca 'Nenhuma ocorrencia'", () => {
  const t = textoCrossRefVazio(semCitacoes, "processo", semCitacoes.value);
  assert.equal(t, semCitacoes.aviso);
  assert.doesNotMatch(t, /Nenhuma ocorr/);
});

test("sem citacoes indexadas e aviso ausente ou vazio cai num texto equivalente", () => {
  for (const aviso of [undefined, "", "   "]) {
    const t = textoCrossRefVazio({ ...semCitacoes, aviso }, "tema", "988");
    assert.match(t, /não tem citações indexadas/);
    assert.match(t, /search/);
    assert.doesNotMatch(t, /Nenhuma ocorr/);
  }
});

test("caso com citacoes indexadas e sem resultado e ausencia verdadeira", () => {
  const t = textoCrossRefVazio(
    { ...semCitacoes, citacoes_indexadas: true, aviso: undefined },
    "sumula",
    "STJ-297"
  );
  assert.equal(t, "Nenhuma ocorrencia de sumula='STJ-297' nos autos.");
});

test("API anterior a CMR-294 (sem o campo) mantem o texto de ausencia", () => {
  const t = textoCrossRefVazio({ total_hits: 0, by_documento: [] }, "processo", "X");
  assert.equal(t, "Nenhuma ocorrencia de processo='X' nos autos.");
});
