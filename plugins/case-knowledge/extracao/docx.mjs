/**
 * Leitor OOXML de .docx -> estrutura intermediária (ver spec e o contrato no
 * plano). Leitor próprio porque o que importa em contrato é o que as libs
 * usuais perdem: numeração automática (vive em numbering.xml), marcas de
 * revisão por autor e comentários. mammoth ignora comentários e não
 * documenta w:ins/w:del; pandoc e python-docx perdem numeração.
 *
 * Esta é só a leitura: a renderização em Markdown fica em extracao.mjs (daqui
 * só se usa a notação de segmentos, no texto de célula de tabela).
 */
import { unzipSync, strFromU8 } from "fflate";
import { DOMParser, onErrorStopParsing } from "@xmldom/xmldom";
import { renderSegmentos } from "../extracao.mjs";

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

/**
 * Filhos de um nó estrutural (corpo, tabela, linha, célula) com os
 * invólucros abertos: w:sdt (controle de conteúdo) contribui o que está em
 * w:sdtContent, e w:customXml contribui os próprios filhos. Os dois podem
 * embrulhar parágrafo, tabela, linha ou célula; sem abrir, o conteúdo some
 * calado. sdtPr/sdtEndPr ficam de fora (são propriedades, não conteúdo).
 */
function filhosDesembrulhados(no) {
  const saida = [];
  for (const f of filhos(no)) {
    if (f.localName === "sdt") {
      const conteudo = primeiro(f, "sdtContent");
      if (conteudo) saida.push(...filhosDesembrulhados(conteudo));
    } else if (f.localName === "customXml") {
      saida.push(...filhosDesembrulhados(f));
    } else {
      saida.push(f);
    }
  }
  return saida;
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
 * Contadores por abstractNum, como o Word: todo w:num que aponta para o mesmo
 * abstractNum CONTINUA a mesma lista. Só um lvlOverride/startOverride reinicia,
 * e só os níveis sobrescritos, na primeira vez que aquele numId aparece.
 *
 * Cada nível guarda se já foi usado: nível nunca emitido (ou zerado porque um
 * superior avançou) é exibido com o valor de start, e o primeiro parágrafo
 * nele recebe exatamente esse valor. Isso cobre start 0 ("0.", "1.") e o
 * nível superior nunca emitido ("5.1." com start 5), que um contador
 * pré-decrementado com piso em 1 errava.
 */
function criarNumerador(numeracao) {
  const listas = new Map(); // abstractId -> { cont: [], usado: [] }
  const numIdsVistos = new Set();
  return function proximo(numPr) {
    if (!numPr || !numPr.numId || numPr.numId === "0") return null;
    const num = numeracao.nums.get(numPr.numId);
    if (!num) return null;
    const niveis = numeracao.abstratos.get(num.abstractId);
    if (!niveis) return null;
    const ilvl = numPr.ilvl;
    const lvl = niveis[ilvl];
    if (!lvl) return null;
    let lista = listas.get(num.abstractId);
    if (!lista) {
      lista = { cont: [], usado: [] };
      listas.set(num.abstractId, lista);
    }
    // start efetivo: o startOverride deste numId, senão o start do nível
    const inicio = (i) => num.overrides[i] ?? niveis[i]?.start ?? 1;
    if (!numIdsVistos.has(numPr.numId)) {
      numIdsVistos.add(numPr.numId);
      for (const i of Object.keys(num.overrides)) lista.usado[Number(i)] = false;
    }
    lista.cont[ilvl] = lista.usado[ilvl] ? lista.cont[ilvl] + 1 : inicio(ilvl);
    lista.usado[ilvl] = true;
    for (let i = ilvl + 1; i < niveis.length; i++) lista.usado[i] = false;
    if (lvl.numFmt === "bullet") return "-";
    return lvl.lvlText.replace(/%(\d)/g, (_, d) => {
      const i = Number(d) - 1;
      const n = niveis[i];
      return n ? formatar(n.numFmt, lista.usado[i] ? lista.cont[i] : inicio(i)) : "";
    });
  };
}

// ---------- texto ----------

/**
 * Percorre um parágrafo e devolve segmentos {texto, marca, autor?}. A marca
 * vem do invólucro de revisão (w:ins/w:moveTo = "ins", w:del/w:moveFrom =
 * "del"). Exclusão vence em QUALQUER profundidade, com o autor daquela
 * exclusão: del(Bruno) > ins(Ana) e ins(Ana) > del(Bruno) saem os dois como
 * del de Bruno, porque o texto apagado não fica no contrato aceito,
 * qualquer que seja a ordem em que o Word aninhou as marcas (ins por fora é
 * a forma usual quando um revisor apaga o que outro inseriu). ins só vale
 * quando não há del na cadeia.
 *
 * Âncoras viram segmentos de texto vazio: {comentarios:[ids]} no fim do range
 * do comentário e {nota:id} no ponto da nota de rodapé. Elemento que não é
 * texto (imagem, caixa de texto, equação, objeto) não é lido: vai para
 * ctx.registrar e vira aviso. Elemento sem caso próprio é atravessado
 * (hyperlink, sdt, fldSimple, smartTag, r...): o texto dele é do parágrafo.
 */
function segmentosDoParagrafo(p, ctx) {
  const segs = [];
  let atual = null;
  const abrir = (estado) => {
    atual = { texto: "", marca: estado.marca };
    if (estado.marca) atual.autor = estado.autor;
  };
  const fechar = () => {
    if (atual && atual.texto) segs.push(atual);
    atual = null;
  };
  const garantir = (estado) => {
    if (!atual || atual.marca !== estado.marca || (estado.marca && atual.autor !== estado.autor)) {
      fechar();
      abrir(estado);
    }
  };
  const ancora = (campo, valor) => {
    fechar();
    const s = { texto: "", marca: null };
    s[campo] = valor;
    segs.push(s);
  };
  const ancorarComentario = (id) => {
    // vários ranges que terminam no mesmo ponto dividem a mesma âncora
    const ultimo = segs[segs.length - 1];
    if (atual === null && ultimo && ultimo.comentarios) ultimo.comentarios.push(id);
    else ancora("comentarios", [id]);
    ctx.comentariosReferenciados.add(id);
  };
  const marcar = (no, marca) => ({ marca, autor: attr(no, "author") ?? "" });
  const visitar = (no, estado) => {
    for (const f of filhos(no)) {
      switch (f.localName) {
        case "t":
        case "delText":
          garantir(estado);
          atual.texto += f.textContent ?? "";
          break;
        case "tab":
          garantir(estado);
          atual.texto += "\t";
          break;
        case "br":
        case "cr":
          garantir(estado);
          atual.texto += "\n";
          break;
        case "noBreakHyphen":
          // hífen inseparável (comum em CNPJ, CPF e número de processo): sem
          // este caso o hífen sumia do texto
          garantir(estado);
          atual.texto += "-";
          break;
        case "ins":
        case "moveTo":
          // ins não sobrepõe marca já em vigor (ins externo ou del externo)
          visitar(f, estado.marca ? estado : marcar(f, "ins"));
          break;
        case "del":
        case "moveFrom":
          // del sobrepõe ins externo; sob outro del, o externo segue valendo
          visitar(f, estado.marca === "del" ? estado : marcar(f, "del"));
          break;
        case "commentRangeStart":
          // fecha o segmento: o trecho comentado fica num segmento próprio,
          // e a âncora no fim do range aponta exatamente para ele
          fechar();
          break;
        case "commentRangeEnd":
          ancorarComentario(attr(f, "id"));
          break;
        case "commentReference": {
          // Comentário sem range (só a referência) é válido no OOXML; sem
          // esta âncora ele sumiria calado. Com range, a âncora já foi posta
          // no commentRangeEnd e a referência é ignorada.
          const id = attr(f, "id");
          if (!ctx.comentariosReferenciados.has(id)) ancorarComentario(id);
          break;
        }
        case "footnoteReference": {
          const id = attr(f, "id");
          ancora("nota", id);
          ctx.notasReferenciadas.add(id);
          break;
        }
        case "endnoteReference":
          // nota de fim não é renderizada (o leitor só cobre footnotes.xml): aviso
          ctx.registrar("notaFim", ctx.paragrafoAtual);
          break;
        case "AlternateContent": {
          // mc:AlternateContent traz a mesma coisa duas vezes (Choice moderno e
          // Fallback VML). Atravessar os dois duplicava o conteúdo ("CAIXACAIXA");
          // só o primeiro Choice é lido, como faz um consumidor que o entende.
          const escolha = primeiro(f, "Choice");
          if (escolha) visitar(escolha, estado);
          break;
        }
        case "drawing":
        case "pict":
          // com txbxContent é caixa de texto (o texto dela NÃO é lido: a
          // posição dela no documento não é a do parágrafo); sem, é imagem ou forma
          if (f.getElementsByTagNameNS(W_NS, "txbxContent").length > 0) ctx.registrar("caixa", ctx.paragrafoAtual);
          else ctx.registrar("imagem", ctx.paragrafoAtual);
          break;
        case "object":
          ctx.registrar("objeto", ctx.paragrafoAtual);
          break;
        case "oMathPara":
        case "oMath":
          // não desce: o oMath de dentro de um oMathPara não conta de novo
          ctx.registrar("equacao", ctx.paragrafoAtual);
          break;
        case "instrText":
        case "delInstrText":
        case "rPr":
        case "pPr":
        case "footnoteRef":
        case "separator":
        case "continuationSeparator":
          // instrText é o código do campo (PAGE, REF...); o resultado visível
          // vem depois do fldChar "separate", em w:t comum. rPr/pPr guardam
          // propriedades (inclusive marcas de revisão da marca de parágrafo,
          // que não são texto).
          break;
        case "tbl": {
          // tabela dentro de parágrafo (só aparece em XML atípico): achatada no texto
          garantir(estado);
          const t = lerTabela(f, ctx);
          atual.texto += t.linhas.map((l) => l.join(" | ")).join(" / ");
          break;
        }
        default:
          visitar(f, estado);
      }
    }
  };
  visitar(p, { marca: null, autor: null });
  fechar();
  return segs;
}

/**
 * Texto de uma célula: parágrafos unidos por " / " e tabela aninhada achatada
 * ("a | b / c | d"), porque uma célula de tabela Markdown não comporta bloco.
 * Os segmentos saem na notação do sidecar (renderSegmentos): sem isso, texto
 * excluído numa célula pareceria aceito e a âncora de comentário ou nota se
 * perderia.
 */
function textoDaCelula(tc, ctx, render, segmentos) {
  const partes = [];
  for (const f of filhosDesembrulhados(tc)) {
    if (f.localName === "p") {
      const segs = segmentosDoParagrafo(f, ctx);
      segmentos.push(...segs);
      const t = render(segs);
      if (t) partes.push(t);
    } else if (f.localName === "tbl") {
      const t = lerTabela(f, ctx, render);
      segmentos.push(...t.segmentos);
      partes.push(t.linhas.map((l) => l.join(" | ")).join(" / "));
    }
  }
  return partes.join(" / ");
}

/**
 * Tabela -> {tipo, linhas, segmentos}. `linhas` é o texto de cada célula já
 * renderizado por `render` (por padrão a notação do sidecar; o cabeçalho usa
 * o texto aceito). `segmentos` são todos os segmentos de todas as células,
 * em ordem, âncoras inclusive: é por eles que a radiografia conta marcas e
 * placeholders dentro de tabela, sem reler o texto renderizado.
 */
function lerTabela(tbl, ctx, render = renderSegmentos) {
  const linhas = [];
  const segmentos = [];
  for (const tr of filhosDesembrulhados(tbl).filter((n) => n.localName === "tr")) {
    const cels = [];
    for (const tc of filhosDesembrulhados(tr).filter((n) => n.localName === "tc")) {
      cels.push(textoDaCelula(tc, ctx, render, segmentos));
      // célula mesclada na horizontal: as colunas que ela cobre viram células
      // vazias, para a linha manter o número de colunas da grade
      const tcPr = primeiro(tc, "tcPr");
      const span = tcPr ? primeiro(tcPr, "gridSpan") : null;
      const n = span ? Number(attr(span, "val")) : 1;
      for (let i = 1; i < n; i++) cels.push("");
    }
    linhas.push(cels);
  }
  return { tipo: "tabela", linhas, segmentos };
}

function lerCorpo(body, ctx, numerador, estilos) {
  const blocos = [];
  for (const f of filhosDesembrulhados(body)) {
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
    }
  }
  return blocos;
}

