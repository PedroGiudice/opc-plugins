// extracao/xlsx.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { lerXlsx } from "./xlsx.mjs";

async function planilha(montar) {
  const wb = new ExcelJS.Workbook();
  await montar(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test("lerXlsx: valores em texto: número, string, data ISO, booleano, rich text, hyperlink", async () => {
  const buf = await planilha(async (wb) => {
    const ws = wb.addWorksheet("Dados");
    ws.addRow(["Item", "Valor", "Data", "Ok"]);
    ws.addRow(["Taxa", 1234.5, new Date(Date.UTC(2026, 8, 1)), true]);
    ws.getCell("A3").value = { richText: [{ text: "Rich " }, { text: "Text" }] };
    ws.getCell("B3").value = { text: "site", hyperlink: "https://x" };
    ws.getCell("C3").value = new Date(Date.UTC(2026, 8, 1, 10, 30));
  });
  const d = await lerXlsx(buf);
  assert.equal(d.abas.length, 1);
  assert.equal(d.abas[0].nome, "Dados");
  assert.deepEqual(d.abas[0].linhas, [
    ["Item", "Valor", "Data", "Ok"],
    ["Taxa", "1234.5", "2026-09-01", "VERDADEIRO"],
    ["Rich Text", "site", "2026-09-01T10:30:00", ""],
  ]);
  assert.deepEqual(d.avisos, []);
});

test("lerXlsx: fórmula com cache usa o resultado; sem cache vira vazio e aviso", async () => {
  const buf = await planilha(async (wb) => {
    const ws = wb.addWorksheet("Calc");
    ws.getCell("A1").value = 2;
    ws.getCell("B1").value = { formula: "A1*2", result: 4 };
    ws.getCell("C1").value = { formula: "A1*3" };
  });
  const d = await lerXlsx(buf);
  assert.deepEqual(d.abas[0].linhas, [["2", "4", ""]]);
  assert.deepEqual(d.avisos, ["Calc: 1 fórmula sem valor em cache (C1); abra e salve no Excel para preencher"]);
});

test("lerXlsx: aba oculta listada com oculta=true, sem linhas, e em aviso", async () => {
  const buf = await planilha(async (wb) => {
    wb.addWorksheet("Visível").addRow(["a"]);
    const h = wb.addWorksheet("Oculta");
    h.addRow(["segredo"]);
    h.state = "hidden";
  });
  const d = await lerXlsx(buf);
  assert.deepEqual(d.abas.map((a) => [a.nome, a.oculta, a.linhas.length]), [["Visível", false, 1], ["Oculta", true, 0]]);
  assert.deepEqual(d.avisos, ["aba oculta não renderizada: Oculta"]);
});

test("lerXlsx: teto de linhas corta e registra cortadas + aviso", async () => {
  const buf = await planilha(async (wb) => {
    const ws = wb.addWorksheet("Grande");
    for (let i = 1; i <= 2500; i++) ws.addRow([i]);
  });
  const d = await lerXlsx(buf, { maxLinhasPorAba: 2000 });
  assert.equal(d.abas[0].linhas.length, 2000);
  assert.equal(d.abas[0].cortadas, 500);
  assert.deepEqual(d.avisos, ["Grande: 500 linhas além do teto de 2000 ficaram de fora"]);
});

test("lerXlsx: célula mesclada: valor na primeira, demais vazias; linhas com buracos preservam colunas", async () => {
  const buf = await planilha(async (wb) => {
    const ws = wb.addWorksheet("M");
    ws.getCell("A1").value = "Título";
    ws.mergeCells("A1:C1");
    ws.getCell("A2").value = "a";
    ws.getCell("C2").value = "c";
  });
  const d = await lerXlsx(buf);
  assert.deepEqual(d.abas[0].linhas, [["Título", "", ""], ["a", "", "c"]]);
});

test("lerXlsx: buffer inválido é ilegível, com zero abas", async () => {
  const d = await lerXlsx(Buffer.from("não é xlsx"));
  assert.deepEqual(d.abas, []);
  assert.equal(d.ilegivel, true);
  assert.match(d.motivo, /^planilha não abre \(/);
  const cfb = await lerXlsx(Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(504)]));
  assert.deepEqual([cfb.ilegivel, cfb.motivo], [true, "protegida por senha (ou .xls antigo renomeado)"]);
});

test("lerXlsx: apara linhas e colunas vazias do fim, preserva as do meio", async () => {
  const buf = await planilha(async (wb) => {
    const ws = wb.addWorksheet("Aparar");
    ws.getCell("A1").value = "a";
    ws.getCell("B1").value = "b";
    ws.getCell("A3").value = "c";
    // células com valor vazio e estilo alargam o intervalo usado sem conteúdo
    ws.getCell("E5").value = "";
    ws.getCell("D6").value = null;
    ws.getCell("D6").font = { bold: true };
  });
  const d = await lerXlsx(buf);
  assert.deepEqual(d.abas[0].linhas, [["a", "b"], ["", ""], ["c", ""]]);
});

test("lerXlsx: aba só com vazios fica sem linhas e sem aviso", async () => {
  const buf = await planilha(async (wb) => {
    const ws = wb.addWorksheet("Nada");
    ws.getCell("C3").font = { bold: true };
  });
  const d = await lerXlsx(buf);
  assert.deepEqual(d.abas, [{ nome: "Nada", oculta: false, linhas: [], cortadas: 0 }]);
  assert.deepEqual(d.avisos, []);
});

test("lerXlsx: erro de célula devolve o código; fórmula de data usa o resultado", async () => {
  const buf = await planilha(async (wb) => {
    const ws = wb.addWorksheet("E");
    ws.getCell("A1").value = { error: "#REF!" };
    ws.getCell("B1").value = { formula: "TODAY()", result: new Date(Date.UTC(2026, 9, 15)) };
  });
  const d = await lerXlsx(buf);
  assert.deepEqual(d.abas[0].linhas, [["#REF!", "2026-10-15"]]);
  assert.deepEqual(d.avisos, []);
});

test("lerXlsx: fórmula com resultado em cache 0 ou FALSO não é 'sem cache'", async () => {
  const buf = await planilha(async (wb) => {
    const ws = wb.addWorksheet("Z");
    ws.getCell("A1").value = 5;
    ws.getCell("B1").value = { formula: "A1*0", result: 0 };
    ws.getCell("C1").value = { formula: "1=2", result: false };
    // a última linha só tem fórmulas de resultado falsy: tem de sobreviver ao aparo
    ws.getCell("A3").value = { formula: "A1*0", result: 0 };
    ws.getCell("B3").value = { formula: "1=2", result: false };
  });
  const d = await lerXlsx(buf);
  assert.deepEqual(d.abas[0].linhas, [["5", "0", "FALSO"], ["", "", ""], ["0", "FALSO", ""]]);
  assert.deepEqual(d.avisos, []);
});

test("lerXlsx: números sem ruído de ponto flutuante (15 dígitos, como o Excel), em valor e em resultado de fórmula", async () => {
  const buf = await planilha(async (wb) => {
    const ws = wb.addWorksheet("N");
    ws.getCell("A1").value = 4899.4400000000005;
    ws.getCell("B1").value = 16232.439999999999;
    ws.getCell("C1").value = 0.1 + 0.2;
    ws.getCell("D1").value = 1234567;
    ws.getCell("E1").value = 1e21;
    ws.getCell("F1").value = { formula: "A1*1", result: 4899.4400000000005 };
    ws.getCell("G1").value = -0.30000000000000004;
  });
  const d = await lerXlsx(buf);
  assert.deepEqual(d.abas[0].linhas, [["4899.44", "16232.44", "0.3", "1234567", "1e+21", "4899.44", "-0.3"]]);
  assert.deepEqual(d.avisos, []);
});

test("lerXlsx: maxBytes (hook) não tenta abrir planilha maior: devolve grandeDemais sem ler", async () => {
  const buf = await planilha(async (wb) => { wb.addWorksheet("A").addRow(["x"]); });
  const d = await lerXlsx(buf, { maxBytes: buf.length - 1 });
  assert.deepEqual(d, { abas: [], avisos: [], grandeDemais: true });
  const ok = await lerXlsx(buf, { maxBytes: buf.length });
  assert.equal(ok.abas.length, 1);
});
