#!/usr/bin/env node
/**
 * MCP server for STJ vector search.
 *
 * Proxy for the Rust search API (stj-vec-search) running on localhost:8421.
 * Exposes 3 tools: search, document, filters.
 *
 * Transport: stdio (required for Claude Code plugins)
 * Dependencies: @modelcontextprotocol/sdk
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

// --- MCP Server ---

const server = new McpServer({
  name: "stj-vec-tools",
  version: "0.2.0",
});

// Tool: search
server.tool(
  "search",
  "Busca vetorial hibrida (dense + sparse + RRF) na base de jurisprudencia do STJ. " +
    "Retorna acordaos, decisoes e votos relevantes para a query. " +
    "Use filtros para restringir por secao, classe, tipo, orgao julgador ou data.",
  {
    query: z.string().describe("Query de busca em linguagem natural"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Numero maximo de resultados (default 10, max 50)"),
    filters: z
      .object({
        secao: z
          .string()
          .optional()
          .describe("Filtrar por secao: ementa, acordao, voto, decisao, relatorio"),
        classe: z
          .string()
          .optional()
          .describe("Filtrar por classe processual: RESP, HC, ARESP, CC, MS, etc."),
        tipo: z
          .string()
          .optional()
          .describe("Filtrar por tipo de documento: ACORDAO, DECISAO (com acentos obrigatorios)"),
        orgao_julgador: z
          .string()
          .optional()
          .describe("Filtrar por orgao julgador: PRIMEIRA TURMA, SEGUNDA TURMA, etc."),
        data_julgamento: z
          .string()
          .optional()
          .describe("Filtrar por data de julgamento (formato: YYYY-MM-DD)"),
      })
      .optional()
      .default({})
      .describe("Filtros opcionais para restringir a busca"),
  },
  async ({ query, limit, filters }) => {
    try {
      const data = await apiPost("/search", { query, limit, filters });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Erro na busca: ${err.message}` }],
        isError: true,
      };
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
      const data = await apiGet(`/document/${doc_id}`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Erro ao buscar documento: ${err.message}` },
        ],
        isError: true,
      };
    }
  }
);

// Tool: filters
server.tool(
  "filters",
  "Lista os filtros disponiveis e seus valores possiveis. " +
    "Use para descobrir quais classes, secoes, tipos e orgaos julgadores existem na base.",
  {},
  async () => {
    try {
      const data = await apiGet("/filters");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Erro ao listar filtros: ${err.message}` },
        ],
        isError: true,
      };
    }
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
