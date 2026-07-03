#!/usr/bin/env node
/**
 * MCP server for legal-knowledge-base vector search.
 *
 * Proxy for the Rust search API (legal-vec-api) on the VM, reachable over the
 * tailnet at 100.123.73.128:8423.
 * Tools: search (hybrid + filters), document (by doc_id), recommend (similar articles),
 *        sources (collection stats).
 *
 * Transport: stdio (required for Claude Code plugins)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { requestWithAuth, loginFlow } from "./auth.mjs";

// legal-vec-api roda na VM; o default aponta pro IP tailnet, alcancavel de
// qualquer cliente na tailnet. O default antigo 127.0.0.1 batia no loopback do
// PROPRIO cliente (fetch failed em maquinas remotas). Padrao uniforme com os
// demais plugins; override via LEGAL_VEC_API_BASE. Ver case-docs/docs/infraestrutura-dados.md.
const API_BASE =
  process.env.LEGAL_VEC_API_BASE || "http://100.123.73.128:8423/api";
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
  // requestWithAuth injeta o Bearer (quando ha credencial), refresca proativo
  // (<60s) e reativo (401 -> refresh -> 1 retry). Sem credencial -> degrade sem
  // Bearer (compat tailnet require_bearer=false).
  const res = await requestWithAuth((authHeaders) =>
    fetchWithRetry(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
    })
  );

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
  const res = await requestWithAuth((authHeaders) =>
    fetchWithRetry(`${API_BASE}${path}`, { headers: { ...authHeaders } })
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }

  return await res.json();
}

// --- MCP Server ---

const server = new McpServer({
  name: "legal-vec-tools",
  version: "0.5.0",
});

// Tool: search
server.tool(
  "search",
  "Busca hibrida (dense + sparse + RRF) na base de legislacao brasileira. " +
    "Retorna chunks relevantes de CF, CC, CPC, CDC, CLT, CP, CPP, ECA e jurisprudencia TESEMO. " +
    "Sempre usa modo hybrid (dense + sparse + RRF).",
  {
    query: z.string().describe("Query de busca em linguagem natural"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Numero maximo de resultados (default 10, max 50)"),
    materia: z
      .string()
      .optional()
      .describe(
        "Filtrar por materia: civil, processual, trabalhista, penal, tributario, administrativo, constitucional, consumidor, empresarial"
      ),
    tipo: z
      .string()
      .optional()
      .describe("Filtrar por tipo: legislacao ou sumula"),
    fonte: z
      .string()
      .optional()
      .describe(
        "Filtrar por fonte especifica: planalto/codigo_civil, sumulas/stj, etc."
      ),
  },
  async ({ query, limit, materia, tipo, fonte }) => {
    try {
      const data = await apiPost("/search", {
        query,
        limit,
        materia,
        tipo,
        fonte,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
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
    "Retorna todos os chunks do documento com conteudo completo.",
  {
    doc_id: z
      .string()
      .describe("ID do documento (campo doc_id dos resultados de busca)"),
  },
  async ({ doc_id }) => {
    try {
      const data = await apiGet(`/document/${doc_id}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
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

// Tool: recommend
server.tool(
  "recommend",
  "Dado um doc_id, retorna os artigos/sumulas mais similares na base. " +
    "Usa o vetor do documento como query (sem precisar formular busca textual).",
  {
    doc_id: z
      .string()
      .describe(
        "ID do documento base (ex: codigo_civil_art_927, sumula_stj_1)"
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe("Numero maximo de recomendacoes (default 5)"),
    materia: z.string().optional().describe("Filtrar por materia"),
    tipo: z.string().optional().describe("Filtrar por tipo"),
    fonte: z.string().optional().describe("Filtrar por fonte"),
  },
  async ({ doc_id, limit, materia, tipo, fonte }) => {
    try {
      const data = await apiPost("/recommend", {
        doc_id,
        limit,
        materia,
        tipo,
        fonte,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Erro na recomendacao: ${err.message}` },
        ],
        isError: true,
      };
    }
  }
);

// Tool: sources
server.tool(
  "sources",
  "Lista as fontes disponiveis na base de legislacao e quantidade de chunks por fonte.",
  {},
  async () => {
    try {
      const data = await apiGet("/sources");
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Erro ao listar fontes: ${err.message}` },
        ],
        isError: true,
      };
    }
  }
);

// Start
// Subcomando `login`: dispara o fluxo OAuth loopback + PKCE e encerra o
// processo. NUNCA sobe o MCP server neste modo — no modo MCP o stdout e o canal
// JSON-RPC; aqui ele fica livre para as mensagens humanas do login.
if (process.argv[2] === "login") {
  try {
    await loginFlow();
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Login falhou: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(1);
  }
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
