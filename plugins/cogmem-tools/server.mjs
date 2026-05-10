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
  "Busca hibrida: dense (BGE-M3 1024d) + sparse (FTS5/RRF) com payload do Qdrant. " +
  "Suporta filtros estruturados (combinaveis) sobre os campos do payload. " +
  "Use para recuperar contexto de sessoes passadas antes de explorar arquivos.",
  {
    query: z.string().describe("Texto de busca"),
    limit: z.number().optional().default(5).describe("Maximo de resultados (default 5)"),
    threshold: z.number().optional().default(0.3).describe("Score minimo RRF (default 0.3)"),
    days: z.number().optional().describe("Filtro temporal em dias (opcional, default 30 no daemon)"),
    repo_path: z.string().optional().describe("Filtrar por repo (caminho absoluto)"),
    role: z.enum(["user", "assistant"]).optional().describe("Filtrar por role do turno"),
    tool_used: z.string().optional().describe("Filtrar por tool builtin (Read, Edit, Bash, ...)"),
    mcp_tool: z.string().optional().describe("Filtrar por MCP tool (mcp__plugin_xxx__yyy)"),
    subagent: z.string().optional().describe("Filtrar por subagent acionado (ai-ml-engineer, etc.)"),
    skill_used: z.string().optional().describe("Filtrar por skill ativada (superpowers:xxx, etc.)"),
    is_sidechain: z.boolean().optional().describe("Filtrar sidechains (subagent transcripts)"),
    session_id: z.string().optional().describe("Filtrar por session_id especifico"),
  },
  async (params) => {
    try {
      const payload = { action: "search" };
      for (const k of [
        "query", "limit", "threshold", "days",
        "repo_path", "role", "tool_used", "mcp_tool",
        "subagent", "skill_used", "is_sidechain", "session_id",
      ]) {
        if (params[k] !== undefined) payload[k] = params[k];
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

// Tool: code_search
server.tool(
  "code_search",
  "Busca semantica em chunks de codigo indexados (collection cogmem_code). " +
  "Suporta filtro por repo_path. Retorna trechos com file_path, symbol_name, " +
  "language, start_line/end_line, score.",
  {
    query: z.string().describe("Texto/conceito a buscar no codigo"),
    repo_path: z.string().optional().describe("Filtrar por repo (caminho absoluto)"),
    limit: z.number().optional().default(5).describe("Maximo de resultados (default 5)"),
  },
  async ({ query, repo_path, limit }) => {
    try {
      const payload = { action: "code_search", query, limit };
      if (repo_path) payload.repo_path = repo_path;
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

// Tool: list_sessions
server.tool(
  "list_sessions",
  "Lista sessoes registradas (cogmem_sessions) filtradas por janela temporal " +
  "e/ou repo. Retorna metadata de cada sessao: id, started_at, ended_at, " +
  "chunk_count, total_tokens, files_touched, tools_used.",
  {
    days: z.number().optional().default(7).describe("Janela em dias (default 7)"),
    repo_path: z.string().optional().describe("Filtrar por repo (caminho absoluto)"),
  },
  async ({ days, repo_path }) => {
    try {
      const payload = { action: "get_sessions", days };
      if (repo_path) payload.repo_path = repo_path;
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

// Tool: get_session
server.tool(
  "get_session",
  "Retorna todos os chunks de uma sessao em ordem cronologica. " +
  "Use para reconstituir a conversa completa de uma sessao identificada via " +
  "list_sessions ou search.",
  {
    session_id: z.string().describe("ID da sessao (UUID, vem de list_sessions ou search)"),
  },
  async ({ session_id }) => {
    try {
      const payload = { action: "get_chunks_by_session", session_id };
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
