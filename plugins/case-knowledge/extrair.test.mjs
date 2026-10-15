// extrair.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extrairCaso, extrairTodos, formatarResumo, sanitizarNomeAnexo } from "./extrair.mjs";
import { lerFrontmatter } from "./extracao.mjs";
import { construirDocx, documento, paragrafo, numeracaoDecimal3Niveis } from "./extracao/fixtures/docx-builder.mjs";

const DOCX = construirDocx({ documentXml: documento(paragrafo("Objeto", { numId: 1 }) + paragrafo("Preço", { numId: 1 })), numberingXml: numeracaoDecimal3Niveis() });
const EML = "From: a@a\r\nTo: b@b\r\nSubject: Oi\r\n\r\ncorpo\r\n";

function casoTemp() {
  const dir = mkdtempSync(join(tmpdir(), "extrair-"));
  return dir;
}

test("extrairCaso: cria o sidecar ao lado, com frontmatter nosso e texto; segunda rodada pula", async () => {
  const dir = casoTemp();
  writeFileSync(join(dir, "Contrato v3.docx"), DOCX);
  const r1 = await extrairCaso(dir);
  assert.deepEqual(r1.extraidos.map((e) => e.sidecar), ["Contrato v3.docx.md"]);
  const md = readFileSync(join(dir, "Contrato v3.docx.md"), "utf-8");
  const fm = lerFrontmatter(md);
  assert.equal(fm.fonte, "Contrato v3.docx");
  assert.equal(fm.fonte_bytes, DOCX.length);
  assert.ok(md.includes("1. Objeto"));
  assert.ok(!md.includes("\r"));
  const r2 = await extrairCaso(dir);
  assert.deepEqual(r2.extraidos, []);
  assert.equal(r2.pulados, 1);
  assert.equal(readFileSync(join(dir, "Contrato v3.docx.md"), "utf-8"), md, "saída determinística");
});

test("extrairCaso: varre subpastas, poda base/, dotdirs, lock do Word e conflito", async () => {
  const dir = casoTemp();
  mkdirSync(join(dir, "emails", "2026"), { recursive: true });
  mkdirSync(join(dir, "base"));
  mkdirSync(join(dir, ".memoria"));
  writeFileSync(join(dir, "emails", "2026", "t.eml"), EML);
  writeFileSync(join(dir, "base", "x.docx"), DOCX);
  writeFileSync(join(dir, ".memoria", "y.docx"), DOCX);
  writeFileSync(join(dir, "~$lock.docx"), DOCX);
  writeFileSync(join(dir, "z.conflito-ana.docx"), DOCX);
  const r = await extrairCaso(dir);
  assert.deepEqual(r.extraidos.map((e) => e.rel), ["emails/2026/t.eml"]);
  assert.ok(existsSync(join(dir, "emails", "2026", "t.eml.md")));
  assert.ok(!existsSync(join(dir, "base", "x.docx.md")));
});

test("extrairCaso: sidecar do usuário com o mesmo nome não é tocado", async () => {
  const dir = casoTemp();
  writeFileSync(join(dir, "a.docx"), DOCX);
  writeFileSync(join(dir, "a.docx.md"), "# minhas notas\n");
  const r = await extrairCaso(dir);
  assert.deepEqual(r.extraidos, []);
  assert.deepEqual(r.naoTocados, [{ rel: "a.docx", sidecar: "a.docx.md" }]);
  assert.equal(readFileSync(join(dir, "a.docx.md"), "utf-8"), "# minhas notas\n");
});

test("extrairCaso: original que mudou reextrai e sobrescreve", async () => {
  const dir = casoTemp();
  writeFileSync(join(dir, "a.docx"), DOCX);
  await extrairCaso(dir);
  const outro = construirDocx({ documentXml: documento(paragrafo("Novo texto")) });
  writeFileSync(join(dir, "a.docx"), outro);
  const r = await extrairCaso(dir);
  assert.equal(r.extraidos.length, 1);
  assert.ok(readFileSync(join(dir, "a.docx.md"), "utf-8").includes("Novo texto"));
});

test("extrairCaso: original acima de 50 MiB é adiado com motivo, sem sidecar", async () => {
  const dir = casoTemp();
  writeFileSync(join(dir, "grande.docx"), Buffer.alloc(1024));
  const r = await extrairCaso(dir, { maxOriginalBytes: 512 });
  assert.deepEqual(r.adiados, [{ rel: "grande.docx", motivo: "acima do teto de 50 MiB (1,0 KiB)" }]);
  assert.ok(!existsSync(join(dir, "grande.docx.md")));
});

