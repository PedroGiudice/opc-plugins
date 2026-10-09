/**
 * Funcoes puras de formatacao de output das tools MCP case-knowledge.
 *
 * Motivacao: chunks pos-refactor do chunker (16/05/2026) tem p50 ~1200
 * tokens. A tool `search` com limit=10 estourava o limite de 25k tokens
 * de output de tool MCP do Claude Code. Preview por default + cap global.
 */

/**
 * Teto de chars do texto devolvido pelas tools de retrieval.
 *
 * O Claude Code grava em arquivo (e entrega ao modelo so o caminho) todo
 * resultado de texto acima de 50.000 caracteres OU de 25.000 tokens. No
 * tokenizador da familia Claude 5 o texto de OCR rende 2,14 chars/token na
 * mediana do parque, mas o enchimento de formulario datilografado
 * ("x.x.x.x.") e os separadores de e-mail ("~::~:") rendem ~1 char/token:
 * a pior janela real de leitura medida (09/10/2026) teve 24.245 chars e
 * 23.899 tokens. Com 20.000 chars o pior caso fica em ~19,8k tokens (20%
 * abaixo do limite) e o texto tipico em ~9,3k. Teto em tokens estimados foi
 * descartado: nem regressao por classe de caractere nem estimador pessimista
 * simples acompanharam o tokenizador (erro de ate 40% para menos).
 */
