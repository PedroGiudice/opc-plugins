/**
 * Leitor de .xlsx/.xlsm via exceljs -> {abas, avisos}. Valores saem já em
 * texto, determinísticos: número cru (sem formato de moeda), data em ISO UTC,
 * fórmula pelo valor em cache. Fórmula sem cache (planilha gerada por sistema
 * e nunca aberta no Excel) é aviso, nunca "[object Object]".
 */
import ExcelJS from "exceljs";

function dataIso(d) {
  const iso = d.toISOString(); // 2026-09-01T10:30:00.000Z
  // meia-noite UTC = célula só de data; com hora, mantém a hora (sem ms/Z)
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 19);
}

function textoDeValor(v, semCache) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : dataIso(v);
  switch (typeof v) {
    // 15 dígitos significativos, como o Excel exibe: o double 4899.44 gravado
    // como 4899.4400000000005 não pode virar ruído no texto. Vale também para
    // resultado de fórmula, que cai neste mesmo ramo.
    case "number": return Number.isFinite(v) ? String(Number(v.toPrecision(15))) : "";
    case "boolean": return v ? "VERDADEIRO" : "FALSO";
    case "string": return v;
    case "object":
      if (Array.isArray(v.richText)) return v.richText.map((r) => r.text ?? "").join("");
      if ("hyperlink" in v) return textoDeValor(v.text, semCache);
      if ("formula" in v || "sharedFormula" in v) {
        if (v.result === undefined || v.result === null) { semCache(); return ""; }
        return textoDeValor(v.result, semCache);
      }
      if ("error" in v) return String(v.error);
      if ("result" in v) return textoDeValor(v.result, semCache);
      return "";
    default: return String(v);
  }
}

// Valor bruto da célula. Para fórmula, `cell.value` passa por
// FormulaValue._copyModel do exceljs, que descarta resultado falsy: um cache
// 0 ou FALSO chegaria como "sem resultado" e viraria célula vazia com aviso
// falso. `cell.result` lê o modelo cru e preserva 0 e false. Limite conhecido
// e aceito: cache "" (`<v></v>`, ex.: IF(x;"";y)) ainda chega como undefined
// também pelo `cell.result`, então essas fórmulas seguem gerando o aviso.
function valorDaCelula(cell) {
  if (cell.type === ExcelJS.ValueType.Formula) return { formula: cell.formula ?? "", result: cell.result };
  return cell.value;
}

// Uma linha da aba em texto. `conteudo[c]` é true quando a célula tem texto OU
// é fórmula sem cache: esta última não tem texto, mas é informação que o aviso
// precisa reportar, então não pode ser aparada como se fosse vazia.
function lerLinha(ws, r, colunas) {
  const row = ws.getRow(r);
  const cels = [];
  const conteudo = [];
  const semCache = [];
  for (let c = 1; c <= colunas; c++) {
    const cell = row.getCell(c);
    let sem = false;
    // célula mesclada que não é a mestre: o exceljs devolve o valor da mestre; queremos vazio
    const escrava = cell.isMerged && cell.master.address !== cell.address;
    const t = escrava ? "" : textoDeValor(valorDaCelula(cell), () => { sem = true; });
    cels.push(t);
    conteudo.push(t !== "" || sem);
    if (sem) semCache.push(cell.address);
  }
  return { cels, conteudo, semCache };
}

export async function lerXlsx(buffer, { maxLinhasPorAba = 2000 } = {}) {
  const saida = { abas: [], avisos: [] };
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (err) {
    saida.avisos.push(`não foi possível abrir a planilha (${err.message}); arquivo protegido ou corrompido`);
    return saida;
  }
  const ocultas = [];
  wb.eachSheet((ws) => {
    const oculta = ws.state !== "visible";
    const aba = { nome: ws.name, oculta, linhas: [], cortadas: 0 };
    saida.abas.push(aba);
    if (oculta) { ocultas.push(ws.name); return; }

    // rowCount/columnCount do exceljs incluem linhas e colunas só com estilo
    // ou valor vazio; o intervalo realmente usado se descobre pelo conteúdo.
    const colunasBrutas = ws.columnCount || 0;
    let ultima = ws.rowCount || 0;
    // Apara só o FIM (linhas do meio são layout, e layout é informação).
    // A varredura de trás para frente custa só as linhas finais vazias.
    while (ultima > 0 && !lerLinha(ws, ultima, colunasBrutas).conteudo.some(Boolean)) ultima--;

    const emitidas = Math.min(ultima, maxLinhasPorAba);
    aba.cortadas = ultima - emitidas;
    const lidas = [];
    let colunas = 0;
    for (let r = 1; r <= emitidas; r++) {
      const l = lerLinha(ws, r, colunasBrutas);
      lidas.push(l);
      for (let c = colunasBrutas; c > colunas; c--) {
        if (l.conteudo[c - 1]) { colunas = c; break; }
      }
    }
    const semCache = [];
    for (const l of lidas) {
      aba.linhas.push(l.cels.slice(0, colunas));
      semCache.push(...l.semCache);
    }

    if (semCache.length) {
      const mostra = semCache.slice(0, 5).join(", ") + (semCache.length > 5 ? ", ..." : "");
      saida.avisos.push(`${ws.name}: ${semCache.length} fórmula${semCache.length > 1 ? "s" : ""} sem valor em cache (${mostra}); abra e salve no Excel para preencher`);
    }
    if (aba.cortadas) saida.avisos.push(`${ws.name}: ${aba.cortadas} linhas além do teto de ${maxLinhasPorAba} ficaram de fora`);
  });
  for (const n of ocultas) saida.avisos.push(`aba oculta não renderizada: ${n}`);
  return saida;
}