test("extrairCaso: docx corrompido gera sidecar com aviso (não erro), e erro de leitura de disco vai em erros", async () => {
  const dir = casoTemp();
  writeFileSync(join(dir, "ruim.docx"), Buffer.from("nada"));
  const r = await extrairCaso(dir);
  assert.equal(r.extraidos.length, 1);
  const fm = lerFrontmatter(readFileSync(join(dir, "ruim.docx.md"), "utf-8"));
  assert.match(fm.avisos[0], /não foi possível abrir/);
});

const EML_COM_DOCX = [
  "From: a@a", "To: b@b", "Subject: Com anexo", 'Content-Type: multipart/mixed; boundary="B"', "",
  "--B", "Content-Type: text/plain", "", "veja o anexo",
  "--B", 'Content-Type: application/octet-stream; name="../Minuta.docx"', "Content-Transfer-Encoding: base64", 'Content-Disposition: attachment; filename="../Minuta.docx"', "",
  DOCX.toString("base64"), "--B--", "",
].join("\r\n");

test("extrairCaso: anexo de e-mail vai para <nome>.anexos/ com nome sanitizado e ganha sidecar na mesma rodada", async () => {
  const dir = casoTemp();
  writeFileSync(join(dir, "RE Proposta.eml"), EML_COM_DOCX);
  const r = await extrairCaso(dir);
  assert.deepEqual(r.extraidos.map((e) => e.sidecar).sort(), ["RE Proposta.eml.anexos/Minuta.docx.md", "RE Proposta.eml.md"]);
  assert.ok(existsSync(join(dir, "RE Proposta.eml.anexos", "Minuta.docx")));
  const md = readFileSync(join(dir, "RE Proposta.eml.md"), "utf-8");
  assert.ok(md.includes("- Minuta.docx (") && md.includes(") -> RE Proposta.eml.anexos/Minuta.docx"));
  assert.ok(!existsSync(join(dir, "..", "Minuta.docx")));
});

test("extrairCaso: anexo acima do teto fica listado e não extraído", async () => {
  const dir = casoTemp();
  writeFileSync(join(dir, "RE Proposta.eml"), EML_COM_DOCX);
  const r = await extrairCaso(dir, { maxAnexoBytes: 10 });
  assert.deepEqual(r.extraidos.map((e) => e.sidecar), ["RE Proposta.eml.md"]);
  const md = readFileSync(join(dir, "RE Proposta.eml.md"), "utf-8");
  assert.ok(md.includes("-> não extraído"));
  const fm = lerFrontmatter(md);
  assert.ok(fm.avisos.some((a) => /anexo Minuta.docx acima do teto/.test(a)));
});

test("extrairCaso: anexo de anexo (nível 2) é gravado mas não extraído", async () => {
  // e-mail com .eml anexo que por sua vez tem .docx anexo
  const interno = EML_COM_DOCX;
  const externo = ["From: a@a", "To: b@b", "Subject: Encaminhando", 'Content-Type: multipart/mixed; boundary="C"', "", "--C", "Content-Type: text/plain", "", "fwd", "--C", 'Content-Type: message/rfc822; name="interno.eml"', 'Content-Disposition: attachment; filename="interno.eml"', "", interno, "--C--", ""].join("\r\n");
  const dir = casoTemp();
  writeFileSync(join(dir, "fwd.eml"), externo);
  const r = await extrairCaso(dir);
  const sidecars = r.extraidos.map((e) => e.sidecar).sort();
  assert.deepEqual(sidecars, ["fwd.eml.anexos/interno.eml.md", "fwd.eml.md"]);
  assert.ok(existsSync(join(dir, "fwd.eml.anexos", "interno.eml.anexos", "Minuta.docx")));
  assert.ok(!existsSync(join(dir, "fwd.eml.anexos", "interno.eml.anexos", "Minuta.docx.md")));
  // R12: o nível 2 vira aviso no sidecar do e-mail interno, nunca adiado
  assert.deepEqual(r.adiados, []);
  const fm = lerFrontmatter(readFileSync(join(dir, "fwd.eml.anexos", "interno.eml.md"), "utf-8"));
  assert.ok(fm.avisos.includes("anexo Minuta.docx de e-mail aninhado não extraído (só um nível)"));
  assert.equal(r.extraidos.find((e) => e.rel === "fwd.eml.anexos/interno.eml").detalhe, "1 anexo, 0 extraídos");
  // segunda rodada: o anexo de nível 2 no disco não é original, nada a reportar
  const r2 = await extrairCaso(dir);
  assert.deepEqual([r2.extraidos, r2.adiados, r2.erros, r2.naoTocados], [[], [], [], []]);
});

