#!/usr/bin/env node
/**
 * MCP server for Case Knowledge System (Qdrant backend).
 *
 * Scoped to the case directory where the Claude session was launched.
 * Derives case name from process.cwd() — no case_dir parameter needed.
 * If cwd is not inside a case directory, operates in listing-only mode.
 *
 * Transport: stdio (required for Claude Code plugins)
 * Dependencies: @modelcontextprotocol/sdk
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import yaml from "js-yaml";

const execFileAsync = promisify(execFile);

const CASE_INGEST = "/home/opc/case-docs/crates/case-ingest/target/release/case-ingest";
const CASES_BASE = "/home/opc/case-docs/cases";
const TIMEOUT_MS = 30_000;

/**
 * Derive case context from cwd.
 *
 * If cwd is inside CASES_BASE (e.g. /home/opc/case-docs/cases/novartis-anais-prado),
 * returns { name, dir }. Otherwise returns null (not in a case context).
 */
function detectCase() {
  const cwd = resolve(process.cwd());
  const base = resolve(CASES_BASE);

  if (!cwd.startsWith(base + "/") && cwd !== base) {
    return null;
  }

  // Extract case name: first path segment after CASES_BASE
  const relative = cwd.slice(base.length + 1);
  const caseName = relative.split("/")[0];

  if (!caseName) {
    return null;
  }

  const caseDir = join(base, caseName);

  if (!existsSync(join(caseDir, "base"))) {
    return null;
  }

  return { name: caseName, dir: caseDir };
}

const CASE = detectCase();

/**
 * Load case.yaml config (processos_relacionados, etc).
 * Read once at startup — zero overhead per query.
 */
function loadCaseConfig(caseDir) {
  const yamlPath = join(caseDir, "case.yaml");
  if (!existsSync(yamlPath)) return null;
  try {
    return yaml.load(readFileSync(yamlPath, "utf-8"));
  } catch {
    return null;
  }
}

const CASE_CONFIG = CASE ? loadCaseConfig(CASE.dir) : null;

/**
 * Run case-ingest with given args, optionally overriding the collection.
 * When collectionName is provided, passes --collection flag instead of relying on cwd.
 */
async function runCaseIngest(args, collectionName) {
  if (!CASE) {
    throw new Error("Sessao nao esta dentro de um caso. Navegue para cases/<nome> antes.");
  }
  const finalArgs = collectionName
    ? [...args, "--collection", collectionName]
    : args;
  const { stdout } = await execFileAsync(CASE_INGEST, finalArgs, {
    cwd: CASE.dir,
    timeout: TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env },
  });
  return stdout;
}

/**
 * Resolve the `casos` parameter into a list of additional collection names to search.
 * "relacionados" expands to processos_relacionados from case.yaml.
 * Explicit names are used as-is. Current case is always excluded (searched separately).
 */
function resolveCasos(casos) {
  if (!casos || casos.length === 0) return [];

  const resolved = new Set();
  for (const c of casos) {
    if (c === "relacionados") {
      const related = CASE_CONFIG?.processos_relacionados || [];
      for (const r of related) resolved.add(r);
    } else {
      resolved.add(c);
    }
  }

  // Current case is always searched via default path — don't duplicate
  if (CASE) resolved.delete(CASE.name);

  // Validate: only include cases whose directories actually exist
  return [...resolved].filter((name) => {
    const caseDir = join(CASES_BASE, name);
    return existsSync(join(caseDir, "base"));
  });
}

// --- MCP Server ---

const server = new McpServer({
  name: "case-knowledge",
  version: "0.6.0",
});

