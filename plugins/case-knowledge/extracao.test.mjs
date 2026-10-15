// extracao.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { isWorkdocPath } from "./workdocs.mjs";
import {
  EXTRATOR_VERSAO,
  tipoDeFormato,
  nomeSidecar,
  ehOriginalElegivel,
  lerFrontmatter,
  montarSidecar,
  planejarExtracao,
  acharPlaceholders,
  renderDocx,
  renderXlsx,
  htmlParaTexto,
  tamanhoLegivel,
  renderEmail,
} from "./extracao.mjs";

test("tipoDeFormato: extensão sem caixa define o leitor", () => {
  assert.equal(tipoDeFormato("Contrato.DOCX"), "docx");
  assert.equal(tipoDeFormato("minuta.docm"), "docx");
  assert.equal(tipoDeFormato("planilha.xlsx"), "xlsx");
  assert.equal(tipoDeFormato("macro.xlsm"), "xlsx");
  assert.equal(tipoDeFormato("RE proposta.msg"), "msg");
  assert.equal(tipoDeFormato("thread.eml"), "eml");
  assert.equal(tipoDeFormato("autos.pdf"), null);
  assert.equal(tipoDeFormato("notas.md"), null);
  assert.equal(tipoDeFormato("semextensao"), null);
});

test("nomeSidecar: basename + .md, no mesmo diretório", () => {
  assert.equal(nomeSidecar("contrato.docx"), "contrato.docx.md");
  assert.equal(nomeSidecar("emails/RE proposta.msg"), "emails/RE proposta.msg.md");
});

test("nomeSidecar: original com opt-out .local gera sidecar .local.md", () => {
  assert.equal(nomeSidecar("x.local.docx"), "x.local.docx.local.md");
  assert.equal(nomeSidecar("sub/y.LOCAL.xlsx"), "sub/y.LOCAL.xlsx.local.md");
});

test("ehOriginalElegivel: aceita formatos suportados em qualquer profundidade segura", () => {
  assert.equal(ehOriginalElegivel("contrato.docx"), true);
  assert.equal(ehOriginalElegivel("emails/2026/RE proposta.msg"), true);
  assert.equal(ehOriginalElegivel("Relatório final.xlsx"), true);
});

test("ehOriginalElegivel: rejeita o que o canal de workdocs rejeita", () => {
  assert.equal(ehOriginalElegivel("autos.pdf"), false);
  assert.equal(ehOriginalElegivel("~$contrato.docx"), false);
  assert.equal(ehOriginalElegivel("contrato.conflito-ana.docx"), false);
  assert.equal(ehOriginalElegivel("base/x.docx"), false);
  assert.equal(ehOriginalElegivel("a/node_modules/x.docx"), false);
  assert.equal(ehOriginalElegivel(".oculto/x.docx"), false);
  assert.equal(ehOriginalElegivel("../fora.docx"), false);
});

test("montarSidecar/lerFrontmatter: ida e volta, determinístico", () => {
  const md = montarSidecar({
    fonte: "Contrato v3.docx",
    md5: "9f1c0a7e4b2d8e6f0a1b2c3d4e5f6a7b",
    bytes: 184322,
    avisos: ["2 imagens não renderizadas (parágrafos 1, 7)", 'caixa de texto ignorada'],
    corpo: "## Texto\n\nOlá.\n",
  });
  assert.ok(md.startsWith("---\n"));
  assert.ok(md.endsWith("\n"));
  assert.ok(!md.includes("\r"));
  assert.equal(md, montarSidecar({ fonte: "Contrato v3.docx", md5: "9f1c0a7e4b2d8e6f0a1b2c3d4e5f6a7b", bytes: 184322, avisos: ["2 imagens não renderizadas (parágrafos 1, 7)", "caixa de texto ignorada"], corpo: "## Texto\n\nOlá.\n" }));
  const fm = lerFrontmatter(md);
  assert.deepEqual(fm, {
    fonte: "Contrato v3.docx",
    fonte_md5: "9f1c0a7e4b2d8e6f0a1b2c3d4e5f6a7b",
    fonte_bytes: 184322,
    extrator_nome: "case-knowledge/extracao",
    extrator_versao: EXTRATOR_VERSAO,
    avisos: ["2 imagens não renderizadas (parágrafos 1, 7)", "caixa de texto ignorada"],
  });
});

