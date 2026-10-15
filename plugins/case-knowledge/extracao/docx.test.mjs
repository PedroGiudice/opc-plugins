import { test } from "node:test";
import assert from "node:assert/strict";
import { lerDocx, deveInflar } from "./docx.mjs";
import { construirDocx, documento, paragrafo, tabela, numeracaoDecimal3Niveis, W, W_STRICT } from "./fixtures/docx-builder.mjs";

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
  assert.deepEqual(d.blocos[0].tipo, "tabela");
  assert.deepEqual(d.blocos[0].linhas, [["Item", "Valor / mensal"], ["Taxa", "R$ 100"]]);
});

test("lerDocx: célula com gridSpan ocupa colunas vazias; tabela aninhada achatada no texto da célula", () => {
  const xml = documento(
    `<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Título</w:t></w:r></w:p></w:tc></w:tr>` +
      `<w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc>${tabela([["x", "y"]])}</w:tc></w:tr></w:tbl>`,
  );
  const d = lerDocx(construirDocx({ documentXml: xml }));
  assert.deepEqual(d.blocos[0].linhas, [["Título", ""], ["a", "x | y"]]);
});

test("lerDocx: parágrafo vazio não vira bloco; buffer que não é zip é ilegível (sem blocos)", () => {
  const d1 = lerDocx(construirDocx({ documentXml: documento(`<w:p/><w:p><w:r><w:t>só este</w:t></w:r></w:p>`) }));
  assert.equal(d1.blocos.length, 1);
  const d2 = lerDocx(Buffer.from("isto não é um docx"));
  assert.equal(d2.ilegivel, true);
  assert.match(d2.motivo, /^zip inválido/);
  assert.equal(d2.blocos.length, 0);
});

// ---------- sdt e customXml em todos os níveis ----------

test("lerDocx: conteúdo de célula dentro de sdt entra no texto da célula", () => {
  const xml = documento(
    `<w:tbl><w:tr><w:tc><w:sdt><w:sdtPr/><w:sdtContent><w:p><w:r><w:t>dentro</w:t></w:r></w:p></w:sdtContent></w:sdt></w:tc></w:tr></w:tbl>`,
  );
  const d = lerDocx(construirDocx({ documentXml: xml }));
  assert.deepEqual(d.blocos[0].linhas, [["dentro"]]);
});

test("lerDocx: linha de tabela dentro de sdt vira linha", () => {
  const xml = documento(
    `<w:tbl><w:sdt><w:sdtContent><w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr></w:sdtContent></w:sdt></w:tbl>`,
  );
  const d = lerDocx(construirDocx({ documentXml: xml }));
  assert.deepEqual(d.blocos[0].linhas, [["a", "b"]]);
});

test("lerDocx: célula dentro de sdt vira célula da linha", () => {
  const xml = documento(
    `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:sdt><w:sdtContent><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:sdtContent></w:sdt></w:tr></w:tbl>`,
  );
  const d = lerDocx(construirDocx({ documentXml: xml }));
  assert.deepEqual(d.blocos[0].linhas, [["a", "b"]]);
});

test("lerDocx: parágrafo dentro de customXml no corpo vira bloco", () => {
  const xml = documento(
    `<w:customXml w:element="clausula"><w:p><w:r><w:t>embrulhado</w:t></w:r></w:p></w:customXml>`,
  );
  const d = lerDocx(construirDocx({ documentXml: xml }));
  assert.deepEqual(d.blocos.map(textoDe), ["embrulhado"]);
});

// ---------- contadores de numeração ----------

const numeracaoUmNivel = (lvls, nums) =>
  `<?xml version="1.0"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0">${lvls}</w:abstractNum>${nums}</w:numbering>`;

test("lerDocx: w:start 0 numera a partir de zero", () => {
  const numbering = numeracaoUmNivel(
    `<w:lvl w:ilvl="0"><w:start w:val="0"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>`,
    `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`,
  );
  const xml = documento(paragrafo("a", { numId: 1 }) + paragrafo("b", { numId: 1 }));
  const d = lerDocx(construirDocx({ documentXml: xml, numberingXml: numbering }));
  assert.deepEqual(d.blocos.map((b) => b.numero), ["0.", "1."]);
});

