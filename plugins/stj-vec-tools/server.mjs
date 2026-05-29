#!/usr/bin/env node
/**
 * MCP server for STJ vector search.
 *
 * Proxy for the Rust search API (stj-vec-search) running on localhost:8421.
 * Exposes 4 tools: search, search_formula, document, filters.
 *
 * Transport: stdio (required for Claude Code plugins)
 * Dependencies: @modelcontextprotocol/sdk, zod
 *
 * Schema alinhado 1-1 com `crates/search/src/types.rs::SearchFilters` e
 * `routes.rs::FormulaWeights`. A collection `stj` e dense-only (sparse
 * desligado desde 17/05/2026) -- nao ha fusao RRF no caminho de busca.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = process.env.STJ_VEC_API_BASE || "http://127.0.0.1:8421/api";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3;
const RETRY_DELAYS = [500, 1500, 3000]; // ms

/**
 * Sleep helper.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with retry. Retries on connection errors (fetch failed, ECONNREFUSED).
 */
async function fetchWithRetry(url, options = {}) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;

      // Only retry on connection errors, not on aborts
      if (err.name === "AbortError" || attempt >= MAX_RETRIES) {
        throw err;
      }

      const delay = RETRY_DELAYS[attempt] || 3000;
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * POST request to the Rust search API.
 */
async function apiPost(path, body) {
  const res = await fetchWithRetry(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }

  return await res.json();
}

/**
 * GET request to the Rust search API.
 */
async function apiGet(path) {
  const res = await fetchWithRetry(`${API_BASE}${path}`);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }

  return await res.json();
}

/**
 * Wrap a JSON payload as MCP text content.
 */