// Tool: search
server.tool(
  "search",
  "Busca semantica (dense) nos documentos do caso atual via Qdrant. " +
    "O caso e determinado automaticamente pelo diretorio da sessao. " +
    "Suporta filtros por peca processual (inicial, contestacao, acordao, etc.), " +
    "fase (conhecimento, instrucao, recursal) e documento especifico. " +
    "Resultados incluem campos cronologicos quando disponiveis: " +
    "doc_order (ordem canonica da peca no processo), " +
    "data_juntada (data real de juntada nos autos), " +
    "posicao_relativa (posicao do chunk dentro do documento, 0.0-1.0), " +
    "tipo_conteudo (peca, copia_externa, documento_pre_processual). " +
    "Use agrupar=true para diversidade de documentos nos resultados " +
    "(evita que um documento grande monopolize). " +
    "NAO usar cross-reference a menos que o usuario peca explicitamente.",
  {
    query: z.string().describe("Texto para busca em linguagem natural"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Numero maximo de resultados (default 10, max 50)"),
    peca: z
      .string()
      .optional()
      .describe(
        "Filtrar por peca processual: inicial, contestacao, replica, decisao, sentenca, " +
          "acordao, agravo, apelacao, embargos_declaracao, peticoes_diversas, documento_tecnico, integra_autos"
      ),
    fase: z
      .string()
      .optional()
      .describe("Filtrar por fase processual: conhecimento, instrucao, recursal, execucao"),
    documento: z
      .string()
      .optional()
      .describe("Filtrar por nome do documento de origem"),
    agrupar: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Agrupar resultados por documento (search_groups). " +
          "Quando true, retorna top N documentos distintos com ate 3 chunks cada, " +
          "evitando que documentos grandes monopolizem os resultados."
      ),
    casos: z
      .array(z.string())
      .optional()
      .describe(
        "Cross-reference: buscar tambem em outros casos. " +
          "Usar SOMENTE quando o usuario pedir explicitamente (ex: 'busca nos relacionados', " +
          "'veja no caso X'). Valor 'relacionados' expande para os casos listados no case.yaml. " +
          "Nomes especificos buscam naquela collection. NUNCA usar espontaneamente."
      ),
  },
  async ({ query, limit, peca, fase, documento, agrupar, casos }) => {
    try {
      const args = ["search", query, "--limit", String(limit), "--json"];
      if (peca) args.push("--peca", peca);
      if (fase) args.push("--fase", fase);
      if (documento) args.push("--documento", documento);
      if (agrupar) args.push("--group-by", "documento", "--group-size", "3");

      // Always search current case
      const searches = [
        runCaseIngest(args).then((out) => JSON.parse(out.trim())),
      ];

      // Cross-reference: search additional collections in parallel
      const extraCasos = resolveCasos(casos);
      for (const caseName of extraCasos) {
        searches.push(
          runCaseIngest(args, caseName)
            .then((out) => JSON.parse(out.trim()))
            .catch(() => []) // graceful: if a collection fails, skip it
        );
      }

      const allResults = await Promise.all(searches);

      if (agrupar) {
        // Grouped results: each item is { group_id, hits: [...] }
        const groups = allResults.flat();
        if (groups.length === 0) {
          return {
            content: [{ type: "text", text: "Nenhum resultado encontrado." }],
          };
        }
        const text = extraCasos.length > 0
          ? `Cross-reference: caso atual + [${extraCasos.join(", ")}]\n\n` +
            JSON.stringify(groups, null, 2)
          : JSON.stringify(groups, null, 2);
        return { content: [{ type: "text", text }] };
      }

      // Flat results: merge + sort by score descending + take top N
      const merged = allResults.flat().sort((a, b) => b.score - a.score);
      const results = merged.slice(0, limit);

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "Nenhum resultado encontrado." }],
        };
      }

      const text =
        extraCasos.length > 0
          ? `Cross-reference: caso atual + [${extraCasos.join(", ")}]\n\n` +
            JSON.stringify(results, null, 2)
          : JSON.stringify(results, null, 2);

      return {
        content: [{ type: "text", text }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Erro na busca: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: contexto
server.tool(
  "contexto",
  "Expande o contexto ao redor de um chunk retornado por search. " +
    "Dado um documento e chunk_index, retorna chunks vizinhos (anteriores e posteriores) " +
    "do mesmo documento em ordem sequencial. Util para ler o texto ao redor de um resultado.",
  {
    documento: z
      .string()
      .describe("Nome do documento (campo 'documento' do resultado de busca)"),
    chunk_index: z
      .number()
      .int()
      .describe("Indice do chunk central (campo 'chunk_index' do resultado de busca)"),
    janela: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(3)
      .describe("Numero de chunks antes e depois do central (default 3, max 10)"),
  },
  async ({ documento, chunk_index, janela }) => {
    try {
      if (!CASE) {
        throw new Error("Sessao nao esta dentro de um caso.");
      }
      const from = Math.max(0, chunk_index - janela);
      const to = chunk_index + janela;
      const collection = `case-${CASE.name}`;

      // Qdrant scroll with order_by — returns chunks in sequential order
      const response = await fetch(`http://localhost:6333/collections/${collection}/points/scroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filter: {
            must: [
              { key: "documento", match: { value: documento } },
              { key: "chunk_index", range: { gte: from, lte: to } },
            ],
          },
          limit: (janela * 2) + 1,
          with_payload: true,
          with_vector: false,
          order_by: { key: "chunk_index", direction: "asc" },
        }),
      });

      if (!response.ok) {
        throw new Error(`Qdrant scroll falhou: ${response.status}`);
      }

      const data = await response.json();
      const points = data.result?.points || [];

      if (points.length === 0) {
        return {
          content: [{ type: "text", text: "Nenhum chunk encontrado nessa janela." }],
        };
      }

      // Already ordered by Qdrant — just extract fields
      const sorted = points
        .map((p) => ({
          index: p.payload?.chunk_index ?? 0,
          content: p.payload?.content ?? "",
          peca: p.payload?.peca ?? null,
          doc_order: p.payload?.doc_order ?? null,
          tipo_conteudo: p.payload?.tipo_conteudo ?? null,
          data_juntada: p.payload?.data_juntada ?? null,
          posicao_relativa: p.payload?.posicao_relativa ?? null,
        }));

      const formatted = sorted
        .map((c) => {
          const marker = c.index === chunk_index ? " [CENTRAL]" : "";
          const meta = [
            c.tipo_conteudo ? `tipo:${c.tipo_conteudo}` : null,
            c.data_juntada ? `data:${c.data_juntada}` : null,
            c.posicao_relativa != null ? `pos:${(c.posicao_relativa * 100).toFixed(0)}%` : null,
          ].filter(Boolean).join(" ");
          const metaStr = meta ? ` (${meta})` : "";
          return `--- chunk ${c.index}${marker}${metaStr} ---\n${c.content}`;
        })
        .join("\n\n");

      const header = `Documento: ${documento}\nChunks ${from}-${to} (central: ${chunk_index})\n\n`;
      return {
        content: [{ type: "text", text: header + formatted }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Erro ao expandir contexto: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: stats
server.tool(
  "stats",
  "Mostra estatisticas do caso atual (pontos no Qdrant, distribuicao por peca).",
  {},
  async () => {
    try {
      const output = await runCaseIngest(["stats"]);
      return {
        content: [{ type: "text", text: output.trim() }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Erro ao obter stats: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: list_cases
server.tool(
  "list_cases",
  "Lista todos os casos disponiveis no diretorio de casos.",
  {},
  async () => {
    try {
      const entries = readdirSync(CASES_BASE);
      const cases = [];

      for (const entry of entries) {
        const dir = join(CASES_BASE, entry);
        if (statSync(dir).isDirectory() && existsSync(join(dir, "base"))) {
          const isCurrent = CASE && CASE.name === entry;
          cases.push({ name: entry, current: isCurrent });
        }
      }

      if (cases.length === 0) {
        return {
          content: [{ type: "text", text: "Nenhum caso encontrado." }],
        };
      }

      const formatted = cases
        .map((c) => `${c.current ? "* " : "  "}${c.name}`)
        .join("\n");

      const header = CASE
        ? `Caso ativo: ${CASE.name}\n\nCasos disponiveis:\n`
        : "Nenhum caso ativo (sessao fora de cases/). Casos disponiveis:\n";

      return {
        content: [{ type: "text", text: header + formatted }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Erro ao listar casos: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: info
server.tool(
  "info",
  "Mostra qual caso esta ativo nesta sessao.",
  {},
  async () => {
    if (!CASE) {
      return {
        content: [{
          type: "text",
          text: "Nenhum caso ativo. A sessao nao foi lancada dentro de cases/<nome>/.",
        }],
      };
    }
    const lines = [
      `Caso ativo: ${CASE.name}`,
      `Collection Qdrant: case-${CASE.name}`,
      `Diretorio: ${CASE.dir}`,
    ];
    if (CASE_CONFIG?.processos_relacionados?.length) {
      lines.push(`Processos relacionados: ${CASE_CONFIG.processos_relacionados.join(", ")}`);
    }
    const manifestoExists = existsSync(join(CASE.dir, "documentos.yaml"));
    lines.push(`Cronologia enriquecida: ${manifestoExists ? "sim (manifesto disponivel)" : "nao"}`);
    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  }
);

// Tool: manifesto
server.tool(
  "manifesto",
  "Retorna o indice cronologico do caso atual. " +
    "Lista documentos em ordem processual com tipo, data de juntada e numero de chunks. " +
    "Usar no inicio da sessao para entender a estrutura e cronologia do caso. " +
    "Requer que 'case-ingest enrich' e 'case-ingest manifesto' tenham sido executados.",
  {},
  async () => {
    try {
      if (!CASE) {
        return {
          content: [{
            type: "text",
            text: "Nenhum caso ativo. A sessao nao foi lancada dentro de cases/<nome>/.",
          }],
          isError: true,
        };
      }
      const yamlPath = join(CASE.dir, "documentos.yaml");
      if (!existsSync(yamlPath)) {
        return {
          content: [{
            type: "text",
            text: "Manifesto nao encontrado. Rode 'case-ingest enrich && case-ingest manifesto' primeiro.",
          }],
          isError: true,
        };
      }
      const content = readFileSync(yamlPath, "utf-8");
      return {
        content: [{ type: "text", text: content }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Erro ao ler manifesto: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
