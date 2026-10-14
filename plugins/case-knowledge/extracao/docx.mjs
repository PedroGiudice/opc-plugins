/**
 * Leitor OOXML de .docx -> estrutura intermediária (ver spec e o contrato no
 * plano). Leitor próprio porque o que importa em contrato é o que as libs
 * usuais perdem: numeração automática (vive em numbering.xml), marcas de
 * revisão por autor e comentários. mammoth ignora comentários e não
 * documenta w:ins/w:del; pandoc e python-docx perdem numeração.
 *
 * Esta é só a leitura: a renderização em Markdown fica em outro módulo.
 */
import { unzipSync, strFromU8 } from "fflate";
import { DOMParser, onErrorStopParsing } from "@xmldom/xmldom";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function parseXml(u8) {
  // onErrorStopParsing: erro e erro fatal viram ParseError (o chamador trata
  // como arquivo corrompido); só avisos passam. Passar um onError também
  // impede o xmldom de escrever no console, o que sujaria a saída do hook.
  return new DOMParser({ onError: onErrorStopParsing }).parseFromString(strFromU8(u8), "application/xml");
}

function filhos(no) {
  return Array.from(no.childNodes ?? []).filter((n) => n.nodeType === 1);
}

function attr(no, nome) {
  // Conferido no xmldom 0.9: getAttribute("w:val") resolve pelo nome
  // qualificado e devolve null quando falta. O getAttributeNS cobre um
  // documento que use outro prefixo para o mesmo namespace.
  return no.getAttribute(`w:${nome}`) ?? no.getAttributeNS?.(W_NS, nome) ?? null;
}

function primeiro(no, local) {
  return filhos(no).find((n) => n.localName === local) ?? null;
}

// ---------- numeração ----------

function romano(n, maiusculo) {
  const tabela = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let s = "";
  for (const [v, l] of tabela) while (n >= v) { s += l; n -= v; }
  return maiusculo ? s : s.toLowerCase();
}

function letra(n, maiusculo) {
  // 1 -> a, 26 -> z, 27 -> aa (como o Word)
  const base = maiusculo ? 65 : 97;
  const rep = Math.ceil(n / 26);
  return String.fromCharCode(base + ((n - 1) % 26)).repeat(rep);
}

function formatar(numFmt, n) {
  switch (numFmt) {
    case "decimal": return String(n);
    case "decimalZero": return String(n).padStart(2, "0");
    case "lowerLetter": return letra(n, false);
    case "upperLetter": return letra(n, true);
    case "lowerRoman": return romano(n, false);
    case "upperRoman": return romano(n, true);
    case "bullet": return "-";
    case "none": return "";
    default: return String(n);
  }
}

/**
 * Carrega numbering.xml: numId -> {abstractId, overrides{ilvl: start}};
 * abstractId -> [{start, numFmt, lvlText}] por nível.
 */
function carregarNumeracao(doc) {
  const abstratos = new Map();
  const nums = new Map();
  if (!doc) return { abstratos, nums };
  for (const an of Array.from(doc.getElementsByTagNameNS(W_NS, "abstractNum"))) {
    const niveis = [];
    for (const lvl of Array.from(an.getElementsByTagNameNS(W_NS, "lvl"))) {
      const ilvl = Number(attr(lvl, "ilvl"));
      const start = primeiro(lvl, "start");
      const fmt = primeiro(lvl, "numFmt");
      const txt = primeiro(lvl, "lvlText");
      niveis[ilvl] = {
        start: start ? Number(attr(start, "val")) : 1,
        numFmt: fmt ? attr(fmt, "val") : "decimal",
        lvlText: txt ? attr(txt, "val") ?? "" : "%" + (ilvl + 1) + ".",
      };
    }
    abstratos.set(attr(an, "abstractNumId"), niveis);
  }
  for (const num of Array.from(doc.getElementsByTagNameNS(W_NS, "num"))) {
    const ab = primeiro(num, "abstractNumId");
    const overrides = {};
    for (const ov of Array.from(num.getElementsByTagNameNS(W_NS, "lvlOverride"))) {
      const so = primeiro(ov, "startOverride");
      if (so) overrides[Number(attr(ov, "ilvl"))] = Number(attr(so, "val"));
    }
    nums.set(attr(num, "numId"), { abstractId: ab ? attr(ab, "val") : null, overrides });
  }
  return { abstratos, nums };
}

