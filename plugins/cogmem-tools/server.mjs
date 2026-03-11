#!/usr/bin/env node
/**
 * MCP server for cogmem daemon.
 *
 * Thin wrapper that exposes the cogmem daemon (Rust, Unix socket)
 * as MCP tools: search, insert, context.
 *
 * Protocol: JSON-line over Unix socket at /tmp/claude-cogmem.sock
 * Transport: stdio (required for Claude Code plugins)
 * Dependencies: @modelcontextprotocol/sdk, node:net (native)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createConnection } from "node:net";
import { z } from "zod";

const SOCKET_PATH = "/tmp/claude-cogmem.sock";
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Send a request to the cogmem daemon via Unix socket.
 * Returns the parsed JSON response.
 */
function sendToDaemon(payload) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        client.destroy();
        reject(new Error(`Timeout: daemon nao respondeu em ${REQUEST_TIMEOUT_MS}ms`));
      }
    }, REQUEST_TIMEOUT_MS);

    const client = createConnection(SOCKET_PATH, () => {
      client.write(JSON.stringify(payload) + "\n");
    });

    client.on("data", (chunk) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        settled = true;
        clearTimeout(timer);
        client.destroy();
        try {
          resolve(JSON.parse(line));
        } catch (err) {
          reject(new Error(`Resposta invalida do daemon: ${line}`));
        }
      }
    });

    client.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
          reject(new Error(
            "cogmem daemon nao esta rodando. " +
            "Execute: systemctl --user start cogmem"
          ));
        } else {
          reject(new Error(`Erro de conexao com o daemon: ${err.message}`));
        }
      }
    });

    client.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (buffer.trim()) {
          try {
            resolve(JSON.parse(buffer.trim()));
          } catch {
            reject(new Error(`Resposta incompleta do daemon: ${buffer}`));
          }
        } else {
          reject(new Error("Conexao fechada sem resposta"));
        }
      }
    });
  });
}

/**
 * Format daemon response as MCP tool result.
 * On error, returns isError: true with the error message.
 */
function formatResult(response) {
  if (response.status === "error") {
    return {
      content: [{ type: "text", text: `Erro: ${response.message || JSON.stringify(response)}` }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
  };
}

// --- Server setup ---

const server = new McpServer({
  name: "cogmem-tools",
  version: "0.1.0",
});

// Tool: search
server.tool(
  "search",
  "Busca na memoria cognitiva de sessoes anteriores. " +
  "Busca hibrida: dense (BGE-M3 1024d) + sparse (BM25 FTS5) + fusao RRF. " +
  "Scores RRF tipicamente entre 0.01-0.03 (ranking relativo importa, nao valor absoluto). " +
  "Use para recuperar contexto de sessoes passadas antes de explorar arquivos.",
  {
    query: z.string().describe("Texto de busca"),
    limit: z.number().optional().default(5).describe("Maximo de resultados (default 5)"),
    threshold: z.number().optional().default(0.3).describe("Score minimo RRF (default 0.3)"),
    days: z.number().optional().describe("Filtro temporal em dias (opcional)"),
  },
  async ({ query, limit, threshold, days }) => {
    try {
      const payload = { action: "search", query, limit, threshold };
      if (days !== undefined) {
        payload.days = days;
      }
      const response = await sendToDaemon(payload);
      return formatResult(response);
    } catch (err) {
      return {
        content: [{ type: "text", text: err.message }],
        isError: true,
      };
    }
  }
);

// Tool: insert
server.tool(
  "insert",
  "Insere conteudo na memoria cognitiva para recuperacao futura. " +
  "Use para memorizar decisoes arquiteturais, caminhos importantes, " +
  "padroes de uso ou qualquer informacao valiosa para sessoes futuras.",
  {
    content: z.string().describe("Texto a memorizar"),
    repo_path: z.string().optional().describe("Repositorio associado (default: cwd)"),
  },
  async ({ content, repo_path }) => {
    try {
      const sessionId = `mcp-manual-${Date.now()}`;
      const tokenCount = Math.ceil(content.length / 4);
      const payload = {
        action: "insert",
        session_id: sessionId,
        content,
        repo_path: repo_path || process.cwd(),
        token_count: tokenCount,
      };
      const response = await sendToDaemon(payload);
      return formatResult(response);
    } catch (err) {
      return {
        content: [{ type: "text", text: err.message }],
        isError: true,
      };
    }
  }
);

// Tool: context
server.tool(
  "context",
  "Obtem contexto completo (attention state + busca vetorial) para um prompt. " +
  "Combina o que o sistema de atencao 've' com chunks de memoria relevantes. " +
  "Retorna: conceitos ativados, arquivos hot/warm, chunks vetoriais, turno atual.",
  {
    prompt: z.string().describe("Prompt/query para contextualizar"),
    repo_path: z.string().optional().describe("Repositorio (default: cwd)"),
  },
  async ({ prompt, repo_path }) => {
    try {
      const payload = {
        action: "context",
        prompt,
        repo_path: repo_path || process.cwd(),
      };
      const response = await sendToDaemon(payload);
      return formatResult(response);
    } catch (err) {
      return {
        content: [{ type: "text", text: err.message }],
        isError: true,
      };
    }
  }
);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