test("extrairCaso: orçamento esgotado adia o restante em ordem de path", async () => {
  const dir = casoTemp();
  writeFileSync(join(dir, "a.docx"), DOCX);
  writeFileSync(join(dir, "b.docx"), DOCX);
  writeFileSync(join(dir, "c.docx"), DOCX);
  let t = 0;
  const agora = () => (t += 40); // cada chamada avança 40 ms
  const r = await extrairCaso(dir, { orcamentoMs: 100, agora });
  assert.ok(r.extraidos.length >= 1 && r.extraidos.length < 3);
  assert.ok(r.adiados.every((a) => a.motivo === "orçamento de tempo esgotado"));
  assert.equal(r.extraidos.length + r.adiados.length, 3);
});

test("extrairCaso: saída acima de 1,5 MiB corta abas do fim e avisa", async () => {
  const dir = casoTemp();
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  for (const nome of ["A", "B"]) { const ws = wb.addWorksheet(nome); for (let i = 0; i < 300; i++) ws.addRow(["x".repeat(2000)]); }
  writeFileSync(join(dir, "g.xlsx"), Buffer.from(await wb.xlsx.writeBuffer()));
  const r = await extrairCaso(dir, { maxSaidaBytes: 700 * 1024 });
  assert.equal(r.extraidos.length, 1);
  const md = readFileSync(join(dir, "g.xlsx.md"), "utf-8");
  assert.ok(Buffer.byteLength(md) <= 720 * 1024);
  assert.ok(lerFrontmatter(md).avisos.some((a) => /saída acima do teto/.test(a)));
});

test("formatarResumo: duas listas; vazio quando nada aconteceu", () => {
  assert.equal(formatarResumo({ extraidos: [], adiados: [], pulados: 3, naoTocados: [], erros: [] }), "");
  const s = formatarResumo({
    extraidos: [{ rel: "Contrato v3.docx", sidecar: "Contrato v3.docx.md", detalhe: "2 revisores, 5 comentários" }],
    adiados: [{ rel: "Relatório 2025.xlsx", motivo: "acima do teto de 50 MiB (38,0 MiB)" }],
    pulados: 0, naoTocados: [], erros: [],
  });
  assert.equal(s, "Textos extraídos nesta pasta (leia o .md ao lado do original):\n- Contrato v3.docx.md (2 revisores, 5 comentários)\nFicou para o sincronizador (não extraído agora):\n- Relatório 2025.xlsx: acima do teto de 50 MiB (38,0 MiB)");
});

test("extrairTodos: só subpastas diretas de casos, ignorando _archive, _template, scripts e dotdirs", async () => {
  const base = casoTemp();
  for (const d of ["caso-a", "caso-b", "_archive", "_template", "scripts", ".claude"]) { mkdirSync(join(base, d)); writeFileSync(join(base, d, "x.docx"), DOCX); }
  writeFileSync(join(base, "solto.docx"), DOCX);
  const r = await extrairTodos(base);
  assert.deepEqual(Object.keys(r.porCaso).sort(), ["caso-a", "caso-b"]);
  assert.ok(!existsSync(join(base, "_archive", "x.docx.md")));
  assert.ok(!existsSync(join(base, "solto.docx.md")));
});

test("sanitizarNomeAnexo: remove separadores, .., controle e nomes reservados", () => {
  assert.equal(sanitizarNomeAnexo("../Minuta.docx"), "Minuta.docx");
  assert.equal(sanitizarNomeAnexo("a\\b/c.docx"), "a_b_c.docx");
  assert.equal(sanitizarNomeAnexo("x\u0000y.docx"), "xy.docx");
  assert.equal(sanitizarNomeAnexo(""), "anexo-sem-nome");
  assert.equal(sanitizarNomeAnexo("CON.docx"), "_CON.docx");
  assert.equal(sanitizarNomeAnexo("  nome .docx "), "nome .docx");
});

// ---------- além do brief: decisões do controlador e robustez no Windows ----------