/** styles.xml: styleId -> {basedOn, numPr: {numId, ilvl} | null}. */
function carregarEstilos(doc) {
  const estilos = new Map();
  if (!doc) return estilos;
  for (const st of Array.from(doc.getElementsByTagNameNS(W_NS, "style"))) {
    const basedOn = primeiro(st, "basedOn");
    const pPr = primeiro(st, "pPr");
    const numPr = pPr ? primeiro(pPr, "numPr") : null;
    estilos.set(attr(st, "styleId"), { basedOn: basedOn ? attr(basedOn, "val") : null, numPr: numPr ? lerNumPr(numPr) : null });
  }
  return estilos;
}

function lerNumPr(numPr) {
  const numId = primeiro(numPr, "numId");
  const ilvl = primeiro(numPr, "ilvl");
  return { numId: numId ? attr(numId, "val") : null, ilvl: ilvl ? Number(attr(ilvl, "val")) : 0 };
}

/** numPr efetivo do parágrafo: o próprio, senão o do estilo (seguindo basedOn, com teto contra ciclo). */
function numPrEfetivo(p, estilos) {
  const pPr = primeiro(p, "pPr");
  if (pPr) {
    const direto = primeiro(pPr, "numPr");
    if (direto) return lerNumPr(direto);
    const pStyle = primeiro(pPr, "pStyle");
    if (pStyle) {
      let id = attr(pStyle, "val");
      for (let i = 0; i < 20 && id && estilos.has(id); i++) {
        const st = estilos.get(id);
        if (st.numPr) return st.numPr;
        id = st.basedOn;
      }
    }
  }
  return null;
}

/**
 * Contadores por numId. Um numId diferente para o mesmo abstractNum reinicia a
 * contagem (é assim que o Word reinicia listas, com ou sem startOverride).
 * Nível inferior zera quando um superior incrementa.
 */
function criarNumerador(numeracao) {
  const contadores = new Map(); // numId -> array por nível
  return function proximo(numPr) {
    if (!numPr || !numPr.numId || numPr.numId === "0") return null;
    const num = numeracao.nums.get(numPr.numId);
    if (!num) return null;
    const niveis = numeracao.abstratos.get(num.abstractId);
    if (!niveis) return null;
    const ilvl = numPr.ilvl;
    const lvl = niveis[ilvl];
    if (!lvl) return null;
    let cont = contadores.get(numPr.numId);
    if (!cont) {
      cont = niveis.map((n, i) => (num.overrides[i] ?? n?.start ?? 1) - 1);
      contadores.set(numPr.numId, cont);
    }
    cont[ilvl] += 1;
    for (let i = ilvl + 1; i < cont.length; i++) cont[i] = (num.overrides[i] ?? niveis[i]?.start ?? 1) - 1;
    if (lvl.numFmt === "bullet") return "-";
    return lvl.lvlText.replace(/%(\d)/g, (_, d) => {
      const i = Number(d) - 1;
      const n = niveis[i];
      return n ? formatar(n.numFmt, Math.max(cont[i], 1)) : "";
    });
  };
}

// ---------- texto ----------

/**
 * Percorre um parágrafo e devolve segmentos. Nesta versão toda marca é null;
 * o `switch` por localName é o ponto onde entram revisões, comentários e
 * notas. Elemento sem caso próprio é atravessado (hyperlink, sdt, fldSimple,
 * smartTag...): o texto dele é texto do parágrafo.
 */
function segmentosDoParagrafo(p, ctx) {
  const segs = [];
  let atual = { texto: "", marca: null };
  const fecha = () => { if (atual.texto) segs.push(atual); atual = { texto: "", marca: null }; };
  const visitar = (no, estado) => {
    for (const f of filhos(no)) {
      switch (f.localName) {
        case "t":
          atual.texto += f.textContent ?? "";
          break;
        case "tab":
          atual.texto += "\t";
          break;
        case "br":
        case "cr":
          atual.texto += "\n";
          break;
        case "instrText":
        case "delInstrText":
        case "rPr":
        case "pPr":
          // instrText é o código do campo (PAGE, REF...); o resultado visível
          // vem depois do fldChar "separate", em w:t comum.
          break;
        case "tbl": {
          // tabela dentro de parágrafo (só aparece em XML atípico): achatada no texto
          const t = lerTabela(f, ctx);
          atual.texto += t.linhas.map((l) => l.join(" | ")).join(" / ");
          break;
        }
        default:
          visitar(f, estado);
      }
    }
  };
  visitar(p, {});
  fecha();
  return segs;
}