// ---------- avisos ----------

// Ordem fixa dos avisos e as formas singular/plural de cada tipo.
const TIPOS_AVISO = [
  ["imagem", "imagem não renderizada", "imagens não renderizadas"],
  ["caixa", "caixa de texto ignorada", "caixas de texto ignoradas"],
  ["equacao", "equação não renderizada", "equações não renderizadas"],
  ["objeto", "objeto embutido não renderizado", "objetos embutidos não renderizados"],
  ["notaFim", "nota de fim não renderizada", "notas de fim não renderizadas"],
];

/** {tipo: [parágrafo por ocorrência]} -> avisos, um por tipo, na ordem fixa. */
function avisosDosRegistros(registros) {
  const saida = [];
  for (const [tipo, um, varios] of TIPOS_AVISO) {
    const ocorrencias = registros[tipo];
    if (!ocorrencias || ocorrencias.length === 0) continue;
    const n = ocorrencias.length;
    const paragrafos = [...new Set(ocorrencias)];
    const onde = `${paragrafos.length === 1 ? "parágrafo" : "parágrafos"} ${paragrafos.join(", ")}`;
    saida.push(`${n} ${n === 1 ? um : varios} (${onde})`);
  }
  return saida;
}

// ---------- partes auxiliares: comentários, notas, cabeçalho e rodapé ----------