export const OUTPUT_CAP_CHARS = 20_000;

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
 * - `globalCap`: teto de chars do texto final (default OUTPUT_CAP_CHARS).
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
export function buildCappedPayload({ lists, render, contentChars = 1200, globalCap = OUTPUT_CAP_CHARS }) {
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
 * Aviso que antecede o texto quando o buildCappedPayload reduziu o pedido.
 * `degraded.content_chars` e o preview FINAL; so conta como "reduzido" se
 * ficou abaixo do que o caller pediu (com requested <= 200 nao ha degrau).
 */
export function degradeNotice(degraded, requestedChars) {
  if (!degraded) return "";
  const parts = [];
  if (degraded.content_chars > 0 && degraded.content_chars < requestedChars) {
    parts.push(`preview reduzido para ${degraded.content_chars} chars`);
  }
  if (degraded.kept !== null) parts.push(`resultados cortados para top ${degraded.kept} por lista`);
  return `[aviso: output excederia o limite de tokens — ${parts.join("; ")}. ` +
    `Refine com filtros, limit menor ou leia chunks especificos via contexto.]\n\n`;
}

/** Folga para os avisos no topo: o texto inteiro, avisos inclusos, fica no teto. */
const RESERVA_AVISO = 400;

/**
 * Saida das buscas que devolvem hits do caso fora do `search`
 * (buscar_cronologico, buscar_interseccao, buscar_diversificado e recommend em
 * lote): mesmo formato e mesmo teto do search, uma linha JSON por hit com o
 * content em preview. Antes essas tools devolviam o JSON da API com o content
 * INTEGRAL de cada chunk: 10 resultados passavam de 47 mil caracteres e o
 * Claude Code gravava o resultado em arquivo.
 *
 * `listas`: [{ cabecalho?, hits }], uma por grupo/consulta (o cabecalho vira
 * `=== cabecalho ===`); sem cabecalho, uma lista simples. A ordem dos hits e a
 * da API (cronologica, de score) e o degrade corta sempre a cauda.
 *
 * Alem das duas alavancas do buildCappedPayload, uma terceira: se nem o preview
 * minimo com 1 hit por lista couber (muitos grupos de 1 hit, que nao tem cauda
 * para cortar), omite listas inteiras do fim, mantendo >=1, com aviso. Um hit
 * sozinho acima do teto (content_chars 0) sai assim mesmo: nunca parte chunk.
 */
export function renderHitsComTeto(listas, { contentChars = 1200, globalCap = OUTPUT_CAP_CHARS, rotuloLista = "lista(s)" } = {}) {
  const limite = globalCap - RESERVA_AVISO;
  const montar = (ls) =>
    buildCappedPayload({
      lists: ls.map((l) => l.hits || []),
      render: (pls) =>
        ls.map((l, i) => (l.cabecalho ? `=== ${l.cabecalho} ===\n` : "") + renderLines(pls[i])).join("\n\n"),
      contentChars,
      globalCap: limite,
    });
  let n = listas.length;
  let out = montar(listas);
  while (out.text.length > limite && n > 1) {
    n--;
    out = montar(listas.slice(0, n));
  }
  const omitidas = listas.length - n;
  const avisoListas = omitidas > 0
    ? `[aviso: ${omitidas} ${rotuloLista} do fim omitido(s) para caber no limite de output. ` +
      `Refine com menos grupos ou filtros.]\n\n`
    : "";
  return avisoListas + degradeNotice(out.degraded, contentChars) + out.text;
}

/**
 * Renderiza os chunks de um documento INTEIRO em ordem sequencial
 * (tool `document`). Conteudo integral, nunca preview — leitura de peca
 * completa e a razao de existir da tool. Quando o documento nao cabe no
 * cap, entrega o prefixo que coube e informa `next_from` para o caller
 * continuar na proxima chamada (fatiamento sequencial, nunca amostra).
 */
export function renderDocumentChunks(chunks, { fromChunk = 0, globalCap = OUTPUT_CAP_CHARS } = {}) {
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
    // causa de um chunk grande; o maior chunk do parque, 41k chars e ~15k
    // tokens, fica abaixo dos dois limites do Claude Code).
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
export function capContextChunks(chunks, centralIndex, globalCap = OUTPUT_CAP_CHARS) {
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
function buildAvisos(response, faixasOmitidas, documentosOmitidos, trechosOmitidos = 0) {
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
  if (trechosOmitidos > 0) {
    avisos.push(
      `[aviso: ${trechosOmitidos} trecho(s) localizado(s) menos relevante(s) omitido(s) do output para caber no limite de tokens. Leia o documento inteiro via document.]`
    );
  }
  return avisos;
}

/** Monta o markdown final a partir do estado corrente de degrade. */
function assemble(response, docStates, faixasOmitidas, documentosOmitidos, trechosOmitidos = 0) {
  const rendered = docStates.length;
  const title = `# Reconstrucao: "${response.query ?? ""}"`;
  const meta = `modo ${response.modo ?? ""} · janela ${response.janela ?? ""} · ${rendered} documento(s)`;
  const blocks = docStates.map((s, i) =>
    renderDoc(s, rendered > 1 ? `Documento ${i + 1} de ${rendered}` : "")
  );
  let text = title + "\n" + meta + "\n\n" + blocks.join("\n\n---\n\n");
  const avisos = buildAvisos(response, faixasOmitidas, documentosOmitidos, trechosOmitidos);
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
 *   3. reduz as faixas remanescentes aos chunks matched;
 *   4. tira os chunks matched de menor score, mantendo >=1 (a elipse do
 *      buraco sai do proprio renderBody). Um chunk sozinho acima do cap e
 *      entregue assim mesmo (melhor esforco, nunca lanca).
 */
export function renderReconstrucao(response, { globalCap = OUTPUT_CAP_CHARS } = {}) {
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

  // Lever 4: tira o chunk de menor score (empate: o mais ao fim), >=1 no total.
  let trechosOmitidos = 0;
  const restantes = () => states.reduce((n, s) => n + s.faixas.reduce((m, f) => m + f.chunks.length, 0), 0);
  while (text.length > globalCap && restantes() > 1) {
    let alvo = null; // { s, f, ci, score }
    for (const s of states) {
      for (const f of s.faixas) {
        f.chunks.forEach((c, ci) => {
          const score = typeof c.score === "number" ? c.score : 0;
          if (alvo === null || score <= alvo.score) alvo = { s, f, ci, score };
        });
      }
    }
    alvo.f.chunks = alvo.f.chunks.filter((_, i) => i !== alvo.ci);
    alvo.s.faixas = alvo.s.faixas.filter((f) => f.chunks.length > 0);
    trechosOmitidos++;
    text = assemble(response, states, faixasOmitidas, documentosOmitidos, trechosOmitidos);
  }

  const anyDegrade = faixasOmitidas > 0 || documentosOmitidos > 0 || neighborsDropped > 0 || trechosOmitidos > 0;
  return {
    text,
    degraded: anyDegrade
      ? { documentos_omitidos: documentosOmitidos, faixas_omitidas: faixasOmitidas, trechos_omitidos: trechosOmitidos }
      : null,
  };
}

// === CMR-146: caso "casca" (existe no tenant, sem base embedada) ===

/**
 * Rotas da API que leem a collection Qdrant do caso — as unicas em que
 * "caso nao encontrado" pode significar collection ausente.
 *
 * O gate de pertinencia (caso fora do tenant) vive nas rotas de FILESYSTEM
 * (`/metadata`, `/briefing`, `/memoria`, `/workdocs`) e devolve uma mensagem
 * BYTE-IDENTICA a do 404 de collection. Como o body nao distingue os dois, a
 * rota e o unico sinal: so o que esta nesta allowlist pode virar "sem base".
 */
const ROTAS_DE_COLLECTION = /\/cases\/[^/]+\/(search|stats|contexto|reconstruir|document(\/|$))/;

/**
 * Espelha `is_collection_not_found` da API Rust (api.rs): mensagem crua do
 * qdrant-client para collection inexistente. Usado no caminho 500, porque
 * stats/document/contexto NAO mapeiam esse erro para 404 do lado servidor.
 */
function mensagemDeCollectionAusente(msg) {
  const m = msg.toLowerCase();
  return (
    m.includes("collection") &&
    (m.includes("doesn't exist") ||
      m.includes("does not exist") ||
      m.includes("not found") ||
      m.includes("notfound"))
  );
}

/** Neutraliza metacaracteres para interpolar texto literal em RegExp. */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Nome do caso embutido no path da API (`/cases/<nome>/...`), ou `null`.
 * O nome vai cru no path (o server.mjs interpola `CASE.name` sem encodar),
 * mas segmentos de path podem chegar percent-encoded; `decodeURIComponent`
 * lanca em `%` solto, entao o nome cru e o fallback.
 */
function casoDoPath(path) {
  const m = /\/cases\/([^/]+)\//.exec(path);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** Extrai o texto do erro de um body que pode vir como objeto, JSON cru ou texto. */
function textoDoErro(body) {
  if (body == null) return null;
  if (typeof body === "object") {
    return typeof body.error === "string" ? body.error : null;
  }
  if (typeof body !== "string") return null;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    // Nao e JSON: cai no texto cru (ex.: erro de proxy/gateway).
  }
  return body;
}

/**
 * `true` quando a resposta da API significa "a collection Qdrant deste caso
 * nao existe" — o caso e uma casca (criado no app sem extracao) ou ainda nao
 * foi ingerido. Pura: decide so por (status, body, path).
 *
 * Dois shapes reais, porque a API Rust nao e uniforme:
 *   - 404 `{"error":"not found: caso <nome> nao encontrado"}` — search,
 *     reconstruir (ambos os ramos), info e facet passam pelo
 *     `is_collection_not_found` e viram 404 anti-enumeracao.
 *   - 5xx `{"error":"Collection \`...\` doesn't exist!"}` — stats, document e
 *     contexto NAO tem esse mapeamento e deixam o erro cru do Qdrant virar 500.
 *
 * Falsos positivos barrados de proposito: 404 de documento inexistente
 * (collection existe), 404 do gate de pertinencia (rota fora da allowlist),
 * 500 de indice faltando e erros de conexao.
 */
export function detectaCollectionAusente(status, body, path) {
  if (typeof path !== "string" || !ROTAS_DE_COLLECTION.test(path)) return false;
  const msg = textoDoErro(body);
  if (!msg) return false;

  if (status === 404) {
    // Casa a mensagem INTEIRA contra o nome do caso extraido do path. Um
    // `.+` no lugar do nome atravessaria nome de documento que contenha a
    // palavra "caso" (ex.: "documento 'caso 123 - contrato.pdf' nao
    // encontrado") e mentiria "sem base embedada" sobre autos que existem.
    const caso = casoDoPath(path);
    if (!caso) return false; // fail-safe: erro cru e melhor que mentira.
    const esperado = new RegExp(
      `^not found: caso ${escapeRegex(caso)} nao encontrado$`,
      "i"
    );
    return esperado.test(msg.trim());
  }
  if (status >= 500) return mensagemDeCollectionAusente(msg);
  return false;
}

/**
 * Texto entregue pelas tools de busca quando o caso nao tem base embedada.
 * Nao e erro: e o estado honesto de uma casca. Diz o que ainda funciona
 * (memoria de sessao, workdocs) e como sair do estado (subir os autos pelo app).
 */
export function renderCaseSemBase(caseName) {
  return (
    `Caso sem base embedada (${caseName}) — os autos deste caso não foram ` +
    `extraídos/indexados. Memória de sessão e workdocs funcionam normalmente. ` +
    `A busca fica disponível se os autos subirem pelo app (mesmo caso).`
  );
}

// === Manifesto em arvore (spec 2026-08-17: segmento como unidade de acesso) ===

const PESO_EXPEDIENTE = "expediente";

/**
 * Data do manifesto como "YYYY-MM-DD".
 *
 * O YAML traz a data como timestamp, e o js-yaml a materializa como `Date`:
 * `String(date).slice(0,10)` daria "Thu Jul 03". Por isso o caso `Date` e
 * tratado a parte.
 */
function dataISO(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }
  return String(v).slice(0, 10);
}

/**
 * Marca de copia externa: o segmento nao e peca DESTES autos, e reproducao de
 * outra acao juntada como documento.
 *
 * Estruturalmente uma copia dessas aparece igual a uma peca (uma "inicial"
 * pendurada na contestacao, por exemplo), e quem le rapido pode cita-la como
 * se fosse dos autos — citar peca de outra acao numa peticao e erro material.
 * O manifesto ja distingue: `chunks_copia` conta o conteudo marcado como copia
 * externa; `chunks_peca`, o proprio. A marca sai em qualquer nivel — copia sem
 * ato anterior no arquivo fica no nivel 1, sem pai.
 */
function marcaCopiaExterna(d) {
  const copia = Number(d.chunks_copia ?? 0);
  if (!(copia > 0)) return "";
  const proprio = Number(d.chunks_peca ?? 0);
  return proprio > 0 ? " (contem copia de outra acao)" : " (copia de outra acao)";
}

/** Uma linha do manifesto. `indent > 0` marca anexo pendurado no ato acima. */
function linhaDoc(d, indent) {
  const pad = " ".repeat(indent);
  const marca = indent > 0 ? "└ " : "";
  const fls = Array.isArray(d.fls) ? `fls. ${d.fls[0]}-${d.fls[1]}` : "";
  const sub = d.subtipo ? `/${d.subtipo}` : "";
  const tit = d.titulo ? `  "${d.titulo}"` : "";
  const data = d.data_juntada ? `  ${dataISO(d.data_juntada)}` : "";
  // Segmento sem chunk proprio (CMR-205): existe na cronologia, texto se le
  // pelo arquivo. O marcador substitui a contagem para ninguem ler "0 chunks"
  // como "documento vazio".
  const chunks = d.sem_texto_indexado
    ? "  [sem texto indexado]"
    : d.chunks != null
      ? `  [${d.chunks} ${Number(d.chunks) === 1 ? "chunk" : "chunks"}]`
      : "";
  // O id e o endereco de leitura do segmento (tool document, parametro
  // `segmento`). Sem segmentacao, o endereco continua sendo o arquivo.
  const id = d.segmento_id ? `  <${d.segmento_id}>` : "";
  const nome = d.segmento_id ? `${d.peca ?? "?"}${sub}` : (d.nome ?? "?");
  // A marca de copia vem grudada na classe: e a primeira coisa lida na linha.
  return `${pad}${marca}${nome}${marcaCopiaExterna(d)}  ${fls}${data}${tit}${chunks}${id}`.trimEnd();
}

/** Linha agregada de uma corrida de expediente colapsado. */
function linhaExpediente(itens) {
  const cont = {};
  for (const e of itens) {
    const k = e.peca ?? "?";
    cont[k] = (cont[k] ?? 0) + 1;
  }
  return `[+ expediente: ${Object.entries(cont).map(([p, n]) => `${n} ${p}`).join(", ")}]`;
}

/**
 * Unidades de leitura do manifesto a partir da entrada `inicio` (0-based): um
 * ato com os seus anexos, ou uma corrida de expediente colapsado (uma linha so).
 * `de`/`ate` sao as entradas do nivel 1 cobertas (1-based); `itens`, os
 * segmentos listados, na ordem. A unidade e o atomo da paginacao: ato e anexo
 * nunca caem em partes diferentes.
 */
function unidadesDoManifesto(docs, expandir, inicio) {
  const unidades = [];
  let corrida = null;
  const fechar = () => {
    if (!corrida) return;
    unidades.push({ ...corrida, linhas: [linhaExpediente(corrida.itens)] });
    corrida = null;
  };
  for (let i = inicio; i < docs.length; i++) {
    const d = docs[i];
    if (d.peso === PESO_EXPEDIENTE && !expandir) {
      if (!corrida) corrida = { de: i + 1, ate: i + 1, itens: [] };
      corrida.ate = i + 1;
      corrida.itens.push(d);
      continue;
    }
    fechar();
    const anexos = d.anexos ?? [];
    unidades.push({
      de: i + 1,
      ate: i + 1,
      linhas: [linhaDoc(d, 0), ...anexos.map((a) => linhaDoc(a, 2))],
      itens: [d, ...anexos],
    });
  }
  fechar();
  return unidades;
}

/** Tamanho das linhas de uma unidade no texto (cada linha leva um "\n"). */
const tamanhoUnidade = (u) => u.linhas.reduce((n, l) => n + l.length + 1, 0);

/** Prefixo de `unidades` que cabe em `orcamento` chars; sempre >= 1 unidade. */
function quantasCabem(unidades, orcamento) {
  let n = 0;
  let total = 0;
  for (const u of unidades) {
    const t = tamanhoUnidade(u);
    if (n > 0 && total + t > orcamento) break;
    n++;
    total += t;
  }
  return n;
}

/** Divide as unidades em partes de ate `orcamento` chars (guloso, em ordem). */
function partesDoManifesto(unidades, orcamento) {
  const partes = [];
  for (let i = 0; i < unidades.length; ) {
    const n = quantasCabem(unidades.slice(i), orcamento);
    partes.push(unidades.slice(i, i + n));
    i += n;
  }
  return partes;
}

/** Arquivo de um segmento: `nome`, ou o prefixo do `segmento_id` (`<arquivo>#pNNNN`). */
function arquivoDe(d) {
  if (d.nome) return String(d.nome);
  const id = d.segmento_id ? String(d.segmento_id) : "";
  const i = id.lastIndexOf("#p");
  return i > 0 ? id.slice(0, i) : "?";
}

/**
 * Onde uma parte comeca e termina nos autos, por arquivo e folhas — a
 * coordenada que o advogado cita. Data de juntada nao serve de chave: o
 * manifesto segue arquivo e folha, e copia de outro processo traz a data de la.
 */
function trechoDaParte(unidades) {
  const primeiro = unidades[0].itens[0];
  const ultimo = unidades.at(-1).itens.at(-1);
  const ini = Array.isArray(primeiro.fls) ? primeiro.fls[0] : null;
  const fim = Array.isArray(ultimo.fls) ? ultimo.fls[1] : null;
  const a = arquivoDe(primeiro);
  const b = arquivoDe(ultimo);
  if (a === b) return ini != null && fim != null ? `${a}, fls. ${ini}-${fim}` : a;
  const pa = ini != null ? ` fls. ${ini}` : "";
  const pb = fim != null ? ` fls. ${fim}` : "";
  return `de ${a}${pa} a ${b}${pb}`;
}

/** Folga inicial do orcamento do corpo para o cabecalho e o indice das partes. */
const RESERVA_PARTES = 1_500;

/**
 * Renderiza o manifesto hierarquico do caso.
 *
 * Expediente de serventia (certidao, mandado, ato ordinatorio) e colapsado
 * numa linha agregada por padrao: em autos reais ele e ~40% dos segmentos e
 * enterra o esqueleto do processo. `expandirExpediente` desfaz o colapso.
 *
 * Manifesto legado (sem `segmento_id`/`peso`) degrada para a lista simples
 * de arquivos — nenhum caso ja ingerido perde o manifesto.
 *
 * Autos grandes vem em PARTES (medido em 09/10/2026: falencia com 3.469
 * segmentos dava 249 mil chars, 13 casos do parque passavam do teto). A
 * unidade de corte e a entrada do nivel 1 (`documentos[i]`, um ato ou um
 * expediente), sempre com os seus anexos; a numeracao das entradas nao depende
 * do colapso do expediente. Cada parte traz no topo o indice de todas as partes
 * por arquivo e folhas (para ir direto ao trecho dos autos que interessa) e no
 * fim a continuacao `manifesto(a_partir: N)`. Nada some em silencio: toda entrada
 * esta em alguma parte, e o indice diz quantas partes existem. Manifesto que
 * cabe no teto sai identico ao de antes, sem partes.
 */
export function renderManifesto(manifesto, { expandirExpediente = false, aPartir: pedido = 1, globalCap = OUTPUT_CAP_CHARS } = {}) {
  const aPartir = Number.isInteger(pedido) && pedido > 1 ? pedido : 1;
  const docs = manifesto?.documentos ?? [];
  const cabecalho = [
    `Caso: ${manifesto?.caso ?? "?"}`,
    `Documentos: ${manifesto?.total_documentos ?? docs.length}`,
  ];
  const temSegmento = docs.some((d) => d.segmento_id || (d.anexos ?? []).some((a) => a.segmento_id));
  const rodape = [];
  if (temSegmento) {
    rodape.push("");
    rodape.push(
      "Leitura de um documento logico: document(segmento: \"<id entre colchetes angulares>\")."
    );
    if (!expandirExpediente) {
      rodape.push("Expediente colapsado: chame manifesto(expandir_expediente: true) para ver linha a linha.");
    }
  }

  const todas = unidadesDoManifesto(docs, expandirExpediente, 0);
  const inteiro = [...cabecalho, "", ...todas.flatMap((u) => u.linhas), ...rodape].join("\n");
  if (aPartir <= 1 && inteiro.length <= globalCap) return inteiro;

  const total = docs.length;
  if (aPartir > total) {
    return [
      ...cabecalho,
      "",
      `Não há a entrada ${aPartir}: o manifesto tem ${total} entradas no nível 1. Comece em manifesto(a_partir: 1).`,
    ].join("\n");
  }

  const chamada = (n) => `manifesto(a_partir: ${n}${expandirExpediente ? ", expandir_expediente: true" : ""})`;

  // Texto de uma resposta: `corpo` sao as unidades entregues; `k` e o numero da
  // parte (0-based) quando o corpo e exatamente uma parte do indice, senao -1.
  const montar = (partes, corpo, k) => {
    const de = corpo[0].de;
    const ate = corpo.at(-1).ate;
    const situacao = k >= 0
      ? `Parte ${k + 1} de ${partes.length} (entradas ${de}-${ate} de ${total}; cada entrada é um ato ou expediente do nível 1, com os seus anexos).`
      : `Entradas ${de}-${ate} de ${total} (cada entrada é um ato ou expediente do nível 1, com os seus anexos).`;
    const indice = [
      `Índice das partes (manifesto grande demais para uma resposta só; vá direto a um trecho dos autos com ${chamada("<entrada>")}):`,
      ...partes.map((p, i) => `  parte ${i + 1}: a_partir ${p[0].de}, ${trechoDaParte(p)}`),
    ];
    const continua = ate < total
      ? `Continua${k >= 0 ? ` na parte ${k + 2}` : ""}: ${chamada(ate + 1)}.`
      : "Última parte.";
    return [...cabecalho, situacao, "", ...indice, "", ...corpo.flatMap((u) => u.linhas), "", continua, ...rodape].join("\n");
  };

  // O indice cresce com o numero de partes, e as partes com o orcamento do
  // corpo: reduz o orcamento ate a maior parte (cabecalho e indice inclusos)
  // caber no teto. So uma unidade sozinha acima do teto passa dele.
  let orcamento = globalCap - RESERVA_PARTES;
  let partes = partesDoManifesto(todas, orcamento);
  for (let tentativa = 0; tentativa < 10; tentativa++) {
    const excesso = Math.max(
      0,
      ...partes.map((p, i) => (p.length > 1 ? montar(partes, p, i).length - globalCap : 0))
    );
    if (excesso === 0) break;
    orcamento -= excesso + 50;
    partes = partesDoManifesto(todas, orcamento);
  }

  const k = partes.findIndex((p) => p[0].de === aPartir);
  if (k >= 0) return montar(partes, partes[k], k);
  // Entrada fora do inicio de uma parte: mesma regra, a partir dela.
  const us = unidadesDoManifesto(docs, expandirExpediente, aPartir - 1);
  let n = quantasCabem(us, orcamento);
  while (n > 1 && montar(partes, us.slice(0, n), -1).length > globalCap) n--;
  return montar(partes, us.slice(0, n), -1);
}

// === Ficha do caso (tool metadata) dentro do teto ===

/**
 * Listas da ficha que podem ser cortadas: arrays no topo do JSON e no
 * `briefing` (e onde mora o volume: dispositivos, numeros de processo,
 * contratos, valores envolvidos). Cada item e atomico e nunca e partido.
 */
function listasDaFicha(data) {
  const listas = [];
  for (const [k, v] of Object.entries(data ?? {})) {
    if (Array.isArray(v)) listas.push({ nome: k, ler: (d) => d[k], gravar: (d, x) => { d[k] = x; } });
  }
  const b = data?.briefing;
  if (b && typeof b === "object" && !Array.isArray(b)) {
    for (const [k, v] of Object.entries(b)) {
      if (Array.isArray(v)) {
        listas.push({ nome: `briefing.${k}`, ler: (d) => d.briefing[k], gravar: (d, x) => { d.briefing[k] = x; } });
      }
    }
  }
  return listas;
}

/** Folga para o aviso das listas cortadas no topo da ficha. */
const RESERVA_AVISO_FICHA = 800;

/**
 * Texto da tool `metadata` dentro do teto de saida.
 *
 * - Ficha que cabe sai identica ao JSON da API.
 * - Senao (medido em 09/10/2026: falencia com 50 dispositivos e 164 numeros
 *   de processo dava 66 mil chars), os campos simples saem intactos e cada
 *   lista entrega os seus primeiros itens INTEIROS, em rodizio entre as listas
 *   (toda lista mostra o comeco), ate o teto. O aviso no topo nomeia cada
 *   lista cortada com "N de M" e a chamada que le o resto.
 * - Com `lista` (ex.: "briefing.dispositivos"), entrega so os itens daquela
 *   lista a partir de `aPartir` (1-based), em ordem, com a continuacao no fim.
 *   Um item sozinho acima do teto sai inteiro.
 */
export function renderMetadata(data, { lista = null, aPartir = 1, globalCap = OUTPUT_CAP_CHARS } = {}) {
  const listas = listasDaFicha(data);
  if (lista) return renderListaDaFicha(data, listas, lista, aPartir, globalCap);

  const inteiro = JSON.stringify(data, null, 2);
  if (inteiro.length <= globalCap) return inteiro;

  const cortaveis = listas.filter((l) => l.ler(data).length > 0);
  const montar = (qtd) => {
    const copia = structuredClone(data);
    cortaveis.forEach((l, i) => l.gravar(copia, l.ler(data).slice(0, qtd[i])));
    return JSON.stringify(copia, null, 2);
  };
  const avisoDe = (qtd) => {
    const cortadas = cortaveis
      .map((l, i) => ({ l, n: qtd[i], total: l.ler(data).length }))
      .filter((x) => x.n < x.total);
    if (!cortadas.length) return "";
    return `[aviso: ficha do caso maior que o limite de output — listas entregues em parte ` +
      `(os primeiros itens, inteiros); o resto de cada uma se lê com a chamada indicada: ` +
      cortadas.map((x) => `${x.l.nome} ${x.n} de ${x.total}, metadata(lista: "${x.l.nome}", a_partir: ${x.n + 1})`).join("; ") +
      `.]\n\n`;
  };

  let orcamento = globalCap - RESERVA_AVISO_FICHA;
  for (let tentativa = 0; tentativa < 10; tentativa++) {
    // Rodizio: um item por lista por volta; lista cujo proximo item nao cabe sai da volta.
    const qtd = cortaveis.map(() => 0);
    const ativas = new Set(cortaveis.map((_, i) => i));
    while (ativas.size) {
      for (const i of [...ativas]) {
        if (qtd[i] >= cortaveis[i].ler(data).length) { ativas.delete(i); continue; }
        qtd[i]++;
        if (montar(qtd).length > orcamento) { qtd[i]--; ativas.delete(i); }
      }
    }
    const texto = avisoDe(qtd) + montar(qtd);
    if (texto.length <= globalCap) return texto;
    orcamento -= texto.length - globalCap + 50;
  }
  // Melhor esforco: so os campos simples cabem perto do teto.
  const zero = cortaveis.map(() => 0);
  return avisoDe(zero) + montar(zero);
}

function renderListaDaFicha(data, listas, nome, aPartir, globalCap) {
  const alvo = listas.find((l) => l.nome === nome);
  if (!alvo) {
    const nomes = listas.map((l) => `${l.nome} (${l.ler(data).length})`).join(", ");
    return `A ficha do caso não tem a lista "${nome}". Listas da ficha: ${nomes || "nenhuma"}.`;
  }
  const itens = alvo.ler(data);
  const inicio = Number.isInteger(aPartir) && aPartir > 1 ? aPartir : 1;
  if (inicio > itens.length) {
    return `A lista ${nome} tem ${itens.length} itens; não há o item ${inicio}.`;
  }
  const montar = (n) => {
    const fim = inicio - 1 + n;
    const cab = `Lista ${nome} da ficha do caso ${data?.caso ?? "?"}: itens ${inicio}-${fim} de ${itens.length}.\n\n`;
    const corpo = JSON.stringify(itens.slice(inicio - 1, fim), null, 2);
    const continua = fim < itens.length
      ? `\n\nContinua: metadata(lista: "${nome}", a_partir: ${fim + 1}).`
      : "\n\nFim da lista.";
    return cab + corpo + continua;
  };
  // Maior prefixo que cabe (o texto cresce com n); >= 1.
  let lo = 1;
  let hi = itens.length - inicio + 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (montar(mid).length <= globalCap) lo = mid;
    else hi = mid - 1;
  }
  return montar(lo);
}

// === Tool comparar ===

/**
 * Os `limit` pares mais similares, do maior score para o menor, cada par uma
 * vez. A API repassa `limit` ao search_matrix_pairs do Qdrant, onde ele e o
 * numero de vizinhos POR PONTO da amostra: com os defaults (sample 200, limit
 * 20) chegavam 4.000 pares agrupados por ponto, 344 mil chars (medido em
 * 09/10/2026), quando a tool promete os `limit` pares mais similares. O corte
 * e exato: um par do top `limit` global esta entre os `limit` vizinhos mais
 * proximos de cada um dos seus dois pontos.
 */
export function paresMaisSimilares(pairs, limit) {
  const unicos = new Map();
  for (const p of pairs || []) {
    const chave = [p.a, p.b].sort().join("\u0000");
    const atual = unicos.get(chave);
    if (!atual || p.score > atual.score) unicos.set(chave, p);
  }
  return [...unicos.values()].sort((x, y) => y.score - x.score).slice(0, limit);
}
