// extracao/email.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { burn } from "@kenjiuno/msgreader/lib/Burner.js";
import { TypeEnum } from "@kenjiuno/msgreader/lib/Reader.js";
import { lerEml, lerMsg, normalizarMsg } from "./email.mjs";

const EML = [
  "From: Ana Silva <ana@x.com>",
  "To: Bruno <bruno@y.com>, carla@z.com",
  "Cc: dani@w.com",
  "Subject: =?UTF-8?B?UkU6IFByb3Bvc3RhIGNvbWVyY2lhbA==?=",
  "Date: Tue, 01 Sep 2026 10:30:00 +0000",
  'Content-Type: multipart/mixed; boundary="B1"',
  "",
  "--B1",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Segue a <b>proposta</b>.</p><p>Att.</p>",
  "--B1",
  'Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document; name="Proposta.docx"',
  "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="Proposta.docx"',
  "",
  Buffer.from("conteudo-docx").toString("base64"),
  "--B1--",
  "",
].join("\r\n");

test("lerEml: cabeçalhos, corpo a partir do HTML (sem versão texto), anexo com bytes", async () => {
  const e = await lerEml(Buffer.from(EML));
  assert.deepEqual(e.cabecalhos, {
    de: "Ana Silva <ana@x.com>",
    para: ["Bruno <bruno@y.com>", "carla@z.com"],
    cc: ["dani@w.com"],
    data: "2026-09-01T10:30:00Z",
    assunto: "RE: Proposta comercial",
  });
  assert.equal(e.corpo, "Segue a proposta.\nAtt.");
  assert.equal(e.anexos.length, 1);
  assert.equal(e.anexos[0].nome, "Proposta.docx");
  assert.equal(e.anexos[0].bytes, 13);
  assert.equal(Buffer.from(e.anexos[0].conteudo).toString(), "conteudo-docx");
  assert.deepEqual(e.avisos, []);
});

test("lerEml: versão texto tem preferência sobre HTML; sem corpo nenhum vira aviso", async () => {
  const dois = 'From: a@a\r\nTo: b@b\r\nSubject: s\r\nContent-Type: multipart/alternative; boundary="X"\r\n\r\n--X\r\nContent-Type: text/plain\r\n\r\ntexto puro\r\n--X\r\nContent-Type: text/html\r\n\r\n<p>html</p>\r\n--X--\r\n';
  const e = await lerEml(Buffer.from(dois));
  assert.equal(e.corpo, "texto puro");
  const vazio = await lerEml(Buffer.from("From: a@a\r\nTo: b@b\r\nSubject: s\r\n\r\n"));
  assert.equal(vazio.corpo, "");
  assert.deepEqual(vazio.avisos, ["e-mail sem corpo legível (nem texto nem HTML)"]);
});

test("lerEml: grupo de destinatários vira seus membros em ordem; grupo vazio vira o nome do grupo", async () => {
  const eml = "From: a@a\r\nTo: Equipe: x@x, Yara <y@y>;, Vazio:;, z@z\r\nCc: Outros: w@w;\r\nSubject: s\r\n\r\ncorpo\r\n";
  const e = await lerEml(Buffer.from(eml));
  assert.deepEqual(e.cabecalhos.para, ["x@x", "Yara <y@y>", "Vazio", "z@z"]);
  assert.deepEqual(e.cabecalhos.cc, ["w@w"]);
});

test("normalizarMsg: campos do msgreader viram cabeçalhos; body em texto tem preferência", () => {
  const fileData = {
    subject: "RE: Proposta",
    senderName: "Ana Silva",
    senderEmail: "ana@x.com",
    recipients: [
      { name: "Bruno", email: "bruno@y.com", recipType: "to" },
      { name: "carla@z.com", email: "carla@z.com", recipType: "to" },
      { name: "Dani", email: "dani@w.com", recipType: "cc" },
    ],
    body: "Segue a proposta.\r\n\r\nAtt.\r\n",
    messageDeliveryTime: "Tue, 01 Sep 2026 10:30:00 GMT",
    attachments: [{ dataId: 1, contentLength: 13, fileName: "Proposta.docx" }],
  };
  const e = normalizarMsg(fileData, () => ({ fileName: "Proposta.docx", content: new Uint8Array(Buffer.from("conteudo-docx")) }));
  assert.deepEqual(e.cabecalhos, { de: "Ana Silva <ana@x.com>", para: ["Bruno <bruno@y.com>", "carla@z.com"], cc: ["Dani <dani@w.com>"], data: "2026-09-01T10:30:00Z", assunto: "RE: Proposta" });
  assert.equal(e.corpo, "Segue a proposta.\n\nAtt.");
  assert.deepEqual(e.anexos.map((a) => [a.nome, a.bytes]), [["Proposta.docx", 13]]);
});