/**
 * ctx de leitura para texto fora do corpo (comentário, nota, cabeçalho): as
 * âncoras e os registros dele são descartados, porque o que vale é o texto;
 * aviso de imagem ou caixa nessas partes não é emitido nesta versão.
 */
function ctxDescartavel() {
  return { paragrafoAtual: 0, registrar() {}, comentariosReferenciados: new Set(), notasReferenciadas: new Set() };
}

// texto que ficará aceito: segmentos excluídos fora, sem notação de marca
const textoAceito = (segs) => segs.filter((s) => s.marca !== "del").map((s) => s.texto).join("");

/**
 * Texto corrido de um contêiner (comentário, nota, cabeçalho): parágrafos
 * unidos por "\n", tabela uma linha por "\n" com células por " | " (cabeçalho
 * de contrato costuma ser tabela de logo + texto; ler só w:p o perderia).
 * Texto excluído por marca de revisão fica de fora: aqui não há notação de
 * marca, e o que se quer é o texto que ficará aceito.
 */
function textoDoConteudo(no) {
  const ctx = ctxDescartavel();
  const partes = [];
  for (const f of filhosDesembrulhados(no)) {
    if (f.localName === "p") {
      partes.push(textoAceito(segmentosDoParagrafo(f, ctx)));
    } else if (f.localName === "tbl") {
      for (const l of lerTabela(f, ctx, textoAceito).linhas) partes.push(l.filter(Boolean).join(" | "));
    }
  }
  return partes.join("\n").trim();
}