test("lerDocx: nível superior nunca emitido aparece com o valor de start", () => {
  const numbering = numeracaoUmNivel(
    `<w:lvl w:ilvl="0"><w:start w:val="5"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>` +
      `<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2."/></w:lvl>`,
    `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`,
  );
  const xml = documento(paragrafo("sub", { numId: 1, ilvl: 1 }));
  const d = lerDocx(construirDocx({ documentXml: xml, numberingXml: numbering }));
  assert.deepEqual(d.blocos.map((b) => b.numero), ["5.1."]);
});

test("lerDocx: numIds do mesmo abstractNum sem startOverride continuam a lista", () => {
  const xml = documento(
    paragrafo("A", { numId: 1 }) + paragrafo("B", { numId: 1 }) + paragrafo("C", { numId: 2 }) + paragrafo("D", { numId: 2 }),
  );
  const num = numeracaoDecimal3Niveis({ numIds: [1, 2] });
  const d = lerDocx(construirDocx({ documentXml: xml, numberingXml: num }));
  assert.deepEqual(d.blocos.map((b) => b.numero), ["1.", "2.", "3.", "4."]);
});

// ---------- marcas de revisão, comentários, notas, cabeçalho e avisos ----------

const RUN = (t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const DEL = (t, autor) => `<w:del w:id="9" w:author="${autor}" w:date="2026-09-01T10:00:00Z"><w:r><w:delText xml:space="preserve">${t}</w:delText></w:r></w:del>`;
const INS = (inner, autor) => `<w:ins w:id="8" w:author="${autor}" w:date="2026-09-01T10:00:00Z">${inner}</w:ins>`;

test("lerDocx: inserção e exclusão viram segmentos com marca e autor; texto normal sem marca", () => {
  const xml = documento(`<w:p>${RUN("O CONTRATANTE ")}${DEL("pagará", "Ana")}${INS(RUN("deverá pagar"), "Ana")}${RUN(" em 30 dias.")}</w:p>`);
  const d = lerDocx(construirDocx({ documentXml: xml }));
  assert.deepEqual(d.blocos[0].segmentos, [
    { texto: "O CONTRATANTE ", marca: null },
    { texto: "pagará", marca: "del", autor: "Ana" },
    { texto: "deverá pagar", marca: "ins", autor: "Ana" },
    { texto: " em 30 dias.", marca: null },
  ]);
});

test("lerDocx: inserção de um revisor excluída por outro (ins dentro de del) sai como del do segundo", () => {
  // Ana inseriu "X"; Bruno excluiu a inserção de Ana: w:del(Bruno) > w:ins(Ana) > w:r > w:delText
  const xml = documento(`<w:p>${RUN("a ")}<w:del w:id="1" w:author="Bruno" w:date="2026-09-02T10:00:00Z"><w:ins w:id="2" w:author="Ana" w:date="2026-09-01T10:00:00Z"><w:r><w:delText>X</w:delText></w:r></w:ins></w:del>${RUN(" b")}</w:p>`);
  const d = lerDocx(construirDocx({ documentXml: xml }));
  assert.deepEqual(d.blocos[0].segmentos[1], { texto: "X", marca: "del", autor: "Bruno" });
});

test("lerDocx: moveFrom conta como del e moveTo como ins", () => {
  const xml = documento(`<w:p><w:moveFrom w:id="1" w:author="Ana" w:date="2026-09-01T10:00:00Z"><w:r><w:delText>fora</w:delText></w:r></w:moveFrom><w:moveTo w:id="2" w:author="Ana" w:date="2026-09-01T10:00:00Z">${RUN("dentro")}</w:moveTo></w:p>`);
  const d = lerDocx(construirDocx({ documentXml: xml }));
  assert.deepEqual(d.blocos[0].segmentos.map((s) => [s.texto, s.marca]), [["fora", "del"], ["dentro", "ins"]]);
});

test("lerDocx: comentário ancorado no fim do range, com autor, data e texto", () => {
  const comments = `<?xml version="1.0"?><w:comments ${W}><w:comment w:id="3" w:author="Ana" w:date="2026-09-01T10:00:00Z"><w:p><w:r><w:t>Conferir </w:t></w:r><w:r><w:t>prazo.</w:t></w:r></w:p><w:p><w:r><w:t>Segunda linha.</w:t></w:r></w:p></w:comment></w:comments>`;
  const xml = documento(`<w:p>${RUN("Prazo de ")}<w:commentRangeStart w:id="3"/>${RUN("30 dias")}<w:commentRangeEnd w:id="3"/><w:r><w:commentReference w:id="3"/></w:r>${RUN(".")}</w:p>`);
  const d = lerDocx(construirDocx({ documentXml: xml, commentsXml: comments }));
  assert.deepEqual(d.blocos[0].segmentos, [
    { texto: "Prazo de ", marca: null },
    { texto: "30 dias", marca: null },
    { texto: "", marca: null, comentarios: ["3"] },
    { texto: ".", marca: null },
  ]);
  assert.deepEqual(d.comentarios, [{ id: "3", autor: "Ana", data: "2026-09-01T10:00:00Z", texto: "Conferir prazo.\nSegunda linha." }]);
});

test("lerDocx: nota de rodapé referenciada vira segmento-nota e entra em notas (separador/continuação ignorados)", () => {
  const footnotes = `<?xml version="1.0"?><w:footnotes ${W}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> Texto da nota.</w:t></w:r></w:p></w:footnote></w:footnotes>`;
  const xml = documento(`<w:p>${RUN("Cláusula")}<w:r><w:footnoteReference w:id="1"/></w:r>${RUN(" segue.")}</w:p>`);
  const d = lerDocx(construirDocx({ documentXml: xml, footnotesXml: footnotes }));
  assert.deepEqual(d.blocos[0].segmentos[1], { texto: "", marca: null, nota: "1" });
  assert.deepEqual(d.notas, [{ id: "1", texto: "Texto da nota." }]);
});

test("lerDocx: cabeçalho e rodapé com texto entram em cabecalhoRodape; vazios não", () => {
  const header = `<?xml version="1.0"?><w:hdr ${W}><w:p><w:r><w:t>CONFIDENCIAL</w:t></w:r></w:p></w:hdr>`;
  const footer = `<?xml version="1.0"?><w:ftr ${W}><w:p/></w:ftr>`;
  const d = lerDocx(construirDocx({ documentXml: documento(paragrafo("x")), headerXml: header, footerXml: footer }));
  assert.deepEqual(d.cabecalhoRodape, ["CONFIDENCIAL"]);
});

test("lerDocx: imagem, objeto, caixa de texto e equação viram avisos com o parágrafo; texto segue", () => {
  const xml = documento(
    `<w:p>${RUN("Assinatura:")}<w:r><w:drawing><wp:inline xmlns:wp="x"/></w:drawing></w:r></w:p>` +
      `<w:p>${RUN("meio")}</w:p>` +
      `<w:p><w:r><w:pict><v:shape xmlns:v="y"><v:textbox><w:txbxContent><w:p>${RUN("dentro da caixa")}</w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r>${RUN("fim")}</w:p>` +
      `<w:p><m:oMathPara xmlns:m="z"><m:oMath/></m:oMathPara>${RUN("eq")}</w:p>` +
      `<w:p><w:r><w:object/></w:r></w:p>`,
  );
  const d = lerDocx(construirDocx({ documentXml: xml }));
  assert.deepEqual(d.blocos.map((b) => b.segmentos.map((s) => s.texto).join("")), ["Assinatura:", "meio", "fim", "eq"]);
  assert.deepEqual(d.avisos, [
    "1 imagem não renderizada (parágrafo 1)",
    "1 caixa de texto ignorada (parágrafo 3)",
    "1 equação não renderizada (parágrafo 4)",
    "1 objeto embutido não renderizado (parágrafo 5)",
  ]);
});

test("lerDocx: duas imagens em parágrafos distintos agregam num aviso só", () => {
  const xml = documento(`<w:p><w:r><w:drawing/></w:r>${RUN("a")}</w:p><w:p>${RUN("b")}</w:p><w:p><w:r><w:drawing/></w:r>${RUN("c")}</w:p>`);
  const d = lerDocx(construirDocx({ documentXml: xml }));
  assert.deepEqual(d.avisos, ["2 imagens não renderizadas (parágrafos 1, 3)"]);
});

test("lerDocx: mc:AlternateContent lê só o Choice; caixa de texto com Fallback VML gera um aviso e nenhum texto", () => {
  const caixa = `<w:txbxContent><w:p>${RUN("CAIXA")}</w:p></w:txbxContent>`;
  const xml = documento(
    `<w:p>${RUN("antes ")}<w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
      `<mc:Choice Requires="wps"><w:drawing><wps:wsp xmlns:wps="w"><wps:txbx>${caixa}</wps:txbx></wps:wsp></w:drawing></mc:Choice>` +
      `<mc:Fallback><w:pict><v:shape xmlns:v="y"><v:textbox>${caixa}</v:textbox></v:shape></w:pict></mc:Fallback>` +
      `</mc:AlternateContent></w:r>${RUN("depois")}</w:p>`,
  );
  const d = lerDocx(construirDocx({ documentXml: xml }));
  assert.deepEqual(d.blocos.map(textoDe), ["antes depois"]);
  assert.deepEqual(d.avisos, ["1 caixa de texto ignorada (parágrafo 1)"]);
});

test("lerDocx: comentário só com commentReference (sem range) ganha âncora e entra em comentarios", () => {
  const comments = `<?xml version="1.0"?><w:comments ${W}><w:comment w:id="5" w:author="Bruno" w:date="2026-09-03T10:00:00Z"><w:p>${RUN("Ver.")}</w:p></w:comment></w:comments>`;
  const xml = documento(`<w:p>${RUN("Multa")}<w:r><w:commentReference w:id="5"/></w:r></w:p>`);
  const d = lerDocx(construirDocx({ documentXml: xml, commentsXml: comments }));
  assert.deepEqual(d.blocos[0].segmentos, [{ texto: "Multa", marca: null }, { texto: "", marca: null, comentarios: ["5"] }]);
  assert.deepEqual(d.comentarios.map((c) => c.id), ["5"]);
});

test("lerDocx: marca de revisão e âncora em célula de tabela saem na notação do sidecar", () => {
  const comments = `<?xml version="1.0"?><w:comments ${W}><w:comment w:id="1" w:author="Ana" w:date="d"><w:p>${RUN("ok?")}</w:p></w:comment></w:comments>`;
  const xml = documento(
    `<w:tbl><w:tr><w:tc><w:p>${RUN("R$ ")}${DEL("100", "Ana")}${INS(RUN("200"), "Bruno")}<w:commentRangeEnd w:id="1"/></w:p></w:tc></w:tr></w:tbl>`,
  );
  const d = lerDocx(construirDocx({ documentXml: xml, commentsXml: comments }));
  assert.deepEqual(d.blocos[0].linhas, [["R$ {--100--}[Ana]{++200++}[Bruno][^c1]"]]);
  assert.deepEqual(d.comentarios.map((c) => c.id), ["1"]);
});

test("lerDocx: hífen inseparável vira hífen; nota de fim vira aviso", () => {
  const xml = documento(`<w:p><w:r><w:t>12.345.678/0001</w:t><w:noBreakHyphen/><w:t>90</w:t></w:r><w:r><w:endnoteReference w:id="2"/></w:r></w:p>`);
  const d = lerDocx(construirDocx({ documentXml: xml }));
  assert.deepEqual(d.blocos.map(textoDe), ["12.345.678/0001-90"]);
  assert.deepEqual(d.avisos, ["1 nota de fim não renderizada (parágrafo 1)"]);
});

test("lerDocx: cabeçalho em tabela entra com as células; texto excluído no cabeçalho fica de fora", () => {
  const header = `<?xml version="1.0"?><w:hdr ${W}>${tabela([["LOGO", "Contrato nº 7"]])}<w:p>${RUN("Minuta ")}${DEL("v1", "Ana")}${INS(RUN("v2"), "Ana")}</w:p></w:hdr>`;
  const d = lerDocx(construirDocx({ documentXml: documento(paragrafo("x")), headerXml: header }));
  assert.deepEqual(d.cabecalhoRodape, ["LOGO | Contrato nº 7\nMinuta v2"]);
});

// ---------- R9: exclusão vence em qualquer profundidade ----------

test("lerDocx: exclusão dentro de inserção (ins(Ana) > del(Bruno)) sai como del de Bruno", () => {
  const xml = documento(`<w:p>${RUN("R$ ")}<w:ins w:id="1" w:author="Ana"><w:del w:id="2" w:author="Bruno"><w:r><w:delText>XXXX</w:delText></w:r></w:del></w:ins></w:p>`);
  const d = lerDocx(construirDocx({ documentXml: xml }));
  assert.deepEqual(d.blocos[0].segmentos[1], { texto: "XXXX", marca: "del", autor: "Bruno" });
});

test("lerDocx: no cabeçalho, exclusão dentro de inserção fica fora do texto aceito (parágrafo e célula)", () => {
  const insDel = `<w:ins w:id="1" w:author="Ana">${RUN("novo")}<w:del w:id="2" w:author="Bruno"><w:r><w:delText>velho</w:delText></w:r></w:del></w:ins>`;
  const header = `<?xml version="1.0"?><w:hdr ${W}><w:p>${insDel}</w:p><w:tbl><w:tr><w:tc><w:p>${insDel}</w:p></w:tc></w:tr></w:tbl></w:hdr>`;
  const d = lerDocx(construirDocx({ documentXml: documento(paragrafo("x")), headerXml: header }));
  assert.deepEqual(d.cabecalhoRodape, ["novo\nnovo"]);
});

// ---------- R10: tabela carrega os segmentos das células ----------

test("lerDocx: bloco de tabela traz segmentos de todas as células, em ordem, com marca e âncora", () => {
  const xml = documento(
    `<w:tbl><w:tr><w:tc><w:p>${RUN("R$ ")}${DEL("100", "Ana")}</w:p></w:tc><w:tc><w:p>${RUN("[●]")}<w:r><w:footnoteReference w:id="1"/></w:r></w:p></w:tc></w:tr></w:tbl>`,
  );
  const d = lerDocx(construirDocx({ documentXml: xml }));
  assert.deepEqual(d.blocos[0].linhas, [["R$ {--100--}[Ana]", "[●][^n1]"]]);
  assert.deepEqual(d.blocos[0].segmentos, [
    { texto: "R$ ", marca: null },
    { texto: "100", marca: "del", autor: "Ana" },
    { texto: "[●]", marca: null },
    { texto: "", marca: null, nota: "1" },
  ]);
});

// ---------- zip: só as partes lidas são infladas, com teto por parte (R19) ----------

test("deveInflar: só as partes que o leitor usa, e cada uma até o teto declarado", () => {
  const ok = (name, originalSize = 10) => deveInflar({ name, originalSize }, 1000);
  for (const n of ["word/document.xml", "word/numbering.xml", "word/styles.xml", "word/comments.xml", "word/footnotes.xml", "word/header1.xml", "word/footer12.xml", "word/header.xml"]) assert.equal(ok(n), true, n);
  for (const n of ["word/media/x.bin", "word/media/image1.png", "[Content_Types].xml", "word/embeddings/oleObject1.bin", "word/document.xml.rels", "customXml/item1.xml", "word/settings.xml"]) assert.equal(ok(n), false, n);
  assert.equal(ok("word/document.xml", 1001), false);
});

test("lerDocx: mídia grande no zip não é inflada; parte lida acima do teto vira aviso e o resto segue", async () => {
  const { zipSync, unzipSync } = await import("fflate");
  const base = unzipSync(new Uint8Array(construirDocx({
    documentXml: documento(paragrafo("Corpo")),
    headerXml: `<?xml version="1.0"?><w:hdr ${W}><w:p><w:r><w:t>${"c".repeat(2 * 1024 * 1024)}</w:t></w:r></w:p></w:hdr>`,
  })));
  base["word/media/x.bin"] = new Uint8Array(5 * 1024 * 1024);
  const buf = Buffer.from(zipSync(base, { level: 6 }));
  const d = lerDocx(buf, { maxParteBytes: 1024 * 1024 });
  assert.deepEqual(d.blocos.map(textoDe), ["Corpo"]);
  assert.deepEqual(d.cabecalhoRodape, []);
  assert.deepEqual(d.avisos, ["parte word/header1.xml acima de 1 MiB não lida"]);
});

// ---------- numeração que some sem aviso (R21) ----------

// lista definida por ESTILO de numeração (template de escritório): o
// abstractNum do numId usado só aponta para o estilo; os níveis estão no
// abstractNum que o estilo usa
const NUMERACAO_POR_ESTILO = `<?xml version="1.0"?><w:numbering ${W}>
  <w:abstractNum w:abstractNumId="0"><w:styleLink w:val="ListaContrato"/>
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2."/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1"><w:numStyleLink w:val="ListaContrato"/></w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;
const ESTILO_DE_NUMERACAO = `<?xml version="1.0"?><w:styles ${W}>
  <w:style w:type="numbering" w:styleId="ListaContrato"><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
</w:styles>`;

test("lerDocx: abstractNum com numStyleLink resolve os níveis pelo estilo de numeração", () => {
  const xml = documento(paragrafo("Objeto", { numId: 2, ilvl: 0 }) + paragrafo("Escopo", { numId: 2, ilvl: 1 }) + paragrafo("Preço", { numId: 2, ilvl: 0 }));
  const d = lerDocx(construirDocx({ documentXml: xml, numberingXml: NUMERACAO_POR_ESTILO, stylesXml: ESTILO_DE_NUMERACAO }));
  assert.deepEqual(d.blocos.map((b) => b.numero), ["1.", "1.1.", "2."]);
  assert.deepEqual(d.avisos, []);
});

test("lerDocx: numPr direto mescla campo a campo com o do estilo (ilvl direto + numId do estilo, e vice-versa)", () => {
  const styles = `<?xml version="1.0"?><w:styles ${W}>
    <w:style w:type="paragraph" w:styleId="Clausula"><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
    <w:style w:type="paragraph" w:styleId="Sub"><w:pPr><w:numPr><w:ilvl w:val="1"/></w:numPr></w:pPr></w:style>
  </w:styles>`;
  const p = (t, pPr) => `<w:p><w:pPr>${pPr}</w:pPr><w:r><w:t>${t}</w:t></w:r></w:p>`;
  const xml = documento(
    p("Objeto", '<w:pStyle w:val="Clausula"/>') +
      p("Escopo", '<w:pStyle w:val="Clausula"/><w:numPr><w:ilvl w:val="1"/></w:numPr>') +
      p("Detalhe", '<w:pStyle w:val="Sub"/><w:numPr><w:numId w:val="1"/></w:numPr>'),
  );
  const d = lerDocx(construirDocx({ documentXml: xml, numberingXml: numeracaoDecimal3Niveis(), stylesXml: styles }));
  assert.deepEqual(d.blocos.map((b) => b.numero), ["1.", "1.1.", "1.2."]);
});

test("lerDocx: numId que não resolve vira aviso com a contagem de parágrafos por numId", () => {
  const xml = documento(
    paragrafo("a", { numId: 7 }) + paragrafo("b", { numId: 7 }) + paragrafo("c", { numId: 1, ilvl: 5 }) + paragrafo("d", { numId: 1 }),
  );
  const d = lerDocx(construirDocx({ documentXml: xml, numberingXml: numeracaoDecimal3Niveis() }));
  assert.deepEqual(d.blocos.map((b) => b.numero), [null, null, null, "1."]);
  assert.deepEqual(d.avisos, [
    "numeração automática não resolvida em 2 parágrafos (numId 7)",
    "numeração automática não resolvida em 1 parágrafo (numId 1)",
  ]);
  // sem numbering.xml nenhum, o parágrafo numerado também avisa
  const sem = lerDocx(construirDocx({ documentXml: documento(paragrafo("x", { numId: 3 })) }));
  assert.deepEqual(sem.avisos, ["numeração automática não resolvida em 1 parágrafo (numId 3)"]);
});

test("lerDocx: numbering.xml ou styles.xml malformados degradam com aviso, sem derrubar o documento", () => {
  const xml = documento(paragrafo("Objeto", { numId: 1 }) + paragrafo("Texto"));
  const d = lerDocx(construirDocx({ documentXml: xml, numberingXml: "<w:numbering><quebrado", stylesXml: "<<<" }));
  assert.equal(d.ilegivel, undefined);
  assert.deepEqual(d.blocos.map(textoDe), ["Objeto", "Texto"]);
  assert.deepEqual(d.avisos, ["numbering.xml ilegível: numeração automática não renderizada", "styles.xml ilegível: numeração herdada de estilo não renderizada"]);
  const c = lerDocx(construirDocx({ documentXml: xml, numberingXml: numeracaoDecimal3Niveis(), commentsXml: "<x", footnotesXml: "<y", headerXml: "<z" }));
  assert.deepEqual(c.blocos.map((b) => b.numero), ["1.", null]);
  assert.deepEqual(c.avisos, ["comments.xml ilegível: comentários não renderizados", "footnotes.xml ilegível: notas de rodapé não renderizadas", "header1.xml ilegível: cabeçalho ou rodapé não renderizado"]);
});

// ---------- sidecar vazio que diz "sem marcas" (R22) ----------

test("lerDocx: OOXML Strict (namespace purl.oclc.org) é lido como o transicional", () => {
  const strictNum = numeracaoDecimal3Niveis({ strict: true });
  const comentarios = `<?xml version="1.0"?><w:comments ${W_STRICT}><w:comment w:id="0" w:author="Ana" w:date="2026-01-01T00:00:00Z"><w:p><w:r><w:t>ver</w:t></w:r></w:p></w:comment></w:comments>`;
  const xml = documento(
    paragrafo("Objeto", { numId: 1 }) +
      `<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Preço</w:t></w:r><w:commentRangeEnd w:id="0"/><w:ins w:author="Bruno"><w:r><w:t> fixo</w:t></w:r></w:ins></w:p>`,
    { strict: true },
  );
  const d = lerDocx(construirDocx({ documentXml: xml, numberingXml: strictNum, commentsXml: comentarios }));
  assert.equal(d.ilegivel, undefined);
  assert.deepEqual(d.blocos.map((b) => b.numero), ["1.", null]);
  assert.deepEqual(d.comentarios.map((c) => [c.autor, c.texto]), [["Ana", "ver"]]);
  assert.ok(d.blocos[1].segmentos.some((s) => s.marca === "ins" && s.autor === "Bruno"));
  assert.deepEqual(d.avisos, []);
});

test("lerDocx: ilegível quando falta document.xml, o XML é malformado ou não há body; protegido por senha é dito", async () => {
  const { zipSync, strToU8 } = await import("fflate");
  const semDoc = lerDocx(Buffer.from(zipSync({ "word/styles.xml": strToU8("<x/>") })));
  assert.deepEqual([semDoc.ilegivel, semDoc.motivo], [true, "sem word/document.xml"]);
  const malformado = lerDocx(construirDocx({ documentXml: "<w:document><w:body><w:p>" }));
  assert.deepEqual([malformado.ilegivel, /^word\/document\.xml malformado/.test(malformado.motivo)], [true, true]);
  const semBody = lerDocx(construirDocx({ documentXml: `<?xml version="1.0"?><w:document ${W}></w:document>` }));
  assert.deepEqual([semBody.ilegivel, semBody.motivo], [true, "word/document.xml sem w:body"]);
  // .docx cifrado é um contêiner OLE (CFB), não zip
  const cfb = Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(504)]);
  const protegido = lerDocx(cfb);
  assert.deepEqual([protegido.ilegivel, protegido.motivo], [true, "protegido por senha (ou .doc antigo renomeado)"]);
});

test("lerDocx: documento que abre sem texto nenhum ganha o aviso 'documento sem texto'", () => {
  const d = lerDocx(construirDocx({ documentXml: documento("<w:p/>") }));
  assert.equal(d.ilegivel, undefined);
  assert.deepEqual(d.avisos, ["documento sem texto"]);
});
