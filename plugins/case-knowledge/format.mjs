/**
 * Funcoes puras de formatacao de output das tools MCP case-knowledge.
 *
 * Motivacao: chunks pos-refactor do chunker (16/05/2026) tem p50 ~1200
 * tokens. A tool `search` com limit=10 estourava o limite de 25k tokens
 * de output de tool MCP do Claude Code. Preview por default + cap global.
 */

const SUFFIX = " […]";
/** Maximo de chars que aceitamos recuar procurando fronteira de palavra. */
const WORD_BOUNDARY_LOOKBACK = 80;

/**
 * Trunca `content` em ate `maxChars`, recuando ate a ultima fronteira de
 * palavra (espaco) se houver uma a menos de WORD_BOUNDARY_LOOKBACK chars
 * do corte. maxChars <= 0, NaN ou nao-finito desativa o truncamento.
 */
export function truncateContent(content, maxChars) {
  if (
    typeof content !== "string" ||
    !Number.isFinite(maxChars) ||
    maxChars <= 0 ||
    content.length <= maxChars
  ) {
    return { text: content, truncated: false };
  }
  let cut = content.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  // lastSpace > 0 evita slice negativo (sem espaco) ou vazio (espaco no idx 0)
  if (lastSpace > 0 && lastSpace >= maxChars - WORD_BOUNDARY_LOOKBACK) {
    cut = cut.slice(0, lastSpace);
  }
  return { text: cut + SUFFIX, truncated: true };
}

/**
 * Retorna uma copia do result com content truncado + content_len e
 * content_truncated. Se nada foi truncado, retorna o MESMO objeto.
 */
export function previewResult(result, contentChars) {
  if (!result || typeof result.content !== "string") return result;
  const { text, truncated } = truncateContent(result.content, contentChars);
  if (!truncated) return result;
  return {
    ...result,
    content: text,
    content_len: result.content.length,
    content_truncated: true,
  };
}

/**
 * Renderiza array de objetos como JSON valido com 1 objeto por linha
 * (sem indentacao interna). Denso em tokens, legivel por linha.
 */
export function renderLines(items) {
  if (!items || items.length === 0) return "[]";
  return "[\n" + items.map((i) => JSON.stringify(i)).join(",\n") + "\n]";
}

/** Degraus de preview usados pelo cap global (alavanca 1). */
const DEGRADE_STEPS = [600, 300, 200];

/**
 * Monta o payload final respeitando um cap global de chars.
 *
 * - `lists`: arrays de results normalizados (1 lista no single/contexto,
 *   N listas no batch — uma por query — ou no agrupar — uma por grupo).
 * - `render(processedLists)`: reconstroi o texto final no shape original.
 * - `contentChars`: preview por result (0 = integra, nunca trunca content).
 * - `globalCap`: teto de chars do texto final (~60k chars, ~19k tokens).
 *
 * Degrade em duas alavancas, nesta ordem:
 *   1. preview menor (1200 -> 600 -> 300 -> 200) — pulada se contentChars=0;
 *   2. corta a cauda de CADA lista por halving (10 -> 5 -> 2 -> 1).
 *
 * Retorna { text, degraded } onde degraded e null quando o request foi
 * honrado tal qual pedido, ou { content_chars, kept } descrevendo o que
 * foi reduzido. Se nem o minimo couber, retorna o menor texto produzido
 * (melhor esforco — nunca lanca).
 */
