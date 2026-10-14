import { test } from "node:test";
import assert from "node:assert/strict";
import { lerDocx } from "./docx.mjs";
import { construirDocx, documento, paragrafo, tabela, numeracaoDecimal3Niveis, W } from "./fixtures/docx-builder.mjs";

const textoDe = (bloco) => bloco.segmentos.map((s) => s.texto).join("");

test("lerDocx: parágrafos em ordem, texto com espaços preservados, tab e quebra de linha", () => {
  const xml = documento(
    `<w:p><w:r><w:t xml:space="preserve">Cláusula </w:t></w:r><w:r><w:t>Primeira</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p>`,
  );
  const d = lerDocx(construirDocx({ documentXml: xml }));
  assert.equal(d.blocos.length, 2);
  assert.equal(textoDe(d.blocos[0]), "Cláusula Primeira");
  assert.equal(textoDe(d.blocos[1]), "a\tb\nc");
  assert.equal(d.blocos[0].numero, null);
  assert.equal(d.temNumeracao, false);
});

test("lerDocx: texto dentro de hyperlink, sdtContent e fldSimple entra; instrText não", () => {
  const xml = documento(
    `<w:p><w:hyperlink r:id="rId9"><w:r><w:t>link</w:t></w:r></w:hyperlink></w:p>` +
      `<w:p><w:sdt><w:sdtContent><w:r><w:t>campo</w:t></w:r></w:sdtContent></w:sdt></w:p>` +
      `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>7</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
  );
  const d = lerDocx(construirDocx({ documentXml: xml }));
  assert.deepEqual(d.blocos.map(textoDe), ["link", "campo", "7"]);
});

test("lerDocx: numeração decimal em 3 níveis renderizada como o Word mostra", () => {
  const xml = documento(
    paragrafo("Objeto", { numId: 1, ilvl: 0 }) +
      paragrafo("Escopo", { numId: 1, ilvl: 1 }) +
      paragrafo("Detalhe", { numId: 1, ilvl: 2 }) +
      paragrafo("Outro detalhe", { numId: 1, ilvl: 2 }) +
      paragrafo("Preço", { numId: 1, ilvl: 0 }) +
      paragrafo("Reajuste", { numId: 1, ilvl: 1 }),
  );
  const d = lerDocx(construirDocx({ documentXml: xml, numberingXml: numeracaoDecimal3Niveis() }));
  assert.deepEqual(d.blocos.map((b) => b.numero), ["1.", "1.1.", "1.1.1.", "1.1.2.", "2.", "2.1."]);
  assert.equal(d.temNumeracao, true);
  assert.equal(d.niveisNumeracao, 3);
});

test("lerDocx: numId diferente com startOverride reinicia a contagem", () => {
  const xml = documento(
    paragrafo("A", { numId: 1 }) + paragrafo("B", { numId: 1 }) + paragrafo("C", { numId: 2 }) + paragrafo("D", { numId: 2 }),
  );
  const num = numeracaoDecimal3Niveis({ numIds: [1, 2], startOverrides: { 2: 1 } });
  const d = lerDocx(construirDocx({ documentXml: xml, numberingXml: num }));
  assert.deepEqual(d.blocos.map((b) => b.numero), ["1.", "2.", "1.", "2."]);
});

test("lerDocx: numFmt lowerLetter, upperRoman e bullet", () => {
  const numbering = `<?xml version="1.0"?><w:numbering ${W}>
    <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%1)"/></w:lvl></w:abstractNum>
    <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="upperRoman"/><w:lvlText w:val="%1 -"/></w:lvl></w:abstractNum>
    <w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val=""/></w:lvl></w:abstractNum>
    <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="3"><w:abstractNumId w:val="2"/></w:num>
  </w:numbering>`;
  const xml = documento(paragrafo("x", { numId: 1 }) + paragrafo("y", { numId: 1 }) + paragrafo("z", { numId: 2 }) + paragrafo("w", { numId: 2 }) + paragrafo("v", { numId: 3 }));
  const d = lerDocx(construirDocx({ documentXml: xml, numberingXml: numbering }));
  assert.deepEqual(d.blocos.map((b) => b.numero), ["a)", "b)", "I -", "II -", "-"]);
});

test("lerDocx: numeração herdada do estilo (pStyle -> numPr em styles.xml, com basedOn)", () => {
  const styles = `<?xml version="1.0"?><w:styles ${W}>
    <w:style w:type="paragraph" w:styleId="Base"><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
    <w:style w:type="paragraph" w:styleId="Clausula"><w:basedOn w:val="Base"/></w:style>
  </w:styles>`;
  const xml = documento(paragrafo("Objeto", { estilo: "Clausula" }) + paragrafo("Preço", { estilo: "Clausula" }));
  const d = lerDocx(construirDocx({ documentXml: xml, numberingXml: numeracaoDecimal3Niveis(), stylesXml: styles }));
  assert.deepEqual(d.blocos.map((b) => b.numero), ["1.", "2."]);
});

test("lerDocx: numPr com numId 0 desliga a numeração do estilo", () => {
  const styles = `<?xml version="1.0"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Clausula"><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style></w:styles>`;
  const xml = documento(paragrafo("Objeto", { estilo: "Clausula" }) + paragrafo("Sem número", { estilo: "Clausula", numId: 0 }));
  const d = lerDocx(construirDocx({ documentXml: xml, numberingXml: numeracaoDecimal3Niveis(), stylesXml: styles }));
  assert.deepEqual(d.blocos.map((b) => b.numero), ["1.", null]);
});

test("lerDocx: tabela vira bloco com linhas e células; parágrafos da célula unidos por ' / '", () => {
  const xml = documento(
    `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Valor</w:t></w:r></w:p><w:p><w:r><w:t>mensal</w:t></w:r></w:p></w:tc></w:tr>` +
      `<w:tr><w:tc><w:p><w:r><w:t>Taxa</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>R$ 100</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`,
  );
  const d = lerDocx(construirDocx({ documentXml: xml }));
  assert.deepEqual(d.blocos[0], { tipo: "tabela", linhas: [["Item", "Valor / mensal"], ["Taxa", "R$ 100"]] });
});

test("lerDocx: célula com gridSpan ocupa colunas vazias; tabela aninhada achatada no texto da célula", () => {
  const xml = documento(
    `<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Título</w:t></w:r></w:p></w:tc></w:tr>` +
      `<w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc>${tabela([["x", "y"]])}</w:tc></w:tr></w:tbl>`,
  );
  const d = lerDocx(construirDocx({ documentXml: xml }));
  assert.deepEqual(d.blocos[0].linhas, [["Título", ""], ["a", "x | y"]]);
});

test("lerDocx: parágrafo vazio não vira bloco; buffer que não é zip vira aviso e zero blocos", () => {
  const d1 = lerDocx(construirDocx({ documentXml: documento(`<w:p/><w:p><w:r><w:t>só este</w:t></w:r></w:p>`) }));
  assert.equal(d1.blocos.length, 1);
  const d2 = lerDocx(Buffer.from("isto não é um docx"));
  assert.equal(d2.blocos.length, 0);
  assert.match(d2.avisos[0], /não foi possível abrir/i);
});
