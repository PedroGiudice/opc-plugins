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