export function buildCappedPayload({ lists, render, contentChars = 1200, globalCap = 60000 }) {
  const previewSteps = contentChars > 0
    ? [contentChars, ...DEGRADE_STEPS.filter((s) => s < contentChars)]
    : [0];

  const attempt = (cc, keep) =>
    render(
      lists.map((l) => {
        const sliced = keep === null ? l : l.slice(0, keep);
        return cc > 0 ? sliced.map((r) => previewResult(r, cc)) : sliced;
      })
    );

  // Passos de corte de cauda: null (todas) + halving do tamanho da maior lista.
  const maxLen = Math.max(0, ...lists.map((l) => l.length));
  const keepSteps = [null];
  for (let k = Math.floor(maxLen / 2); k >= 1; k = Math.floor(k / 2)) {
    keepSteps.push(k);
    if (k === 1) break;
  }

  let last = null;
  for (const keep of keepSteps) {
    // Com todas as listas inteiras, percorre os degraus de preview;
    // depois de comecar a cortar cauda, fixa no menor preview permitido.
    const ccSteps = keep === null ? previewSteps : [previewSteps.at(-1)];
    for (const cc of ccSteps) {
      const text = attempt(cc, keep);
      const honored = cc === previewSteps[0] && keep === null;
      last = { text, degraded: honored ? null : { content_chars: cc, kept: keep } };
      if (text.length <= globalCap) return last;
    }
  }
  return last;
}

/**
 * Renderiza os chunks de um documento INTEIRO em ordem sequencial
 * (tool `document`). Conteudo integral, nunca preview — leitura de peca
 * completa e a razao de existir da tool. Quando o documento nao cabe no
 * cap, entrega o prefixo que coube e informa `next_from` para o caller
 * continuar na proxima chamada (fatiamento sequencial, nunca amostra).
 */
export function renderDocumentChunks(chunks, { fromChunk = 0, globalCap = 60000 } = {}) {
  const OVERHEAD_PER_CHUNK = 40; // separadores "--- chunk N ---"
  const ordered = [...(chunks || [])].sort(
    (a, b) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0)
  );
  const total = ordered.length;
  const eligible = ordered.filter((c) => (c.chunk_index ?? 0) >= fromChunk);
  const kept = [];
  let size = 0;
  for (const c of eligible) {
    const s = (c.content?.length || 0) + OVERHEAD_PER_CHUNK;
    // O primeiro chunk entra mesmo acima do cap (nunca entregar zero por
    // causa de um chunk grande; max real de chunk ~32k chars < cap).
    if (kept.length > 0 && size + s > globalCap) break;
    kept.push(c);
    size += s;
  }
  const truncated = kept.length < eligible.length;
  return {
    text: kept
      .map((c) => `--- chunk ${c.chunk_index} ---\n${c.content ?? ""}`)
      .join("\n\n"),
    total,
    delivered: kept.length,
    delivered_from: kept.length > 0 ? kept[0].chunk_index : null,
    delivered_to: kept.length > 0 ? kept[kept.length - 1].chunk_index : null,
    truncated,
    next_from: truncated ? eligible[kept.length].chunk_index : null,
  };
}

/**
 * Reduz a janela da tool `contexto` quando o total estoura o cap: remove
 * chunks das extremidades (sempre o mais DISTANTE do central primeiro).
 * O chunk central nunca e removido nem truncado — a leitura na integra
 * e a razao de existir da tool (citacao exige texto completo).
 */
export function capContextChunks(chunks, centralIndex, globalCap = 60000) {
  const OVERHEAD_PER_CHUNK = 40; // separadores "--- chunk N ---"
  const size = (cs) => cs.reduce((a, c) => a + (c.content?.length || 0) + OVERHEAD_PER_CHUNK, 0);
  const kept = [...chunks];
  while (kept.length > 1 && size(kept) > globalCap) {
    const dFirst = Math.abs(kept[0].chunk_index - centralIndex);
    const dLast = Math.abs(kept[kept.length - 1].chunk_index - centralIndex);
    if (dFirst >= dLast) kept.shift();
    else kept.pop();
  }
  return { chunks: kept, reduced: kept.length < chunks.length };
}

