/**
 * Leitores de e-mail -> {cabecalhos, corpo, anexos, avisos}.
 * .eml: postal-mime (puro). .msg: @kenjiuno/msgreader; corpo em texto quando
 * o Outlook gravou PR_BODY, senão RTF comprimido -> decompressRTF ->
 * deEncapsulateSync (HTML ou texto encapsulado) -> htmlParaTexto. O
 * desencapsulador é injetável para o teste não depender de um .msg real
 * (dado de caso não entra no git); o teste com .msg reais é o benchmark.
 *
 * Determinismo: endereço como "Nome <email>" (ou só o e-mail), data em ISO
 * UTC sem milissegundos, destinatários na ordem da fonte. Nome de anexo sai
 * como a fonte dá: sanitizar para gravar em disco é papel do wiring.
 */
import PostalMime from "postal-mime";
import MsgReaderMod from "@kenjiuno/msgreader";
import { decompressRTF } from "@kenjiuno/decompressrtf";
import { deEncapsulateSync } from "rtf-stream-parser";
import iconv from "iconv-lite";
import { htmlParaTexto, sanitizarNomeAnexo } from "../extracao.mjs";

// o pacote é CommonJS com `exports.default`: num import ESM o default é o
// objeto de exports inteiro, e o construtor fica em `.default`
const MsgReader = MsgReaderMod.default ?? MsgReaderMod;

function endereco(nome, email) {
  const n = (nome ?? "").trim();
  const e = (email ?? "").trim();
  if (n && e && n.toLowerCase() !== e.toLowerCase()) return `${n} <${e}>`;
  return e || n;
}

/**
 * Inline = imagem do corpo do e-mail (logo, assinatura, print colado), que o
 * sidecar lista e o wiring não grava. O sinal do formato (Content-ID; no .msg,
 * PR_ATTACH_CONTENT_ID) só conta para IMAGEM: o Apple Mail manda PDF com
 * `Content-Disposition: inline` e Content-ID, e a conversão MIME do Exchange
 * preserva o Content-ID de anexo comum; sem a restrição, o contrato anexado
 * deixaria de ser gravado e extraído. Anexo oculto do Outlook
 * (PR_ATTACHMENT_HIDDEN) é inline de qualquer tipo: o usuário nunca o viu.
 */
const EXT_IMAGEM = /\.(png|jpe?g|gif|bmp|tiff?|webp|svg|emf|wmf|emz|wmz|ico)$/i;

function ehImagem(nome, mime) {
  return /^image\//i.test(mime ?? "") || EXT_IMAGEM.test(nome ?? "");
}