function jsonContent(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/**
 * Wrap an error as MCP error content.
 */
function errorContent(prefix, err) {
  return {
    content: [{ type: "text", text: `${prefix}: ${err.message}` }],
    isError: true,
  };
}

// --- Shared schemas (1-1 com SearchFilters no Rust) ---

const secaoValues = "ementa, ementa_citada, voto, dispositivo, relatorio, acordao, decisao, outros";

// Aceita string ("voto") ou array (["voto","dispositivo"]); o Rust desserializa ambos.
const secaoField = z.union([z.string(), z.array(z.string())]);

const filtersField = z
  .object({
    ministro: z.string().optional().describe("Nome do ministro relator (ex: BENEDITO GONCALVES). Ver tool filters."),
    classe: z.string().optional().describe("Classe processual: RESP, HC, ARESP, AG, AC, MS, CC, etc. Ver tool filters."),
    tipo: z
      .string()
      .optional()
      .describe("Tipo de documento. Aceita com ou sem acento: ACORDAO/ACORDAO, DECISAO/DECISAO."),
    orgao_julgador: z
      .string()
      .optional()
      .describe("Orgao julgador: PRIMEIRA TURMA, SEGUNDA SECAO, CORTE ESPECIAL, etc. Ver tool filters."),
    processo: z
      .string()
      .optional()
      .describe("Match EXATO no numero do processo, ex: 'AREsp 2492484'. Tem prioridade sobre a query."),
    data_from: z.string().optional().describe("Inicio da faixa de data (YYYY-MM-DD). Faixa, nao data exata."),
    data_to: z.string().optional().describe("Fim da faixa de data (YYYY-MM-DD)."),
    ano_min: z.number().int().optional().describe("Ano minimo de julgamento/publicacao (inteiro, ex: 2020)."),
    ano_max: z.number().int().optional().describe("Ano maximo de julgamento/publicacao (inteiro, ex: 2024)."),
    secao: secaoField.optional().describe(`Restringe a busca a uma ou mais secoes do acordao (${secaoValues}). String ou array.`),
    must_not_secao: secaoField
      .optional()
      .describe(`Exclui chunks das secoes informadas (${secaoValues}). String ou array. Util para fugir de transcricoes literais repetidas.`),
  })
  .optional()
  .default({})
  .describe("Filtros opcionais para restringir a busca");

// FormulaWeights -- defaults ja calibrados no backend (analise H5, Config 2).
// Passar apenas para sobrescrever.
const weightsField = z
  .object({
    w_dense: z.number().optional().describe("Multiplicador sobre o score dense base. Default 1.0."),
    secao_boost: z
      .record(z.string(), z.number())
      .optional()
      .describe("Mapa secao->multiplicador (ex: {\"dispositivo\":1.05}). Secoes ausentes = 1.0."),
    w_chunk_index_relatorio: z
      .number()
      .optional()
      .describe("Penalty de posicao para secao=relatorio: score *= max(0.8, 1 - w*chunk_index). Default calibrado 0.02."),
    w_cited: z
      .number()
      .optional()
      .describe("Boost por citacoes: score *= (1 + w*log10(1+cited_by)). Default calibrado 0.0 (desligado)."),
    w_ano: z.number().optional().describe("Boost temporal. Default 0.0 (desligado -- reranker e tempo-agnostico)."),
    ano_pivot: z.number().int().optional().describe("Ano pivot para normalizacao temporal. Default 2010."),
    ano_span: z.number().int().optional().describe("Span de anos para normalizacao temporal. Default 15."),
  })
  .optional()
  .describe("Pesos da formula (sobrescreve defaults calibrados). Omitir usa a configuracao H5 do backend.");

// --- MCP Server ---

const server = new McpServer({
  name: "stj-vec-tools",
  version: "0.3.0",
});

// Tool: search (dense)
server.tool(
  "search",
  "Busca vetorial densa (BGE-M3 1024d) na base de jurisprudencia do STJ (collection dense-only). " +
    "Retorna chunks de acordaos, decisoes monocraticas e votos relevantes para a query. " +
    "Use filtros para restringir por ministro, classe, tipo, orgao julgador, secao, processo, faixa de data ou ano. " +
    "Para reranking por relevancia juridica (boost por secao/citacao), use a tool search_formula.",
  {
    query: z.string().describe("Query de busca em linguagem natural"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Numero maximo de resultados (default 10, max 50)"),
    filters: filtersField,
  },
  async ({ query, limit, filters }) => {
    try {
      return jsonContent(await apiPost("/search", { query, limit, filters }));
    } catch (err) {
      return errorContent("Erro na busca", err);
    }
  }
);

// Tool: search_formula (rerank multiplicativo)
server.tool(
  "search_formula",
  "Busca com reranking por formula multiplicativa configuravel sobre um candidate pool dense: " +
    "score = dense * secao_boost * chunk_index_boost * cited_boost * ano_boost. " +
    "Cada resultado traz formula_score e formula_components inspecionaveis. " +
    "Defaults ja calibrados (analise H5, Config 2); use weights apenas para experimentar. " +
    "Mesmos filtros da tool search.",
  {
    query: z.string().describe("Query de busca em linguagem natural"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Numero de resultados finais apos rerank (default 10, max 50)"),
    overfetch: z
      .number()
      .int()
      .min(10)
      .max(200)
      .default(100)
      .describe("Tamanho do candidate pool dense antes do rerank (default 100, max 200)"),
    filters: filtersField,
    weights: weightsField,
  },
  async ({ query, limit, overfetch, filters, weights }) => {
    try {
      const body = { query, limit, overfetch, filters };
      if (weights !== undefined) body.weights = weights;
      return jsonContent(await apiPost("/search/formula", body));
    } catch (err) {
      return errorContent("Erro na busca por formula", err);
    }
  }
);

// Tool: document
server.tool(
  "document",
  "Busca um documento especifico pelo doc_id. " +
    "Retorna o conteudo completo do documento com todos os chunks e metadados.",
  {
    doc_id: z.string().describe("ID do documento (campo doc_id dos resultados de busca)"),
  },
  async ({ doc_id }) => {
    try {
      return jsonContent(await apiGet(`/document/${doc_id}`));
    } catch (err) {
      return errorContent("Erro ao buscar documento", err);
    }
  }
);

// Tool: filters
server.tool(
  "filters",
  "Lista os filtros disponiveis e seus valores possiveis (ministros, classes, tipos, orgaos julgadores). " +
    "Use para descobrir os valores validos antes de filtrar uma busca.",
  {},
  async () => {
    try {
      return jsonContent(await apiGet("/filters"));
    } catch (err) {
      return errorContent("Erro ao listar filtros", err);
    }
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