test("normalizarMsg: sem body, usa o RTF comprimido (HTML encapsulado) via desencapsular injetado", () => {
  const fileData = { subject: "s", senderEmail: "a@a", recipients: [], body: "", compressedRtf: new Uint8Array([1, 2, 3]), attachments: [] };
  const e = normalizarMsg(fileData, () => null, { desencapsular: () => ({ mode: "html", text: "<p>Do <b>RTF</b></p>" }) });
  assert.equal(e.corpo, "Do RTF");
  assert.deepEqual(e.avisos, []);
});

test("normalizarMsg: RTF que não desencapsula vira aviso; anexo que não abre também", () => {
  const fileData = { subject: "s", senderEmail: "a@a", recipients: [], body: "", compressedRtf: new Uint8Array([1]), attachments: [{ fileName: "x.pdf", contentLength: 9 }] };
  const e = normalizarMsg(fileData, () => { throw new Error("corrompido"); }, { desencapsular: () => { throw new Error("rtf ruim"); } });
  assert.equal(e.corpo, "");
  assert.deepEqual(e.avisos, ["corpo em RTF não pôde ser convertido (rtf ruim)", "anexo x.pdf não pôde ser lido (corrompido)"]);
  assert.equal(e.anexos[0].conteudo, null);
});

test("normalizarMsg: anexo .msg aninhado (sem fileName, com innerMsgContent) é listado com nome derivado do assunto", () => {
  const fileData = { subject: "s", senderEmail: "a@a", recipients: [], body: "b", attachments: [{ innerMsgContent: true, name: "Encaminhado" }] };
  const e = normalizarMsg(fileData, () => null);
  assert.equal(e.anexos[0].nome, "Encaminhado.msg");
});

test("normalizarMsg: endereço SMTP vence o endereço Exchange (EX) do remetente e do destinatário", () => {
  // o msgreader documenta que senderEmail/email vêm como DN do Exchange
  // ("/O=EXCHANGELABS/...") quando o tipo é EX; o SMTP fica em campo próprio
  const fileData = {
    subject: "s",
    senderName: "Ana",
    senderEmail: "/O=EXCHANGELABS/OU=GRUPO/CN=RECIPIENTS/CN=ANA",
    senderSmtpAddress: "ana@x.com",
    recipients: [{ name: "Bruno", email: "/O=EXCHANGELABS/CN=BRUNO", smtpAddress: "bruno@y.com", recipType: "to" }],
    body: "b",
    attachments: [],
  };
  const e = normalizarMsg(fileData, () => null);
  assert.equal(e.cabecalhos.de, "Ana <ana@x.com>");
  assert.deepEqual(e.cabecalhos.para, ["Bruno <bruno@y.com>"]);
});

test("normalizarMsg: aviso emitido pelo desencapsulador vira aviso do e-mail (nada vai para o console)", () => {
  const fileData = { subject: "s", senderEmail: "a@a", recipients: [], body: "", compressedRtf: new Uint8Array([1]), attachments: [] };
  const e = normalizarMsg(fileData, () => null, {
    desencapsular: (_rtf, avisar) => { avisar("codepage desconhecida"); return { mode: "text", text: "ok" }; },
  });
  assert.equal(e.corpo, "ok");
  assert.deepEqual(e.avisos, ["corpo em RTF: codepage desconhecida"]);
});

// .msg sintético gerado pelo gravador CFBF do próprio msgreader (sem dado de
// caso): assunto, remetente, corpo só em RTF comprimido (forma "MELA", sem
// compressão) com HTML encapsulado em cp1252, e um anexo.
function msgSintetico() {
  // cópia com byteOffset 0: com Buffer do pool do Node (byteOffset != 0) o
  // .msg gravado e relido saiu com strings erradas
  const u8 = (b) => new Uint8Array(b);
  const u16 = (s) => u8(Buffer.from(s, "utf16le"));
  const doc = (name, buf) => ({ name, type: TypeEnum.DOCUMENT, binaryProvider: () => buf, length: buf.length });
  const rtf = Buffer.from("{\\rtf1\\ansi\\ansicpg1252\\fromhtml1 \\deff0{\\fonttbl{\\f0\\fswiss Arial;}}{\\*\\htmltag64 <p>}Proposta revisada {\\*\\htmltag84 <b>}anexa{\\*\\htmltag92 </b>}, at\\'e9 sexta.{\\*\\htmltag72 </p>}}", "latin1");
  const cab = Buffer.alloc(16);
  cab.writeInt32LE(rtf.length + 12, 0);
  cab.writeInt32LE(rtf.length, 4);
  cab.writeInt32LE(0x414c454d, 8); // "MELA": RTF não comprimido
  const entries = [
    { name: "Root Entry", type: TypeEnum.ROOT, children: [1, 2, 3, 4, 5], length: 0 },
    doc("__substg1.0_0037001F", u16("RE: Proposta")),
    doc("__substg1.0_0C1A001F", u16("Ana Silva")),
    doc("__substg1.0_0C1F001F", u16("ana@x.com")),
    doc("__substg1.0_10090102", u8(Buffer.concat([cab, rtf]))),
    { name: "__attach_version1.0_#00000000", type: TypeEnum.DIRECTORY, children: [6, 7], length: 0 },
    doc("__substg1.0_3707001F", u16("Proposta.docx")),
    doc("__substg1.0_37010102", u8(Buffer.from("conteudo-docx"))),
  ];
  return Buffer.from(burn(entries));
}