/** comments.xml na ordem do arquivo, só os comentários com âncora no corpo. */
function lerComentarios(doc, referenciados) {
  if (!doc) return [];
  const saida = [];
  for (const c of Array.from(doc.getElementsByTagNameNS(W_NS, "comment"))) {
    const id = attr(c, "id");
    if (!referenciados.has(id)) continue;
    saida.push({ id, autor: attr(c, "author") ?? "", data: attr(c, "date") ?? "", texto: textoDoConteudo(c) });
  }
  return saida;
}

/** footnotes.xml na ordem do arquivo, sem separadores e só as referenciadas no corpo. */
function lerNotas(doc, referenciadas) {
  if (!doc) return [];
  const saida = [];
  for (const n of Array.from(doc.getElementsByTagNameNS(W_NS, "footnote"))) {
    const tipo = attr(n, "type");
    if (tipo === "separator" || tipo === "continuationSeparator" || tipo === "continuationNotice") continue;
    const id = attr(n, "id");
    if (!referenciadas.has(id)) continue;
    saida.push({ id, texto: textoDoConteudo(n) });
  }
  return saida;
}

/**
 * word/header*.xml e word/footer*.xml ordenados pelo nome da parte (prefixo,
 * depois número: header2 antes de header10), para a saída ser determinística.
 */