/* ===========================================================================
 * Task 3 (CMR-140): renderReconstrucao — markdown do advogado.
 *
 * Funcao PURA que renderiza o ReconstruirResponse (rota Rust
 * POST /cases/{name}/reconstruir) em markdown legivel para o advogado.
 *
 * Invariantes duras:
 *  - NUNCA parafraseia nem trunca content de chunk no meio. O degrade corta
 *    faixas/documentos/vizinhos INTEIROS; todo chunk presente sai com content
 *    completo.
 *  - Toda omissao vira elipse explicita: fls quando as duas bordas sao
 *    conhecidas (`[... fls. X-Y omitidas ...]`, singular "omitida" para 1
 *    pagina); senao contagem de trechos (`[... N trechos omitidos ...]`).
 *    NUNCA inventa fls.
 *  - Datas por SPLIT DE STRING ("YYYY-MM-DD" -> "DD/MM/AAAA"), nunca Date().
 *  - Marcacao de match e de copia externa em linha propria, fora do texto
 *    literal; sem score no corpo.
 *
 * Nota de design: os gaps sao RECOMPUTADOS client-side a partir de
 * chunk_index + total_chunks (nao dos campos gap_antes/gap_final do Rust),
 * pois o degrade client-side remove faixas e os campos do Rust ficariam
 * stale. Sem degrade os numeros coincidem com os do Rust.
 * =========================================================================== */

