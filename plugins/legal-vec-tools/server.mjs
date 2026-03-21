#!/usr/bin/env node
/**
 * MCP server for legal-knowledge-base vector search.
 *
 * Calls the Rust binary legal-vec-ingest for hybrid search (dense + sparse + RRF).
 * Transport: stdio (required for Claude Code plugins)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const BINARY = "/home/opc/legal-knowledge-base/ingest/target/release/legal-vec-ingest";
const CONFIG = "/home/opc/legal-knowledge-base/ingest/legal-vec.toml";
const TIMEOUT_MS = 30_000;

/**
 * Run the Rust binary with given args, return parsed JSON.
 */
async function runBinary(args) {
  const { stdout } = await execFileAsync(BINARY, ["-c", CONFIG, ...args], {
    timeout: TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024, // 10MB
  });
  return JSON.parse(stdout.trim());
}

// --- MCP Server ---

const server = new McpServer({
  name: "legal-vec-tools",
  version: "0.1.0",
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
  },
  async ({ query, limit }) => {
    try {
      const results = await runBinary([
        "search",
        query,
        "-k",
        String(limit),
        "--json",
      ]);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results, null, 2),
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
    "Retorna todos os chunks do documento com conteudo completo.",
  {
    doc_id: z
      .string()
      .describe("ID do documento (campo doc_id dos resultados de busca)"),
  },
  async ({ doc_id }) => {
    try {
      // Query SQLite directly for document chunks since the binary doesn't have
      // a document subcommand yet. Use search with doc_id as a workaround.
      // TODO: add 'document' subcommand to Rust binary
      const results = await runBinary([
        "search",
        doc_id,
        "-k",
        "50",
        "--json",
      ]);
      // Filter to only chunks from this doc_id
      const filtered = results.filter((r) => r.doc_id === doc_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(filtered, null, 2),
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

// Tool: sources
server.tool(
  "sources",
  "Lista as fontes disponiveis na base de legislacao e quantidade de chunks por fonte.",
  {},
  async () => {
    try {
      const { stdout } = await execFileAsync(
        BINARY,
        ["-c", CONFIG, "stats"],
        { timeout: TIMEOUT_MS }
      );
      return {
        content: [
          {
            type: "text",
            text: stdout.trim(),
          },
        ],
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
const transport = new StdioServerTransport();
await server.connect(transport);