test("montarSidecar: sem avisos escreve lista vazia", () => {
  const md = montarSidecar({ fonte: "a.docx", md5: "0".repeat(32), bytes: 1, avisos: [], corpo: "x\n" });
  assert.ok(md.includes("\navisos: []\n"));
});

test("montarSidecar: fonte com aspas e dois-pontos sai escapada e volta igual", () => {
  const fonte = 'RE: "Proposta" - v2.msg';
  const md = montarSidecar({ fonte, md5: "0".repeat(32), bytes: 1, avisos: ['aviso com "aspas"'], corpo: "x\n" });
  const fm = lerFrontmatter(md);
  assert.equal(fm.fonte, fonte);
  assert.equal(fm.avisos[0], 'aviso com "aspas"');
});

test("lerFrontmatter: .md do usuário (sem nosso frontmatter) retorna null", () => {
  assert.equal(lerFrontmatter("# Minhas notas\n\nsobre o contrato"), null);
  assert.equal(lerFrontmatter("---\ntitle: x\n---\ncorpo"), null);
  assert.equal(lerFrontmatter(""), null);
});

test("ehOriginalElegivel: ~$ e .conflito- sem caixa, paridade com isWorkdocPath", () => {
  for (const rel of ["~$X.DOCX", "a.CONFLITO-ana.docx", "b.Conflito-x.xlsx"]) {
    assert.equal(ehOriginalElegivel(rel), false, rel);
    // O canal de workdocs também não circula esses nomes: a poda é a mesma.
    assert.equal(isWorkdocPath(rel), false, rel);
  }
});

test("montarSidecar/lerFrontmatter: controles em fonte e avisos fazem ida e volta em uma linha", () => {
  const casos = [
    { fonte: "a\r\nb.msg", avisos: ["linha1\nlinha2\ttab"] },
    { fonte: "a\\nb.docx", avisos: ["barra \\ e \\t literais", 'aspas " e \\"'] },
    { fonte: "ctl\u0000\u0001\u001f\u007f.eml", avisos: ["\u000b\u000c"] },
  ];
  for (const { fonte, avisos } of casos) {
    const md = montarSidecar({ fonte, md5: "0".repeat(32), bytes: 1, avisos, corpo: "x\n" });
    const cabecalho = md.slice(0, md.indexOf("\n---\n", 4));
    // 1 (---) + fonte + md5 + bytes + extrator + "avisos:" + N itens
    assert.equal(cabecalho.split("\n").length, 6 + avisos.length);
    const fm = lerFrontmatter(md);
    assert.ok(fm, "frontmatter legível");
    assert.equal(fm.fonte, fonte);
    assert.deepEqual(fm.avisos, avisos);
  }
});

test("planejarExtracao: fonte com controles não faz o sidecar virar naoTocar", () => {
  const rel = "a.docx";
  const sidecar = montarSidecar({ fonte: "x\ny", md5: "a".repeat(32), bytes: 1, avisos: ["p\nq"], corpo: "x\n" });
  const p = planejarExtracao({ originais: { [rel]: { md5: "a".repeat(32), bytes: 1 } }, sidecars: { "a.docx.md": sidecar } });
  assert.deepEqual(p.naoTocar, []);
  assert.equal(p.pular[0].rel, rel);
});

const MD5_A = "a".repeat(32);
const MD5_B = "b".repeat(32);
const sidecarDe = (fonte, md5, versao = EXTRATOR_VERSAO) =>
  montarSidecar({ fonte, md5, bytes: 10, avisos: [], corpo: "x\n" })
    .replace(`extrator: "case-knowledge/extracao ${EXTRATOR_VERSAO}"`, `extrator: "case-knowledge/extracao ${versao}"`);

test("planejarExtracao: original sem sidecar entra em extrair", () => {
  const p = planejarExtracao({ originais: { "contrato.docx": { md5: MD5_A, bytes: 10 } }, sidecars: {} });
  assert.deepEqual(p.extrair, [{ rel: "contrato.docx", sidecar: "contrato.docx.md", motivo: "sem sidecar" }]);
  assert.deepEqual(p.pular, []);
  assert.deepEqual(p.naoTocar, []);
});

