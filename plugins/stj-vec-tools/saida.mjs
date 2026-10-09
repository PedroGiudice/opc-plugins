/**
 * Teto de saida da tool `document` (inteiro teor do STJ e dispositivo da base
 * de legislacao).
 *
 * Copia BYTE-IDENTICA em stj-vec-tools e legal-vec-tools (cada plugin e
 * instalado isolado no cache do Claude Code, entao nao ha import entre
 * plugins); o teste de paridade em stj-vec-tools/saida.parity.test.mjs vigia
 * a divergencia no dev clone.
 */

/**
 * Teto de chars do texto devolvido, o mesmo OUTPUT_CAP_CHARS do case-knowledge
 * (format.mjs, onde esta a calibragem contra o limite do Claude Code: arquivo
 * acima de 50.000 chars OU 25.000 tokens). Medido em 09/10/2026 com a contagem
 * oficial da API sobre as janelas de leitura deste formato (JSON indentado):
 * acordao do STJ 2,22 chars/token na mediana (pior janela 1,83), lei 2,35 (pior
 * 1,85). Com 20.000 chars a maior janela medida ficou em ~9,4k tokens.
 */
export const OUTPUT_CAP_CHARS = 20_000;

/**
 * Fatia o documento da API em chunks INTEIROS e consecutivos que cabem no teto.
 *
 * - Documento que cabe sai identico ao JSON da API (com os chunks ordenados).
 * - Senao, entrega o prefixo que coube a partir de `fromChunk`, com o aviso
 *   `Continue com from_chunk=N` no topo e `chunks_entregues`/`next_from` no
 *   JSON, depois dos metadados e antes de `chunks` (o aidv-passos le os
 *   metadados ate `"chunks"`; o painel do aidv-autos le o JSON a partir do
 *   primeiro `{` e o `from_chunk=N` do aviso).
 * - O conteudo de cada chunk e o da API, nunca partido nem resumido; um chunk
 *   sozinho acima do teto sai assim mesmo (nunca entrega zero).
 *
 * `from_chunk` e o `chunk_index` quando todos os chunks o tem (STJ); senao, a
 * posicao na ordem da API (a API da legislacao nao devolve `chunk_index`).
 */
export function paginarDocumento(data, { fromChunk = 0, globalCap = OUTPUT_CAP_CHARS, rotulo = "documento" } = {}) {
  const { chunks: brutos = [], ...meta } = data || {};
  const temIndice = brutos.length > 0 && brutos.every((c) => Number.isInteger(c.chunk_index));
  const ordenados = temIndice ? [...brutos].sort((a, b) => a.chunk_index - b.chunk_index) : [...brutos];
  const indice = (c, i) => (temIndice ? c.chunk_index : i);
  const total = ordenados.length;

  if (fromChunk <= 0) {
    const inteiro = JSON.stringify({ ...data, chunks: ordenados }, null, 2);
    if (inteiro.length <= globalCap) {
      return { text: inteiro, total, delivered: total, truncated: false, next_from: null };
    }
  }

  const elegiveis = ordenados
    .map((c, i) => ({ c, idx: indice(c, i) }))
    .filter((x) => x.idx >= fromChunk);
  if (elegiveis.length === 0) {
    return {
      text: `Nenhum chunk com índice >= ${fromChunk} neste ${rotulo} (total: ${total} chunks).`,
      total, delivered: 0, truncated: false, next_from: null,
    };
  }

  const montar = (n) => {
    const kept = elegiveis.slice(0, n);
    const truncated = n < elegiveis.length;
    const de = kept[0].idx;
    const ate = kept[kept.length - 1].idx;
    const nextFrom = truncated ? elegiveis[n].idx : null;
    const corpo = JSON.stringify({
      ...meta,
      chunks_entregues: `${de}-${ate}`,
      ...(truncated ? { next_from: nextFrom } : {}),
      chunks: kept.map((x) => x.c),
    }, null, 2);
    const aviso = truncated
      ? `[aviso: ${rotulo} maior que o limite de output — entregue até o chunk ${ate} de ${total}. ` +
        `Continue com from_chunk=${nextFrom}.]\n`
      : "";
    return { text: aviso + corpo, total, delivered: n, truncated, next_from: nextFrom };
  };

  const tudo = montar(elegiveis.length);
  if (tudo.text.length <= globalCap) return tudo;
  // Maior prefixo que cabe (o tamanho cresce com n enquanto ha aviso); >= 1.
  let lo = 1;
  let hi = elegiveis.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (montar(mid).text.length <= globalCap) lo = mid;
    else hi = mid - 1;
  }
  return montar(lo);
}