function dataIso(v) {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function corpoDe(texto, html, avisos) {
  if (texto && texto.trim()) return texto.replace(/\r\n?/g, "\n").trim();
  if (html && html.trim()) return htmlParaTexto(html);
  avisos.push("e-mail sem corpo legível (nem texto nem HTML)");
  return "";
}

export async function lerEml(buffer) {
  const avisos = [];
  const m = await PostalMime.parse(new Uint8Array(buffer));
  // grupo (RFC 5322, "Equipe: x@x, y@y;") vira seus membros na ordem da fonte;
  // grupo vazio ("Undisclosed recipients:;") fica pelo nome, senão sumiria
  const lista = (xs) =>
    (xs ?? []).flatMap((a) =>
      Array.isArray(a.group) ? (a.group.length ? a.group.map((g) => endereco(g.name, g.address)) : [endereco(a.name, "")]) : [endereco(a.name, a.address)],
    );
  return {
    cabecalhos: { de: endereco(m.from?.name, m.from?.address), para: lista(m.to), cc: lista(m.cc), data: dataIso(m.date), assunto: m.subject ?? "" },
    corpo: corpoDe(m.text, m.html, avisos),
    anexos: (m.attachments ?? []).map((a) => {
      // postal-mime entrega o conteúdo como ArrayBuffer (attachmentEncoding padrão)
      const conteudo = a.content ? Buffer.from(a.content) : null;
      const nome = a.filename || "anexo-sem-nome";
      const inline = a.disposition === "inline" && Boolean(a.contentId) && ehImagem(nome, a.mimeType);
      return { nome, bytes: conteudo ? conteudo.length : 0, conteudo, inline };
    }),
    avisos,
  };
}

/**
 * RTF comprimido -> {mode: "html"|"text", text}. `warn` do rtf-stream-parser
 * cai em console.warn por padrão: aqui vira aviso do e-mail (stdout/stderr do
 * hook de sincronização não é lugar de diagnóstico, e nada some calado).
 */
function desencapsularPadrao(compressedRtf, avisar) {
  const rtf = decompressRTF(Array.from(compressedRtf));
  return deEncapsulateSync(Buffer.from(rtf), { decode: iconv.decode, warn: avisar });
}

export function normalizarMsg(fileData, pegarAnexo, { desencapsular = desencapsularPadrao } = {}) {
  const avisos = [];
  // senderEmail/email vêm como DN do Exchange ("/O=EXCHANGELABS/...") quando o
  // tipo de endereço é EX; o SMTP legível, quando existe, fica em campo próprio
  const rec = (tipo) =>
    (fileData.recipients ?? [])
      .filter((r) => (r.recipType ?? "to") === tipo)
      .map((r) => endereco(r.name, r.smtpAddress || r.email));
  let corpo = "";
  if (fileData.body && fileData.body.trim()) corpo = fileData.body.replace(/\r\n?/g, "\n").trim();
  else if (fileData.compressedRtf) {
    try {
      const r = desencapsular(fileData.compressedRtf, (msg) => avisos.push(`corpo em RTF: ${msg}`));
      corpo = r.mode === "html" ? htmlParaTexto(r.text) : String(r.text).replace(/\r\n?/g, "\n").trim();
    } catch (err) {
      avisos.push(`corpo em RTF não pôde ser convertido (${err.message})`);
    }
  } else avisos.push("e-mail sem corpo legível (nem texto nem RTF)");
  const anexos = [];
  for (const att of fileData.attachments ?? []) {
    // .msg aninhado não tem fileName: o msgreader o serializa de novo como
    // .msg e o nomeia pelo `name` (o assunto) + ".msg"
    const nomeBase = att.fileName || att.name || "anexo-sem-nome";
    const nome = att.innerMsgContent && !/\.msg$/i.test(nomeBase) ? `${nomeBase}.msg` : nomeBase;
    let conteudo = null;
    let erroLeitura = false;
    try {
      const a = pegarAnexo(att);
      if (a && a.content) conteudo = Buffer.from(a.content);
    } catch (err) {
      // o nome no aviso é o que o sidecar mostra (sem `..\` nem separadores)
      erroLeitura = true;
      avisos.push(`anexo ${sanitizarNomeAnexo(nome)} não pôde ser lido (${err.message})`);
    }
    const inline = att.attachmentHidden === true || (Boolean(att.pidContentId) && ehImagem(nome, att.attachMimeTag));
    const anexo = { nome, bytes: conteudo ? conteudo.length : att.contentLength ?? 0, conteudo, inline };
    if (erroLeitura) anexo.erroLeitura = true;
    anexos.push(anexo);
  }
  return {
    cabecalhos: {
      de: endereco(fileData.senderName, fileData.senderSmtpAddress || fileData.senderEmail),
      para: rec("to"),
      cc: rec("cc"),
      data: dataIso(fileData.messageDeliveryTime || fileData.clientSubmitTime),
      assunto: fileData.subject ?? "",
    },
    corpo,
    anexos,
    avisos,
  };
}

export function lerMsg(buffer) {
  try {
    // ArrayBuffer exato: com typed array o leitor monta um DataView sem
    // limite de tamanho, que num Buffer do pool do Node enxerga bytes alheios
    const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const reader = new MsgReader(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    const fileData = reader.getFileData();
    if (fileData.error) throw new Error(fileData.error);
    return normalizarMsg(fileData, (att) => reader.getAttachment(att));
  } catch (err) {
    // sem sidecar: o chamador trata como erro (um e-mail vazio pareceria lido)
    return { cabecalhos: { de: "", para: [], cc: [], data: "", assunto: "" }, corpo: "", anexos: [], avisos: [], ilegivel: true, motivo: `.msg não abre (${err.message})` };
  }
}