test("planejarExtracao: sidecar com md5 e versão iguais pula", () => {
  const p = planejarExtracao({
    originais: { "contrato.docx": { md5: MD5_A, bytes: 10 } },
    sidecars: { "contrato.docx.md": sidecarDe("contrato.docx", MD5_A) },
  });
  assert.deepEqual(p.extrair, []);
  assert.equal(p.pular[0].rel, "contrato.docx");
});

test("planejarExtracao: md5 diferente reextrai (original mudou)", () => {
  const p = planejarExtracao({
    originais: { "contrato.docx": { md5: MD5_B, bytes: 10 } },
    sidecars: { "contrato.docx.md": sidecarDe("contrato.docx", MD5_A) },
  });
  assert.equal(p.extrair[0].motivo, "original mudou");
});

test("planejarExtracao: versão do extrator menor reextrai", () => {
  const p = planejarExtracao({
    originais: { "contrato.docx": { md5: MD5_A, bytes: 10 } },
    sidecars: { "contrato.docx.md": sidecarDe("contrato.docx", MD5_A, EXTRATOR_VERSAO - 1) },
  });
  assert.equal(p.extrair[0].motivo, "extrator desatualizado");
});

test("planejarExtracao: sidecar sem nosso frontmatter é do usuário e não é tocado", () => {
  const p = planejarExtracao({
    originais: { "contrato.docx": { md5: MD5_A, bytes: 10 } },
    sidecars: { "contrato.docx.md": "# Notas minhas\n" },
  });
  assert.deepEqual(p.extrair, []);
  assert.equal(p.naoTocar[0].sidecar, "contrato.docx.md");
});

test("planejarExtracao: ignora original não elegível e ordena por path", () => {
  const p = planejarExtracao({
    originais: {
      "z.docx": { md5: MD5_A, bytes: 1 },
      "autos.pdf": { md5: MD5_A, bytes: 1 },
      "a/b.xlsx": { md5: MD5_A, bytes: 1 },
      "~$z.docx": { md5: MD5_A, bytes: 1 },
    },
    sidecars: {},
  });
  assert.deepEqual(p.extrair.map((e) => e.rel), ["a/b.xlsx", "z.docx"]);
});

// ---------- .docx: placeholders e render ----------

test("acharPlaceholders: conta os quatro padrões e omite os ausentes", () => {
  assert.deepEqual(acharPlaceholders("valor de R$ XXXX em [●] parcelas; ___ e ( ) e XXXXXX"), { "XXXX": 2, "[●]": 1, "___": 1, "( )": 1 });
  assert.deepEqual(acharPlaceholders("sem nada (x) _ XX"), {});
});

test("renderDocx: radiografia resume marcas por autor, comentários, placeholders e numeração", () => {
  const md = renderDocx({
    blocos: [
      { tipo: "paragrafo", numero: "1.", segmentos: [{ texto: "Pagar ", marca: null }, { texto: "XXXX", marca: "del", autor: "Ana" }, { texto: "100", marca: "ins", autor: "Ana" }, { texto: "", marca: null, comentarios: ["3"] }] },
      { tipo: "paragrafo", numero: "1.1.", segmentos: [{ texto: "Em [●] dias", marca: null }, { texto: "", marca: null, nota: "1" }] },
      { tipo: "paragrafo", numero: null, segmentos: [{ texto: "x", marca: "ins", autor: "Bruno" }] },
      { tipo: "tabela", linhas: [["Item", "Valor"], ["a | b", "R$ 1"]] },
    ],
    comentarios: [{ id: "3", autor: "Ana", data: "2026-09-01T10:00:00Z", texto: "Conferir." }],
    notas: [{ id: "1", texto: "Nota." }],
    cabecalhoRodape: ["CONFIDENCIAL"],
    avisos: [],
    temNumeracao: true,
    niveisNumeracao: 2,
  });
  assert.equal(
    md,
    [
      "## Radiografia",
      "",
      "- Marcas de revisão: 2 inserções e 1 exclusão de 2 revisores (Ana: 1 inserção, 1 exclusão; Bruno: 1 inserção)",
      "- Comentários: 1 (Ana: 1)",
      "- Placeholders no texto aceito: [●] ×1",
      "- Numeração automática: sim (2 níveis)",
      "",
      "## Texto",
      "",
      "1. Pagar {--XXXX--}[Ana]{++100++}[Ana][^c3]",
      "",
      "1.1. Em [●] dias[^n1]",
      "",
      "{++x++}[Bruno]",
      "",
      "| Item | Valor |",
      "| --- | --- |",
      "| a \\| b | R$ 1 |",
      "",
      "## Comentários",
      "",
      "[^c3]: **Ana** (2026-09-01T10:00:00Z): Conferir.",
      "",
      "## Notas",
      "",
      "[^n1]: Nota.",
      "",
      "## Cabeçalho e rodapé",
      "",
      "CONFIDENCIAL",
      "",
    ].join("\n"),
  );
});

