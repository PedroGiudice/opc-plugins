import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OUTPUT_CAP_CHARS, renderMetadata } from "./format.mjs";

// Shape real do GET /api/cases/{name}/metadata (caso_metadata.rs). A falencia
// Oxigenio x Madeirit trazia 50 dispositivos, 164 numeros de processo, 31
// contratos e 46 valores envolvidos: 66 mil caracteres.
function ficha({ dispositivos = 50, numeros = 164, contratos = 31, valores = 46 } = {}) {
  return {
    caso: "falencia-grande",
    natureza: "judicial",
    tipo: "processo",
    cliente: "Oxigênio",
    polo: null,
    subfamilia: "falencia",
    output_style: null,
    briefing: {
      advogados: ["Fulano de Tal (OAB/SP 123.456)", "Beltrana (OAB/SP 654.321)"],
      autor: "Madeirit S/A",
      contratantes: [],
      contratos: Array.from({ length: contratos }, (_, i) =>
        `Contrato de locação nº ${i + 1} entre Madeirit S/A e GVA Indústria, aluguel mensal de R$ ${i + 1}.000,00, aditado em 05/01/1998 e distratado em 20/02/2004`),
      data_distribuicao: "2005-03-01",
      dispositivos: Array.from({ length: dispositivos }, (_, i) =>
        `Decisão ${i + 1}: defiro o pedido de habilitação do crédito no valor apurado pelo administrador judicial, com inclusão no quadro geral de credores na classe quirografária, observado o art. 83 da Lei 11.101/2005, e determino a intimação das partes para manifestação no prazo legal.`),
      documentos: [],
      juiz: "Dr. Juiz de Direito da 1ª Vara de Falências",
      numeros_processo: Array.from({ length: numeros }, (_, i) => `00${String(i).padStart(5, "0")}-88.2005.8.26.0100`),
      resumo: "Falência requerida por Madeirit S/A. ".repeat(100),
      reu: "GVA Indústria e Comércio S/A",
      tipo: "processo",
      tipo_acao: "Falência",
      valor_causa: 2280000,
      vara: "1ª Vara de Falências e Recuperações Judiciais",
    },
    valores_envolvidos: Array.from({ length: valores }, (_, i) => ({
      valor: `R$ ${i + 1}0.000,00`,
      origem: `…à Gran Comp Insumos e Compensados Ltda-ME, cuja proposta de redução do aluguel para R$ ${i + 1}0.000,00 e parcelamento do débito foi indeferida em 21/09/2020`,
    })),
    fontes: { briefing: true, case_yaml: true },
  };
}