test("sanitizarNomeAnexo: caracteres proibidos no NTFS e ponto final viram nome gravável", () => {
  // .msg aninhado ganha o assunto como nome: "RE: x" no NTFS viraria fluxo alternativo
  assert.equal(sanitizarNomeAnexo("RE: Proposta?.msg"), "RE_ Proposta_.msg");
  assert.equal(sanitizarNomeAnexo("relatorio. "), "relatorio");
  assert.equal(sanitizarNomeAnexo(".oculto.docx"), "oculto.docx");
  assert.equal(sanitizarNomeAnexo(".."), "anexo-sem-nome");
  const longo = sanitizarNomeAnexo(`${"a".repeat(400)}.docx`);
  assert.ok(longo.length <= 150 && longo.endsWith(".docx"));
});

test("extrairCaso: leitor que lança vai para erros, sem sidecar, e a varredura segue", async () => {
  const dir = casoTemp();
  // aninhamento acima do maxNestingDepth do postal-mime: lerEml rejeita
  let corpo = "fim";
  for (let i = 300; i > 0; i--) corpo = `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n${corpo}\r\n--b${i}--`;
  writeFileSync(join(dir, "a.eml"), `From: a@a\r\nTo: b@b\r\nSubject: fundo\r\n${corpo}\r\n`);
  writeFileSync(join(dir, "b.docx"), DOCX);
  const r = await extrairCaso(dir);
  assert.deepEqual(r.erros.map((e) => e.rel), ["a.eml"]);
  assert.ok(r.erros[0].erro.length > 0);
  assert.ok(!existsSync(join(dir, "a.eml.md")));
  assert.deepEqual(r.extraidos.map((e) => e.rel), ["b.docx"]);
});

test("extrairCaso: caso inexistente não lança", async () => {
  const r = await extrairCaso(join(casoTemp(), "nao-existe"));
  assert.deepEqual(r, { extraidos: [], adiados: [], pulados: 0, naoTocados: [], erros: [] });
});

test("extrairCaso: original ilegível no disco vai para erros, sem sidecar", { skip: process.getuid?.() === 0 }, async () => {
  const { chmodSync } = await import("node:fs");
  const dir = casoTemp();
  writeFileSync(join(dir, "trancado.docx"), DOCX);
  chmodSync(join(dir, "trancado.docx"), 0o000);
  const r = await extrairCaso(dir);
  chmodSync(join(dir, "trancado.docx"), 0o644);
  assert.deepEqual(r.erros, [{ rel: "trancado.docx", erro: "ilegível (EACCES)" }]);
  assert.ok(!existsSync(join(dir, "trancado.docx.md")));
});

test("extrairCaso: aba única acima do teto perde linhas do fim e avisa", async () => {
  const dir = casoTemp();
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Única");
  for (let i = 0; i < 300; i++) ws.addRow([`linha ${i} ${"x".repeat(2000)}`]);
  writeFileSync(join(dir, "u.xlsx"), Buffer.from(await wb.xlsx.writeBuffer()));
  const r = await extrairCaso(dir, { maxSaidaBytes: 200 * 1024 });
  assert.equal(r.extraidos.length, 1);
  const md = readFileSync(join(dir, "u.xlsx.md"), "utf-8");
  assert.ok(Buffer.byteLength(md) <= 210 * 1024);
  assert.ok(md.includes("linha 0 ") && !md.includes("linha 299 "));
  assert.ok(lerFrontmatter(md).avisos.some((a) => /linhas do fim da última aba/.test(a)));
});

test("extrairCaso: e-mail com anexo em dia na segunda rodada não regrava nada", async () => {
  const dir = casoTemp();
  writeFileSync(join(dir, "RE Proposta.eml"), EML_COM_DOCX);
  await extrairCaso(dir);
  const antes = ["RE Proposta.eml.md", "RE Proposta.eml.anexos/Minuta.docx", "RE Proposta.eml.anexos/Minuta.docx.md"].map((p) => readFileSync(join(dir, p)));
  const r2 = await extrairCaso(dir);
  assert.deepEqual(r2.extraidos, []);
  assert.equal(r2.pulados, 2);
  const depois = ["RE Proposta.eml.md", "RE Proposta.eml.anexos/Minuta.docx", "RE Proposta.eml.anexos/Minuta.docx.md"].map((p) => readFileSync(join(dir, p)));
  assert.deepEqual(depois, antes);
});

test("extrairCaso: .md do usuário com outra caixa conta como o sidecar (NTFS) e não é tocado", async () => {
  const dir = casoTemp();
  writeFileSync(join(dir, "A.docx"), DOCX);
  writeFileSync(join(dir, "A.DOCX.MD"), "# notas\n");
  const r = await extrairCaso(dir);
  assert.deepEqual(r.extraidos, []);
  assert.deepEqual(r.naoTocados, [{ rel: "A.docx", sidecar: "A.docx.md" }]);
});

