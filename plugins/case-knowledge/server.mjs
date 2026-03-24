#!/usr/bin/env node
/**
 * MCP server for Case Knowledge System.
 *
 * Hybrid search (dense + sparse + RRF) in per-case knowledge.db files.
 * Calls case-ingest CLI as subprocess for search operations.
 *
 * Transport: stdio (required for Claude Code plugins)
 * Dependencies: @modelcontextprotocol/sdk
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CASE_INGEST = "/home/opc/lex-vector/stj-vec/target/release/case-ingest";
const CASES_BASE = "/home/opc/case-docs/cases";

/**
 * Parse case-ingest search output into structured results.
 */
function parseSearchOutput(output) {
  const results = [];
  const blocks = output.split(/^--- Resultado \d+ /m).filter(Boolean);

  for (const block of blocks) {
    const scoreMatch = block.match(/\(score: ([\d.]+)\)/);
    const fileMatch = block.match(/^Arquivo: (.+)$/m);
    const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0;
    const file = fileMatch ? fileMatch[1].trim() : "unknown";

    const contentStart = block.indexOf("\n", block.indexOf("Arquivo:"));
    const content = contentStart >= 0 ? block.slice(contentStart).trim() : "";

    results.push({ score, file, content });
  }

  return results;
}

/**
 * Resolve case directory from case name.
 */
function resolveCaseDir(caseName) {
  if (caseName.startsWith("/")) {
    return caseName;
  }
  return join(CASES_BASE, caseName);
}

// --- MCP Server ---

const server = new McpServer({
  name: "case-knowledge",
  version: "0.1.0",
});

// Tool: search
server.tool(
  "search",
  "Busca hibrida (semantica + lexical) nos documentos de um caso juridico. " +
    "Resolve knowledge.db pela pasta do caso. " +
    "O parametro case_dir aceita nome do caso (ex: 'federal_educacional') ou path absoluto.",
  {
    query: z.string().describe("Texto para busca em linguagem natural"),
    case_dir: z
      .string()
      .describe(
        "Pasta do caso: nome (ex: 'federal_educacional') ou path absoluto. " +
          "O knowledge.db deve existir nessa pasta."
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Numero maximo de resultados (default 10, max 50)"),
  },
  async ({ query, case_dir, limit }) => {
    try {
      const caseDir = resolveCaseDir(case_dir);
      const dbPath = join(caseDir, "knowledge.db");

      if (!existsSync(dbPath)) {
        return {
          content: [
            {
              type: "text",
              text: `knowledge.db nao encontrado em ${caseDir}. Rode 'case-ingest init' na pasta do caso.`,
            },
          ],
          isError: true,
        };
      }

      const output = execFileSync(
        CASE_INGEST,
        ["search", query, "--limit", String(limit)],
        {
          cwd: caseDir,
          encoding: "utf-8",
          timeout: 120_000,
        }
      );

      const results = parseSearchOutput(output);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Nenhum resultado encontrado para a query.",
            },
          ],
        };
      }

      const formatted = results
        .map(
          (r, i) =>
            `--- Resultado ${i + 1} (score: ${r.score.toFixed(3)}) ---\n` +
            `Arquivo: ${r.file}\n${r.content}`
        )
        .join("\n\n");

      return {
        content: [{ type: "text", text: formatted }],
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Erro na busca: ${err.message}` },
        ],
        isError: true,
      };
    }
  }
);

// Tool: list_cases
server.tool(
  "list_cases",
  "Lista os casos disponiveis com knowledge.db no diretorio de casos.",
  {},
  async () => {
    try {
      const entries = readdirSync(CASES_BASE);
      const cases = [];

      for (const entry of entries) {
        const dir = join(CASES_BASE, entry);
        const db = join(dir, "knowledge.db");
        if (statSync(dir).isDirectory() && existsSync(db)) {
          let stats = "knowledge.db presente";
          try {
            const output = execFileSync(CASE_INGEST, ["stats"], {
              cwd: dir,
              encoding: "utf-8",
              timeout: 5000,
            });
            stats = output.trim();
          } catch {
            // ignore stats errors
          }
          cases.push({ name: entry, path: dir, stats });
        }
      }

      if (cases.length === 0) {
        return {
          content: [
            { type: "text", text: "Nenhum caso com knowledge.db encontrado." },
          ],
        };
      }

      const formatted = cases
        .map((c) => `${c.name} (${c.path})\n  ${c.stats}`)
        .join("\n\n");

      return {
        content: [{ type: "text", text: formatted }],
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Erro ao listar casos: ${err.message}` },
        ],
        isError: true,
      };
    }
  }
);

// Tool: case_stats
server.tool(
  "case_stats",
  "Mostra estatisticas de um caso (documentos, chunks, embeddings).",
  {
    case_dir: z
      .string()
      .describe("Nome do caso ou path absoluto"),
  },
  async ({ case_dir }) => {
    try {
      const caseDir = resolveCaseDir(case_dir);

      if (!existsSync(join(caseDir, "knowledge.db"))) {
        return {
          content: [
            {
              type: "text",
              text: `knowledge.db nao encontrado em ${caseDir}.`,
            },
          ],
          isError: true,
        };
      }

      const output = execFileSync(CASE_INGEST, ["stats"], {
        cwd: caseDir,
        encoding: "utf-8",
        timeout: 5000,
      });

      return {
        content: [{ type: "text", text: output.trim() }],
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Erro ao obter stats: ${err.message}` },
        ],
        isError: true,
      };
    }
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