// O JSON da resposta: da linha que abre ("{" ou "[" sozinho) ate a que fecha
// na coluna 0; o aviso vem antes e a continuacao depois.
const jsonDe = (texto) => {
  const ini = texto.search(/^[[{]$/m);
  const fim = Math.max(texto.lastIndexOf("\n]"), texto.lastIndexOf("\n}")) + 2;
  return JSON.parse(texto.slice(ini, fim));
};

test("ficha que cabe no teto sai identica ao JSON da API", () => {
  const f = ficha({ dispositivos: 3, numeros: 3, contratos: 3, valores: 3 });
  assert.equal(renderMetadata(f), JSON.stringify(f, null, 2));
});

test("ficha grande: cabe no teto, campos simples intactos e cada lista e um prefixo da original", () => {
  const f = ficha();
  const texto = renderMetadata(f);
  assert.ok(texto.length <= OUTPUT_CAP_CHARS, `${texto.length} chars`);
  const j = jsonDe(texto);
  for (const k of ["caso", "natureza", "tipo", "cliente", "polo", "subfamilia", "output_style", "fontes"]) {
    assert.deepEqual(j[k], f[k], k);
  }
  for (const k of ["autor", "reu", "juiz", "vara", "resumo", "valor_causa", "tipo_acao", "data_distribuicao"]) {
    assert.deepEqual(j.briefing[k], f.briefing[k], `briefing.${k}`);
  }
  for (const k of ["contratos", "dispositivos", "numeros_processo", "advogados"]) {
    assert.deepEqual(j.briefing[k], f.briefing[k].slice(0, j.briefing[k].length), `briefing.${k}`);
  }
  assert.deepEqual(j.valores_envolvidos, f.valores_envolvidos.slice(0, j.valores_envolvidos.length));
});

test("ficha grande: toda lista cortada aparece no aviso com quantos itens vieram e como ler o resto", () => {
  const f = ficha();
  const texto = renderMetadata(f);
  const j = jsonDe(texto);
  const aviso = texto.slice(0, texto.search(/^[[{]$/m));
  const listas = {
    "briefing.contratos": f.briefing.contratos.length,
    "briefing.dispositivos": f.briefing.dispositivos.length,
    "briefing.numeros_processo": f.briefing.numeros_processo.length,
    valores_envolvidos: f.valores_envolvidos.length,
  };
  for (const [nome, total] of Object.entries(listas)) {
    const entregue = nome.startsWith("briefing.") ? j.briefing[nome.slice(9)].length : j[nome].length;
    assert.ok(entregue >= 1, `${nome} sem nenhum item`);
    assert.ok(entregue < total, `${nome} deveria vir cortada`);
    assert.ok(aviso.includes(`${nome} ${entregue} de ${total}`), `${nome} fora do aviso`);
    assert.ok(aviso.includes(`metadata(lista: "${nome}", a_partir: ${entregue + 1})`), `${nome} sem a continuacao`);
  }
});

test("leitura de uma lista pela continuacao entrega a lista inteira, item inteiro, dentro do teto", () => {
  const f = ficha({ dispositivos: 400 });
  const lidos = [];
  let aPartir = 1;
  let chamadas = 0;
  while (aPartir !== null) {
    const texto = renderMetadata(f, { lista: "briefing.dispositivos", aPartir });
    assert.ok(texto.length <= OUTPUT_CAP_CHARS, `${texto.length} chars`);
    lidos.push(...jsonDe(texto));
    const m = /Continua: metadata\(lista: "briefing\.dispositivos", a_partir: (\d+)\)/.exec(texto);
    aPartir = m ? Number(m[1]) : null;
    assert.ok(++chamadas < 100, "laco sem fim");
  }
  assert.ok(chamadas > 1);
  assert.deepEqual(lidos, f.briefing.dispositivos);
});

test("lista de valores envolvidos tambem se le pela continuacao", () => {
  const f = ficha({ valores: 300 });
  const texto = renderMetadata(f, { lista: "valores_envolvidos" });
  assert.match(texto, /itens 1-\d+ de 300/);
  assert.deepEqual(jsonDe(texto), f.valores_envolvidos.slice(0, jsonDe(texto).length));
});

test("lista inexistente responde quais listas a ficha tem", () => {
  const texto = renderMetadata(ficha(), { lista: "briefing.pedidos" });
  assert.match(texto, /briefing\.dispositivos/);
  assert.match(texto, /valores_envolvidos/);
  assert.doesNotMatch(texto, /^[[{]$/m);
});

test("item sozinho maior que o teto sai inteiro", () => {
  const f = ficha({ dispositivos: 2 });
  f.briefing.dispositivos[0] = "x".repeat(OUTPUT_CAP_CHARS + 500);
  const texto = renderMetadata(f, { lista: "briefing.dispositivos" });
  assert.equal(jsonDe(texto)[0], f.briefing.dispositivos[0]);
  assert.match(texto, /a_partir: 2\)/);
});

test("ficha sem briefing e pequena sai como veio", () => {
  const f = { caso: "casca", natureza: "indeterminada", briefing: null, valores_envolvidos: [], fontes: { briefing: false, case_yaml: false } };
  assert.equal(renderMetadata(f), JSON.stringify(f, null, 2));
});

test("tool metadata aceita lista e a_partir e passa pelo renderMetadata", () => {
  const src = readFileSync(new URL("./server.mjs", import.meta.url), "utf-8");
  const tool = src.slice(src.indexOf('"metadata",'), src.indexOf("// Tool: recommend"));
  assert.match(tool, /lista:\s*z\.string\(\)/);
  assert.match(tool, /a_partir:\s*z\.number\(\)\.int\(\)\.min\(1\)/);
  assert.match(tool, /renderMetadata\(data,\s*\{\s*lista,\s*aPartir:\s*a_partir\s*\}\)/);
});