/**
 * Texto de uma célula: parágrafos unidos por " / " e tabela aninhada achatada
 * ("a | b / c | d"), porque uma célula de tabela Markdown não comporta bloco.
 */
function textoDaCelula(tc, ctx) {
  const partes = [];
  for (const f of filhos(tc)) {
    if (f.localName === "p") {
      const t = segmentosDoParagrafo(f, ctx).map((s) => s.texto).join("");
      if (t) partes.push(t);
    } else if (f.localName === "tbl") {
      const t = lerTabela(f, ctx);
      partes.push(t.linhas.map((l) => l.join(" | ")).join(" / "));
    }
  }
  return partes.join(" / ");
}

function lerTabela(tbl, ctx) {
  const linhas = [];
  for (const tr of filhos(tbl).filter((n) => n.localName === "tr")) {
    const cels = [];
    for (const tc of filhos(tr).filter((n) => n.localName === "tc")) {
      cels.push(textoDaCelula(tc, ctx));
      // célula mesclada na horizontal: as colunas que ela cobre viram células
      // vazias, para a linha manter o número de colunas da grade
      const tcPr = primeiro(tc, "tcPr");
      const span = tcPr ? primeiro(tcPr, "gridSpan") : null;
      const n = span ? Number(attr(span, "val")) : 1;
      for (let i = 1; i < n; i++) cels.push("");
    }
    linhas.push(cels);
  }
  return { tipo: "tabela", linhas };
}

function lerCorpo(body, ctx, numerador, estilos) {
  const blocos = [];
  for (const f of filhos(body)) {
    if (f.localName === "p") {
      // conta todo parágrafo (vazio inclusive): é a posição no documento,
      // usada como âncora pelos avisos
      ctx.paragrafoAtual += 1;
      const segmentos = segmentosDoParagrafo(f, ctx);
      const numPr = numPrEfetivo(f, estilos);
      const numero = numerador(numPr);
      if (segmentos.length === 0 && !numero) continue;
      const bloco = { tipo: "paragrafo", numero, segmentos };
      // ilvl só no parágrafo numerado: serve para contar os níveis de fato usados
      if (numero) bloco.ilvl = numPr.ilvl;
      blocos.push(bloco);
    } else if (f.localName === "tbl") {
      blocos.push(lerTabela(f, ctx));
    } else if (f.localName === "sdt") {
      const conteudo = primeiro(f, "sdtContent");
      if (conteudo) blocos.push(...lerCorpo(conteudo, ctx, numerador, estilos));
    }
  }
  return blocos;
}

export function abrirPacote(buffer) {
  const zip = unzipSync(new Uint8Array(buffer));
  const parte = (nome) => (zip[nome] ? parseXml(zip[nome]) : null);
  return { zip, parte };
}

export function lerDocx(buffer) {
  const saida = { blocos: [], comentarios: [], notas: [], cabecalhoRodape: [], avisos: [], temNumeracao: false, niveisNumeracao: 0 };
  let docXml, numeracao, estilos;
  try {
    // O parse das partes fica dentro do try: XML malformado num zip íntegro
    // também é arquivo corrompido, e deve virar aviso, não exceção.
    const pacote = abrirPacote(buffer);
    if (!pacote.zip["word/document.xml"]) throw new Error("sem word/document.xml");
    docXml = pacote.parte("word/document.xml");
    numeracao = carregarNumeracao(pacote.parte("word/numbering.xml"));
    estilos = carregarEstilos(pacote.parte("word/styles.xml"));
  } catch (err) {
    saida.avisos.push(`não foi possível abrir o .docx (${err.message}); arquivo protegido ou corrompido`);
    return saida;
  }
  const numerador = criarNumerador(numeracao);
  const ctx = { avisos: saida.avisos, paragrafoAtual: 0 };
  const body = docXml.getElementsByTagNameNS(W_NS, "body")[0];
  saida.blocos = body ? lerCorpo(body, ctx, numerador, estilos) : [];
  const numerados = saida.blocos.filter((b) => b.tipo === "paragrafo" && b.numero);
  saida.temNumeracao = numerados.length > 0;
  // níveis = profundidades distintas de fato usadas no documento, não as que
  // o numbering.xml define (o Word define 9 níveis em toda lista)
  saida.niveisNumeracao = new Set(numerados.map((b) => b.ilvl)).size;
  return saida;
}