test("formatarResumo: erros viram a terceira lista; só erros já não é vazio", () => {
  const base = { extraidos: [], adiados: [], pulados: 0, naoTocados: [], erros: [] };
  assert.equal(
    formatarResumo({ ...base, extraidos: [{ rel: "a.docx", sidecar: "a.docx.md", detalhe: "0 revisores, 0 comentários" }], erros: [{ rel: "x.eml", erro: "Maximum MIME nesting depth of 256 levels exceeded" }] }),
    "Textos extraídos nesta pasta (leia o .md ao lado do original):\n- a.docx.md (0 revisores, 0 comentários)\nNão foi possível extrair (leia o original):\n- x.eml: Maximum MIME nesting depth of 256 levels exceeded",
  );
  assert.equal(formatarResumo({ ...base, erros: [{ rel: "t.docx", erro: "ilegível (EACCES)" }] }), "Não foi possível extrair (leia o original):\n- t.docx: ilegível (EACCES)");
});

test("extrairCaso: sidecar acima do teto do pool ganha aviso e é determinístico", async () => {
  const dir = casoTemp();
  writeFileSync(join(dir, "longo.docx"), construirDocx({ documentXml: documento(paragrafo("y".repeat(4000))) }));
  const r = await extrairCaso(dir, { poolMaxSidecarBytes: 2048 });
  assert.equal(r.extraidos.length, 1);
  const md = readFileSync(join(dir, "longo.docx.md"), "utf-8");
  assert.ok(lerFrontmatter(md).avisos.includes("sidecar acima de 2 MiB: não circula pelo pool de workdocs"));
  // sem o override, o mesmo original fica abaixo do teto e não leva o aviso
  const dir2 = casoTemp();
  writeFileSync(join(dir2, "longo.docx"), construirDocx({ documentXml: documento(paragrafo("y".repeat(4000))) }));
  await extrairCaso(dir2);
  assert.deepEqual(lerFrontmatter(readFileSync(join(dir2, "longo.docx.md"), "utf-8")).avisos, []);
  const r2 = await extrairCaso(dir, { poolMaxSidecarBytes: 2048 });
  assert.equal(r2.pulados, 1);
  assert.equal(readFileSync(join(dir, "longo.docx.md"), "utf-8"), md);
});

test("extrairCaso: falha ao gravar anexo não custa o sidecar do e-mail", async () => {
  const dir = casoTemp();
  writeFileSync(join(dir, "RE Proposta.eml"), EML_COM_DOCX);
  writeFileSync(join(dir, "RE Proposta.eml.anexos"), "sou um arquivo, não uma pasta");
  const r = await extrairCaso(dir);
  assert.deepEqual(r.erros, []);
  assert.deepEqual(r.extraidos.map((e) => e.sidecar), ["RE Proposta.eml.md"]);
  assert.equal(r.extraidos[0].detalhe, "1 anexo, 0 extraídos");
  const md = readFileSync(join(dir, "RE Proposta.eml.md"), "utf-8");
  assert.ok(md.includes("- Minuta.docx (") && md.includes("-> não extraído"));
  assert.ok(lerFrontmatter(md).avisos.some((a) => /^anexo Minuta\.docx não gravado \((ENOTDIR|EEXIST)\)$/.test(a)));
});

test("extrairCaso: detalhe do e-mail conta só anexos que vão ter sidecar", async () => {
  const dir = casoTemp();
  const eml = [
    "From: a@a", "To: b@b", "Subject: Dois", 'Content-Type: multipart/mixed; boundary="B"', "",
    "--B", "Content-Type: text/plain", "", "dois anexos",
    "--B", 'Content-Type: application/octet-stream; name="Minuta.docx"', "Content-Transfer-Encoding: base64", 'Content-Disposition: attachment; filename="Minuta.docx"', "", DOCX.toString("base64"),
    "--B", 'Content-Type: application/pdf; name="Laudo.pdf"', "Content-Transfer-Encoding: base64", 'Content-Disposition: attachment; filename="Laudo.pdf"', "", Buffer.from("%PDF-1.4").toString("base64"),
    "--B--", "",
  ].join("\r\n");
  writeFileSync(join(dir, "dois.eml"), eml);
  const r = await extrairCaso(dir);
  assert.equal(r.extraidos.find((e) => e.rel === "dois.eml").detalhe, "2 anexos, 1 extraído");
  assert.ok(existsSync(join(dir, "dois.eml.anexos", "Laudo.pdf")));
});