function partesCabecalhoRodape(zip) {
  const chave = (nome) => {
    const m = /^word\/(header|footer)(\d*)\.xml$/.exec(nome);
    return m ? [m[1], m[2] === "" ? 0 : Number(m[2])] : null;
  };
  return Object.keys(zip)
    .filter((nome) => chave(nome))
    .sort((a, b) => {
      const [pa, na] = chave(a);
      const [pb, nb] = chave(b);
      return pa === pb ? na - nb : pa < pb ? -1 : 1;
    });
}

export function abrirPacote(buffer) {
  const zip = unzipSync(new Uint8Array(buffer));
  const parte = (nome) => (zip[nome] ? parseXml(zip[nome]) : null);
  return { zip, parte };
}

export function lerDocx(buffer) {
  const saida = { blocos: [], comentarios: [], notas: [], cabecalhoRodape: [], avisos: [], temNumeracao: false, niveisNumeracao: 0 };
  let docXml, numeracao, estilos, comentariosXml, notasXml, cabecalhos;
  try {
    // O parse das partes fica dentro do try: XML malformado num zip íntegro
    // também é arquivo corrompido, e deve virar aviso, não exceção.
    const pacote = abrirPacote(buffer);
    if (!pacote.zip["word/document.xml"]) throw new Error("sem word/document.xml");
    docXml = pacote.parte("word/document.xml");
    numeracao = carregarNumeracao(pacote.parte("word/numbering.xml"));
    estilos = carregarEstilos(pacote.parte("word/styles.xml"));
    comentariosXml = pacote.parte("word/comments.xml");
    notasXml = pacote.parte("word/footnotes.xml");
    cabecalhos = partesCabecalhoRodape(pacote.zip).map((nome) => pacote.parte(nome));
  } catch (err) {
    saida.avisos.push(`não foi possível abrir o .docx (${err.message}); arquivo protegido ou corrompido`);
    return saida;
  }
  const numerador = criarNumerador(numeracao);
  const registros = {};
  const ctx = {
    paragrafoAtual: 0,
    registrar(tipo, paragrafo) {
      (registros[tipo] ??= []).push(paragrafo);
    },
    comentariosReferenciados: new Set(),
    notasReferenciadas: new Set(),
  };
  const body = docXml.getElementsByTagNameNS(W_NS, "body")[0];
  saida.blocos = body ? lerCorpo(body, ctx, numerador, estilos) : [];
  const numerados = saida.blocos.filter((b) => b.tipo === "paragrafo" && b.numero);
  saida.temNumeracao = numerados.length > 0;
  // níveis = profundidades distintas de fato usadas no documento, não as que
  // o numbering.xml define (o Word define 9 níveis em toda lista)
  saida.niveisNumeracao = new Set(numerados.map((b) => b.ilvl)).size;
  saida.comentarios = lerComentarios(comentariosXml, ctx.comentariosReferenciados);
  saida.notas = lerNotas(notasXml, ctx.notasReferenciadas);
  for (const doc of cabecalhos) {
    const raiz = doc.documentElement;
    const texto = raiz ? textoDoConteudo(raiz) : "";
    if (texto) saida.cabecalhoRodape.push(texto);
  }
  saida.avisos.push(...avisosDosRegistros(registros));
  return saida;
}