test("renderDocx: sem marcas, comentários, placeholders nem numeração, radiografia é uma linha e seções opcionais somem", () => {
  const md = renderDocx({ blocos: [{ tipo: "paragrafo", numero: null, segmentos: [{ texto: "Só texto.", marca: null }] }], comentarios: [], notas: [], cabecalhoRodape: [], avisos: [], temNumeracao: false, niveisNumeracao: 0 });
  assert.equal(md, "## Radiografia\n\n- Sem marcas de revisão, sem comentários, sem placeholders, sem numeração automática.\n\n## Texto\n\nSó texto.\n");
});

test("renderDocx: placeholders dentro de exclusão não contam (texto aceito); quebra de linha interna vira linha nova", () => {
  const md = renderDocx({ blocos: [{ tipo: "paragrafo", numero: null, segmentos: [{ texto: "XXXX", marca: "del", autor: "A" }, { texto: "a\nb", marca: null }] }], comentarios: [], notas: [], cabecalhoRodape: [], avisos: [], temNumeracao: false, niveisNumeracao: 0 });
  assert.ok(md.includes("- Marcas de revisão: 0 inserções e 1 exclusão de 1 revisor (A: 1 exclusão)"));
  assert.ok(!md.includes("Placeholders"));
  assert.ok(md.includes("{--XXXX--}[A]a\nb\n"));
});

test("renderDocx: placeholder excluído (ins de um revisor apagado por outro) não conta no texto aceito", () => {
  const md = renderDocx({ blocos: [{ tipo: "paragrafo", numero: null, segmentos: [{ texto: "R$ ", marca: null }, { texto: "XXXX", marca: "del", autor: "Bruno" }] }], comentarios: [], notas: [], cabecalhoRodape: [], avisos: [], temNumeracao: false, niveisNumeracao: 0 });
  assert.ok(md.includes("- Marcas de revisão: 0 inserções e 1 exclusão de 1 revisor (Bruno: 1 exclusão)"));
  assert.ok(!md.includes("Placeholders"));
});

test("renderDocx: marca e placeholder que só existem em tabela entram na radiografia", () => {
  const md = renderDocx({
    blocos: [
      { tipo: "paragrafo", numero: null, segmentos: [{ texto: "Preço:", marca: null }] },
      {
        tipo: "tabela",
        linhas: [["R$ [●] {--100--}[Ana]"]],
        segmentos: [{ texto: "R$ [●] ", marca: null }, { texto: "100", marca: "del", autor: "Ana" }],
      },
    ],
    comentarios: [], notas: [], cabecalhoRodape: [], avisos: [], temNumeracao: false, niveisNumeracao: 0,
  });
  assert.ok(md.includes("- Marcas de revisão: 0 inserções e 1 exclusão de 1 revisor (Ana: 1 exclusão)"));
  assert.ok(md.includes("- Placeholders no texto aceito: [●] ×1"));
  assert.ok(md.includes("| R$ [●] {--100--}[Ana] |"));
});

test("renderXlsx: uma seção por aba visível, cabeçalho = primeira linha não vazia, pipe escapado", () => {
  const md = renderXlsx({
    abas: [
      { nome: "Dados", oculta: false, linhas: [["", ""], ["Item", "Valor"], ["a|b", "1"]], cortadas: 0 },
      { nome: "Oculta", oculta: true, linhas: [], cortadas: 0 },
      { nome: "Vazia", oculta: false, linhas: [], cortadas: 0 },
    ],
    avisos: [],
  });
  assert.equal(md, "## Aba: Dados\n\n| Item | Valor |\n| --- | --- |\n| a\\|b | 1 |\n\n## Aba: Vazia\n\n(aba vazia)\n");
});

