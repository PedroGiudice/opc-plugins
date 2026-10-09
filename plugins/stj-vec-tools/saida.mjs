/**
 * Teto de saida das tools `document` (inteiro teor do STJ e dispositivo da base
 * de legislacao) e das buscas (`search`, `search_formula`, `recommend`).
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

/**
 * Pagina a resposta de uma busca (`{ results: [...] }` mais metadados) em
 * resultados INTEIROS e consecutivos que cabem no teto.
 *
 * Medido em 09/10/2026: um chunk do STJ tem ~2 mil chars, entao a busca com
 * limit 50 dava 122 mil chars (search_formula 135 mil) e ate o limit 10
 * padrao passava de 20 mil. O conteudo de cada resultado e o da API, nunca
 * partido nem resumido: a regra de citacao do escritorio exige a ementa
 * integral, e um preview cortado seria transcrito como se fosse ela.
 *
 * - Busca que cabe sai identica ao JSON da API.
 * - Senao, entrega os resultados a partir de `aPartir` (1-based, na ordem da
 *   busca) que couberem, com o aviso `Continue com a_partir=N` no topo e
 *   `resultados_entregues`/`proximo_a_partir` no JSON, antes de `results`.
 *   O painel do aidv-autos le o JSON a partir do primeiro `{`, entao o aviso
 *   nao pode ter chave nem nada vir depois do JSON.
 * - Um resultado sozinho acima do teto sai assim mesmo (nunca entrega zero).
 *
 * A API nao tem offset: a continuacao repete a mesma busca (query, filtros e
 * limit) e entrega a fatia seguinte da mesma lista.
 */
export function paginarResultados(data, { aPartir = 1, globalCap = OUTPUT_CAP_CHARS, rotulo = "resultados da busca" } = {}) {
  const { results: brutos, ...meta } = data || {};
  const resultados = Array.isArray(brutos) ? brutos : [];
  const total = resultados.length;
  const inicio = Number.isInteger(aPartir) && aPartir > 1 ? aPartir : 1;

  if (inicio === 1) {
    const inteiro = JSON.stringify(data, null, 2);
    if (inteiro.length <= globalCap) {
      return { text: inteiro, total, delivered: total, truncated: false, proximo_a_partir: null };
    }
  }
  if (inicio > total) {
    return {
      text: `Nenhum resultado a partir do ${inicio} (a busca devolveu ${total}).`,
      total, delivered: 0, truncated: false, proximo_a_partir: null,
    };
  }

  const elegiveis = resultados.slice(inicio - 1);
  const montar = (n) => {
    const ate = inicio + n - 1;
    const truncated = ate < total;
    const proximo = truncated ? ate + 1 : null;
    const corpo = JSON.stringify({
      ...meta,
      resultados_entregues: `${inicio}-${ate} de ${total}`,
      ...(truncated ? { proximo_a_partir: proximo } : {}),
      results: elegiveis.slice(0, n),
    }, null, 2);
    const aviso = truncated
      ? `[aviso: ${rotulo} maiores que o limite de output — entregues os resultados ${inicio}-${ate} de ${total}, ` +
        `inteiros e na ordem da busca. Continue com a_partir=${proximo} (mesma query, filtros e limit).]\n`
      : "";
    return { text: aviso + corpo, total, delivered: n, truncated, proximo_a_partir: proximo };
  };

  const tudo = montar(elegiveis.length);
  if (tudo.text.length <= globalCap) return tudo;
  let lo = 1;
  let hi = elegiveis.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (montar(mid).text.length <= globalCap) lo = mid;
    else hi = mid - 1;
  }
  return montar(lo);
}