test("lerMsg: .msg sintético de ponta a ponta (RTF comprimido -> HTML encapsulado -> texto, anexo com bytes)", () => {
  const e = lerMsg(msgSintetico());
  assert.equal(e.cabecalhos.de, "Ana Silva <ana@x.com>");
  assert.equal(e.cabecalhos.assunto, "RE: Proposta");
  assert.equal(e.corpo, "Proposta revisada anexa, até sexta.");
  assert.deepEqual(e.anexos.map((a) => [a.nome, a.bytes, Buffer.from(a.conteudo).toString()]), [["Proposta.docx", 13, "conteudo-docx"]]);
  assert.deepEqual(e.avisos, []);
});

test("lerMsg: arquivo que não é .msg é ilegível, não exceção", () => {
  const e = lerMsg(Buffer.from("isto não é um arquivo CFBF"));
  assert.equal(e.corpo, "");
  assert.equal(e.ilegivel, true);
  assert.match(e.motivo, /^\.msg não abre \(/);
  assert.deepEqual(e.avisos, []);
});

test("normalizarMsg: anexo oculto ou imagem com content-id é inline; documento com content-id não", () => {
  const fileData = {
    subject: "s", senderEmail: "a@a", recipients: [], body: "b",
    attachments: [
      { fileName: "image001.png", attachmentHidden: true },
      { fileName: "assinatura.jpg", pidContentId: "abc@x" },
      { fileName: "contrato.pdf", pidContentId: "def@x", attachMimeTag: "application/pdf" },
      { fileName: "oculto.docx", attachmentHidden: true },
      { fileName: "normal.docx" },
    ],
  };
  const e = normalizarMsg(fileData, () => ({ content: new Uint8Array([1]) }));
  assert.deepEqual(e.anexos.map((a) => [a.nome, a.inline]), [["image001.png", true], ["assinatura.jpg", true], ["contrato.pdf", false], ["oculto.docx", true], ["normal.docx", false]]);
});

test("lerEml: inline só com disposition inline + content-id + imagem", async () => {
  const eml = [
    "From: a@a", "To: b@b", "Subject: s", 'Content-Type: multipart/related; boundary="R"', "",
    "--R", "Content-Type: text/html", "", '<p>oi <img src="cid:i1"></p>',
    "--R", 'Content-Type: image/png; name="logo.png"', "Content-Transfer-Encoding: base64", 'Content-Disposition: inline; filename="logo.png"', "Content-ID: <i1>", "", Buffer.from("PNG").toString("base64"),
    "--R", 'Content-Type: image/png; name="foto.png"', "Content-Transfer-Encoding: base64", 'Content-Disposition: attachment; filename="foto.png"', "Content-ID: <i2>", "", Buffer.from("PNG").toString("base64"),
    "--R--", "",
  ].join("\r\n");
  const e = await lerEml(Buffer.from(eml));
  assert.deepEqual(e.anexos.map((a) => [a.nome, a.inline]), [["logo.png", true], ["foto.png", false]]);
});

test("normalizarMsg: aviso de anexo ilegível usa o nome sem separadores de caminho", () => {
  const fileData = { subject: "s", senderEmail: "a@a", recipients: [], body: "b", attachments: [{ fileName: "..\\pasta/x.pdf" }] };
  const e = normalizarMsg(fileData, () => { throw new Error("ruim"); });
  assert.deepEqual(e.avisos, ["anexo pasta_x.pdf não pôde ser lido (ruim)"]);
  assert.equal(e.anexos[0].erroLeitura, true);
});