test("htmlParaTexto: quebras de bloco viram linhas, tags somem, entidades decodificam, script/style somem", () => {
  const html = `<html><head><style>p{}</style><script>x()</script></head><body><p>Ol&aacute; <b>mundo</b>&nbsp;&amp; cia</p><div>linha 2<br>linha 3</div><ul><li>a</li><li>b</li></ul><table><tr><td>c1</td><td>c2</td></tr></table></body></html>`;
  assert.equal(htmlParaTexto(html), "Olá mundo & cia\nlinha 2\nlinha 3\na\nb\nc1\tc2");
});

test("htmlParaTexto: entidades numéricas e colapso de linhas em branco", () => {
  assert.equal(htmlParaTexto("<p>&#231;&#xE3;o</p><p></p><p></p><p>fim</p>"), "ção\n\nfim");
});

test("htmlParaTexto: quebra de linha do fonte HTML é espaço, não linha; nbsp literal é espaço", () => {
  assert.equal(htmlParaTexto("<p class=MsoNormal>Segue a\r\nproposta   revisada.</p>\r\n<p> </p>\r\n<p>Att.</p>"), "Segue a proposta revisada.\n\nAtt.");
});

test("renderEmail: cabeçalhos em lista, corpo, anexos com tamanho e caminho quando houver", () => {
  const md = renderEmail({
    cabecalhos: { de: "Ana <a@x>", para: ["Bruno <b@y>"], cc: [], data: "2026-09-01T10:30:00Z", assunto: "RE: Proposta" },
    corpo: "Segue.\n\nAtt.",
    anexos: [{ nome: "Proposta.docx", bytes: 184322, caminho: "RE Proposta.msg.anexos/Proposta.docx" }, { nome: "grande.zip", bytes: 30 * 1024 * 1024 }],
    avisos: [],
  });
  assert.equal(md, "## Cabeçalhos\n\n- De: Ana <a@x>\n- Para: Bruno <b@y>\n- Data: 2026-09-01T10:30:00Z\n- Assunto: RE: Proposta\n\n## Corpo\n\nSegue.\n\nAtt.\n\n## Anexos\n\n- Proposta.docx (180,0 KiB) -> RE Proposta.msg.anexos/Proposta.docx\n- grande.zip (30,0 MiB) -> não extraído\n");
});

test("renderEmail: sem cc omite a linha; sem anexos escreve (nenhum)", () => {
  const md = renderEmail({ cabecalhos: { de: "a", para: [], cc: [], data: "", assunto: "" }, corpo: "", anexos: [], avisos: [] });
  assert.equal(md, "## Cabeçalhos\n\n- De: a\n- Para: \n- Data: \n- Assunto: \n\n## Corpo\n\n\n\n## Anexos\n\n(nenhum)\n");
});

test("renderEmail: cc presente vira linha própria, na ordem da fonte", () => {
  const md = renderEmail({ cabecalhos: { de: "a", para: ["b"], cc: ["c", "d"], data: "", assunto: "s" }, corpo: "x", anexos: [], avisos: [] });
  assert.match(md, /^- Para: b\n- Cc: c, d\n- Data: /m);
});

test("tamanhoLegivel: bytes, KiB e MiB com vírgula decimal", () => {
  assert.equal(tamanhoLegivel(0), "0 B");
  assert.equal(tamanhoLegivel(1023), "1023 B");
  assert.equal(tamanhoLegivel(1024), "1,0 KiB");
  assert.equal(tamanhoLegivel(1536), "1,5 KiB");
  assert.equal(tamanhoLegivel(1024 * 1024), "1,0 MiB");
});

test("htmlParaTexto: entidade numérica fora do Unicode fica literal (não lança); válida decodifica", () => {
  assert.equal(htmlParaTexto("<p>&#99999999; &#x110000; &#xD800; &#0; &#231;</p>"), "&#99999999; &#x110000; &#xD800; &#0; ç");
});
