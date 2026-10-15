/**
 * Constrói um .docx mínimo em memória para os testes do leitor. Dado de caso
 * não entra no git: todo documento de teste nasce daqui.
 */
import { zipSync, strToU8 } from "fflate";

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
// OOXML Strict (ISO 29500 estrito): mesmo XML, outro namespace para o prefixo w
const NS_STRICT = 'xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main" xmlns:r="http://purl.oclc.org/ooxml/officeDocument/relationships"';

export const W = NS;
export const W_STRICT = NS_STRICT;

export function paragrafo(texto, { numId, ilvl = 0, estilo } = {}) {
  const pPr = [];
  if (estilo) pPr.push(`<w:pStyle w:val="${estilo}"/>`);
  if (numId !== undefined) pPr.push(`<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`);
  const pr = pPr.length ? `<w:pPr>${pPr.join("")}</w:pPr>` : "";
  return `<w:p>${pr}<w:r><w:t xml:space="preserve">${texto}</w:t></w:r></w:p>`;
}

export function tabela(linhas) {
  const tr = linhas
    .map((cels) => `<w:tr>${cels.map((c) => `<w:tc><w:p><w:r><w:t>${c}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`)
    .join("");
  return `<w:tbl>${tr}</w:tbl>`;
}

export function documento(corpoXml, { strict = false } = {}) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${strict ? NS_STRICT : NS}><w:body>${corpoXml}<w:sectPr/></w:body></w:document>`;
}

/** numbering.xml com um abstractNum decimal de 3 níveis ("%1.", "%1.%2.", "%1.%2.%3.") e numId 1 -> ele. */
export function numeracaoDecimal3Niveis({ numIds = [1], startOverrides = {}, strict = false } = {}) {
  const lvls = [0, 1, 2]
    .map((i) => {
      const txt = ["%1.", "%1.%2.", "%1.%2.%3."][i];
      return `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="${txt}"/></w:lvl>`;
    })
    .join("");
  const nums = numIds
    .map((id) => {
      const ov = startOverrides[id]
        ? `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="${startOverrides[id]}"/></w:lvlOverride>`
        : "";
      return `<w:num w:numId="${id}"><w:abstractNumId w:val="0"/>${ov}</w:num>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${strict ? NS_STRICT : NS}><w:abstractNum w:abstractNumId="0">${lvls}</w:abstractNum>${nums}</w:numbering>`;
}

export function construirDocx({ documentXml, numberingXml, stylesXml, commentsXml, footnotesXml, headerXml, footerXml }) {
  const arquivos = {};
  const overrides = [`<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`];
  const rels = [];
  arquivos["word/document.xml"] = strToU8(documentXml);
  const parte = (nome, xml, tipoRel, ct) => {
    if (!xml) return;
    arquivos[`word/${nome}`] = strToU8(xml);
    overrides.push(`<Override PartName="/word/${nome}" ContentType="${ct}"/>`);
    rels.push(`<Relationship Id="rId${rels.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${tipoRel}" Target="${nome}"/>`);
  };
  parte("numbering.xml", numberingXml, "numbering", "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml");
  parte("styles.xml", stylesXml, "styles", "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml");
  parte("comments.xml", commentsXml, "comments", "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml");
  parte("footnotes.xml", footnotesXml, "footnotes", "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml");
  parte("header1.xml", headerXml, "header", "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml");
  parte("footer1.xml", footerXml, "footer", "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml");
  arquivos["[Content_Types].xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.join("")}</Types>`,
  );
  arquivos["_rels/.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  arquivos["word/_rels/document.xml.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`,
  );
  return Buffer.from(zipSync(arquivos, { level: 0 }));
}