/** Data "YYYY-MM-DD" (ou com hora) -> "DD/MM/AAAA" por split de string. */
export function fmtData(d) {
  if (typeof d !== "string" || d.length < 10) return "data nao identificada";
  const parts = d.slice(0, 10).split("-");
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return "data nao identificada";
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

/** Faixa de folhas. null quando ambas as paginas sao desconhecidas. */
export function fmtFls(ps, pe) {
  if (ps == null && pe == null) return null;
  const lo = ps == null ? pe : ps;
  const hi = pe == null ? ps : pe;
  return lo === hi ? `${lo}` : `${lo}-${hi}`;
}

/** Contagem de gap normalizada para inteiro >= 0. */
export function clampGap(n) {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Elipse de omissao. Usa fls quando ambas as bordas (`pDe`/`pAte`) sao
 * conhecidas e formam faixa valida (pDe <= pAte); senao cai para contagem
 * de trechos. NUNCA inventa fls.
 */
export function ellipsis(count, pDe, pAte) {
  if (pDe != null && pAte != null && pDe <= pAte) {
    const range = pDe === pAte ? `${pDe}` : `${pDe}-${pAte}`;
    const noun = pDe === pAte ? "omitida" : "omitidas";
    return `[... fls. ${range} ${noun} ...]`;
  }
  const n = clampGap(count);
  return `[... ${n} trecho${n === 1 ? "" : "s"} omitido${n === 1 ? "" : "s"} ...]`;
}

/** Ordena por chunk_index e remove indices repetidos (mantem o primeiro). */
function dedupeSortChunks(chunks) {
  const seen = new Set();
  const out = [];
  for (const c of [...(chunks || [])].sort((a, b) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0))) {
    const k = c.chunk_index ?? 0;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/** Relevancia de uma faixa = maior score entre seus chunks (0 se ausente). */
function faixaRelevance(faixa) {
  return (faixa.chunks || []).reduce(
    (m, c) => Math.max(m, typeof c.score === "number" ? c.score : 0),
    0
  );
}

/** Modelo de trabalho por documento (mutavel ao longo do degrade). */
function buildDocState(response) {
  return (response.documentos || []).map((doc) => {
    const allChunks = (doc.faixas || []).flatMap((f) => f.chunks || []);
    let ps = null;
    let pe = null;
    for (const c of allChunks) {
      if (c.page_start != null) ps = ps == null ? c.page_start : Math.min(ps, c.page_start);
      if (c.page_end != null) pe = pe == null ? c.page_end : Math.max(pe, c.page_end);
    }
    return {
      doc,
      headerPs: ps,
      headerPe: pe,
      total_chunks: typeof doc.total_chunks === "number" ? doc.total_chunks : allChunks.length,
      faixas: (doc.faixas || []).map((f) => ({ chunks: f.chunks || [], relevance: faixaRelevance(f) })),
      relevance:
        typeof doc.score_max === "number"
          ? doc.score_max
          : Math.max(0, ...(doc.faixas || []).map(faixaRelevance)),
    };
  });
}

/** Marcadores + content de um chunk (marcacao fora do texto literal). */
function renderChunk(c) {
  const lines = [];
  if (c.matched) {
    const fls = fmtFls(c.page_start, c.page_end);
    lines.push(fls ? `[trecho localizado pela busca — fls. ${fls}]` : "[trecho localizado pela busca]");
  }
  if (c.copia_externa) {
    lines.push("[copia reproduzida nos autos — nao integra a peca]");
  }
  lines.push(c.content ?? "");
  return lines.join("\n");
}

/** Corpo do documento: elipses de gap intercaladas com os chunks. */
function renderBody(state) {
  const chunks = dedupeSortChunks(state.faixas.flatMap((f) => f.chunks));
  if (chunks.length === 0) return "";
  const out = [];
  const first = chunks[0];
  const leadGap = clampGap((first.chunk_index ?? 0) - 0);
  if (leadGap > 0) {
    // Gap inicial: borda inferior por convencao = 1 (inicio do documento).
    out.push(ellipsis(leadGap, 1, first.page_start != null ? first.page_start - 1 : null));
  }
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    out.push(renderChunk(c));
    const next = chunks[i + 1];
    if (next) {
      const gap = clampGap((next.chunk_index ?? 0) - (c.chunk_index ?? 0) - 1);
      if (gap > 0) {
        const pDe = c.page_end != null ? c.page_end + 1 : null;
        const pAte = next.page_start != null ? next.page_start - 1 : null;
        out.push(ellipsis(gap, pDe, pAte));
      }
    }
  }
  const last = chunks[chunks.length - 1];
  const tailGap = clampGap(state.total_chunks - 1 - (last.chunk_index ?? 0));
  if (tailGap > 0) {
    // Gap final: borda superior desconhecida (nada depois) -> trecho count.
    out.push(ellipsis(tailGap, last.page_end != null ? last.page_end + 1 : null, null));
  }
  return out.join("\n\n");
}

/** Header + corpo de um documento (com contador quando multi-doc). */
function renderDoc(state, counterLine) {
  const parts = [];
  if (counterLine) parts.push(counterLine);
  const peca = state.doc.peca || "documento";
  const data = fmtData(state.doc.data_juntada);
  const fls = fmtFls(state.headerPs, state.headerPe);
  const segs = [`## ${peca}`, data];
  if (fls) segs.push(`fls. ${fls}`);
  segs.push("`" + state.doc.documento + "`");
  let header = segs.join(" — ");
  if (state.doc.numero_processo != null) header += `\nprocesso ${state.doc.numero_processo}`;
  parts.push(header);
  const body = renderBody(state);
  if (body !== "") parts.push(body);
  return parts.join("\n\n");
}

/**
 * Rodape de avisos. Duas fontes DISTINTAS:
 *  - rust-omit: documentos_no_recall - (documentos da resposta). Constante,
 *    independe do degrade client-side (evita dupla contagem).
 *  - degrade client-side: faixas e/ou documentos omitidos para caber no cap.
 */
function buildAvisos(response, faixasOmitidas, documentosOmitidos) {
  const avisos = [];
  const responseDocs = (response.documentos || []).length;
  const noRecall =
    typeof response.documentos_no_recall === "number" ? response.documentos_no_recall : responseDocs;
  const rustOmit = Math.max(0, noRecall - responseDocs);
  if (rustOmit > 0) {
    avisos.push(
      `[aviso: ${rustOmit} outro(s) documento(s) com trechos relevantes nao reconstruido(s) (limite max_documentos). Aumente max_documentos ou filtre por peca.]`
    );
  }
  if (faixasOmitidas > 0) {
    avisos.push(
      `[aviso: ${faixasOmitidas} faixa(s) menos relevante(s) omitida(s) do output para caber no limite de tokens.]`
    );
  }
  if (documentosOmitidos > 0) {
    avisos.push(
      `[aviso: ${documentosOmitidos} documento(s) menos relevante(s) omitido(s) do output para caber no limite de tokens.]`
    );
  }
  return avisos;
}

/** Monta o markdown final a partir do estado corrente de degrade. */
function assemble(response, docStates, faixasOmitidas, documentosOmitidos) {
  const rendered = docStates.length;
  const title = `# Reconstrucao: "${response.query ?? ""}"`;
  const meta = `modo ${response.modo ?? ""} · janela ${response.janela ?? ""} · ${rendered} documento(s)`;
  const blocks = docStates.map((s, i) =>
    renderDoc(s, rendered > 1 ? `Documento ${i + 1} de ${rendered}` : "")
  );
  let text = title + "\n" + meta + "\n\n" + blocks.join("\n\n---\n\n");
  const avisos = buildAvisos(response, faixasOmitidas, documentosOmitidos);
  if (avisos.length > 0) text += "\n\n---\n" + avisos.join("\n");
  return text;
}

/**
 * Renderiza o ReconstruirResponse em markdown, com degrade em cascata que
 * NUNCA parte um chunk. Assinatura: `renderReconstrucao(response, {globalCap})`.
 * Retorna `{ text, degraded }` — `degraded` null quando integro, senao
 * `{ documentos_omitidos, faixas_omitidas }`.
 *
 * Cascata (so quando o texto estoura globalCap):
 *   1. reduz faixas por doc (menos relevantes primeiro, mantendo >=1 por doc);
 *   2. reduz documentos (cauda menos relevante, mantendo >=1);
 *   3. best-effort: reduz as faixas remanescentes aos chunks matched. Entrega
 *      o melhor esforco mesmo acima do cap (nunca lanca).
 */
export function renderReconstrucao(response, { globalCap = 60000 } = {}) {
  const docsIn = (response && response.documentos) || [];
  if (docsIn.length === 0) {
    return { text: "Nenhum documento reconstruido para essa busca.", degraded: null };
  }

  const states = buildDocState(response);
  let faixasOmitidas = 0;
  let documentosOmitidos = 0;

  let text = assemble(response, states, faixasOmitidas, documentosOmitidos);
  if (text.length <= globalCap) return { text, degraded: null };

  // Lever 1: dropa a faixa globalmente menos relevante entre docs com >1 faixa
  // (garante >=1 faixa por doc — docs inteiros so caem no lever 2).
  const hasMultiFaixa = () => states.some((s) => s.faixas.length > 1);
  while (text.length > globalCap && hasMultiFaixa()) {
    let target = null; // { si, fi, relevance }
    states.forEach((s, si) => {
      if (s.faixas.length <= 1) return;
      s.faixas.forEach((f, fi) => {
        if (target === null || f.relevance < target.relevance) {
          target = { si, fi, relevance: f.relevance };
        }
      });
    });
    states[target.si].faixas.splice(target.fi, 1);
    faixasOmitidas++;
    text = assemble(response, states, faixasOmitidas, documentosOmitidos);
  }
  if (text.length <= globalCap) {
    return { text, degraded: { documentos_omitidos: documentosOmitidos, faixas_omitidas: faixasOmitidas } };
  }

  // Lever 2: dropa o documento menos relevante (empate: o mais ao fim), >=1.
  while (text.length > globalCap && states.length > 1) {
    let worst = 0;
    for (let i = 1; i < states.length; i++) {
      if (states[i].relevance <= states[worst].relevance) worst = i;
    }
    states.splice(worst, 1);
    documentosOmitidos++;
    text = assemble(response, states, faixasOmitidas, documentosOmitidos);
  }
  if (text.length <= globalCap) {
    return { text, degraded: { documentos_omitidos: documentosOmitidos, faixas_omitidas: faixasOmitidas } };
  }

  // Lever 3: best-effort — reduz as faixas remanescentes aos chunks matched.
  let neighborsDropped = 0;
  for (const s of states) {
    s.faixas = s.faixas.map((f) => {
      const matched = (f.chunks || []).filter((c) => c.matched);
      if (matched.length > 0 && matched.length < f.chunks.length) {
        neighborsDropped += f.chunks.length - matched.length;
        return { chunks: matched, relevance: f.relevance };
      }
      return f;
    });
  }
  text = assemble(response, states, faixasOmitidas, documentosOmitidos);
  const anyDegrade = faixasOmitidas > 0 || documentosOmitidos > 0 || neighborsDropped > 0;
  return {
    text,
    degraded: anyDegrade
      ? { documentos_omitidos: documentosOmitidos, faixas_omitidas: faixasOmitidas }
      : null,
  };
}
