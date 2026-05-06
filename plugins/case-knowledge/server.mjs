#!/usr/bin/env node
/**
 * MCP server for Case Knowledge System.
 *
 * HTTP proxy to the case-knowledge-api Rust server.
 * Derives case name from process.cwd() when inside a cases/ directory.
 *
 * Transport: stdio (required for Claude Code plugins)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import yaml from "js-yaml";

function defaultApiBase() {
  if (process.platform === "win32") return "http://100.123.73.128:8422/api";
  return "http://127.0.0.1:8422/api";
}

function defaultCasesBase() {
  if (process.platform === "win32") return join(process.env.USERPROFILE || "C:\\Users\\pedro", "cases");
  return "/home/opc/case-docs/cases";
}

const API_BASE = process.env.CASE_KNOWLEDGE_API_BASE || defaultApiBase();
const CASES_BASE = process.env.CASE_KNOWLEDGE_CASES_BASE || defaultCasesBase();
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3;
const RETRY_DELAYS = [500, 1500, 3000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
      if (err.name === "AbortError" || attempt >= MAX_RETRIES) throw err;
      await sleep(RETRY_DELAYS[attempt] || 3000);
    }
  }
  throw lastError;
}

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

async function apiGet(path) {
  const res = await fetchWithRetry(`${API_BASE}${path}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return await res.json();
}

/**
 * Derive case context from cwd.
 * Relaxed: does NOT require base/ to exist locally (API validates collection).
 */
function detectCase() {
  const cwd = resolve(process.cwd());
  const base = resolve(CASES_BASE);

  if (!cwd.startsWith(base + sep) && cwd !== base) {
    return null;
  }

  const relative = cwd.slice(base.length + 1);
  const caseName = relative.split(sep)[0];

  if (!caseName) {
    return null;
  }

  return { name: caseName, dir: join(base, caseName) };
}

const CASE = detectCase();

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
  if (CASE) resolved.delete(CASE.name);
  return [...resolved];
}

// --- MCP Server ---

const server = new McpServer({
  name: "case-knowledge",
  version: "1.0.0",
});

// Tool: search
server.tool(
  "search",
  "Busca semantica (dense) nos documentos do caso atual via Qdrant. " +
    "O caso e determinado automaticamente pelo diretorio da sessao. " +
    "Suporta filtros por peca processual (inicial, contestacao, acordao, etc.), " +
    "fase (conhecimento, instrucao, recursal), documento especifico e " +
    "categoria (para docs nao-processuais: pesquisa, contrato, parecer, relatorio, etc.). " +
    "Resultados incluem campos cronologicos quando disponiveis: " +
    "doc_order (ordem canonica da peca no processo), " +
    "data_juntada (data real de juntada nos autos), " +
    "posicao_relativa (posicao do chunk dentro do documento, 0.0-1.0), " +
    "tipo_conteudo (peca, copia_externa, documento_pre_processual), " +
    "page_start/page_end (paginas do documento original que o chunk cobre), " +
    "parent_peca (peca-pai quando o chunk e de um anexo). " +
    "Use agrupar=true para diversidade de documentos nos resultados " +
    "(evita que um documento grande monopolize). " +
    "NAO usar cross-reference a menos que o usuario peca explicitamente.",
  {
    query: z.string().describe("Texto para busca em linguagem natural"),
    limit: z.number().int().min(1).max(50).default(10)
      .describe("Numero maximo de resultados (default 10, max 50)"),
    peca: z.string().optional()
      .describe("Filtrar por peca processual: inicial, contestacao, replica, peticao_diversa, " +
        "embargos_declaracao, agravo, apelacao, recurso_ordinario, contrarrazoes, sentenca, acordao, " +
        "decisao_interlocutoria, despacho, ato_ordinatorio, certidao, mandado, ata_audiencia, " +
        "procuracao, guia_custas, contrato, documento_pessoal, comprovante, laudo, outros_anexos"),
    parent_peca: z.string().optional()
      .describe("Filtrar por peca-pai (ex: 'p3' para anexos da peca na pagina 3). Formato: pN onde N e o numero da pagina da peca principal."),
    fase: z.string().optional()
      .describe("Filtrar por fase processual: conhecimento, instrucao, recursal, execucao"),
    documento: z.string().optional()
      .describe("Filtrar por nome do documento de origem"),
    numero_processo: z.string().optional()
      .describe("Filtrar por numero de processo CNJ (NNNNNNN-DD.YYYY.J.TR.OOOO)"),
    categoria: z.string().optional()
      .describe("Filtrar por categoria do documento (para docs nao-processuais): " +
        "pesquisa, contrato, parecer, relatorio, modelo, minuta, correspondencia, etc."),
    agrupar: z.boolean().optional().default(false)
      .describe("Agrupar resultados por documento (search_groups). " +
        "Quando true, retorna top N documentos distintos com ate 3 chunks cada, " +
        "evitando que documentos grandes monopolizem os resultados."),
    casos: z.array(z.string()).optional()
      .describe("Cross-reference: buscar tambem em outros casos. " +
        "Usar SOMENTE quando o usuario pedir explicitamente (ex: 'busca nos relacionados', " +
        "'veja no caso X'). Valor 'relacionados' expande para os casos listados no case.yaml. " +
        "Nomes especificos buscam naquela collection. NUNCA usar espontaneamente."),
  },
  async ({ query, limit, peca, parent_peca, fase, documento, numero_processo, categoria, agrupar, casos }) => {
    try {
      if (!CASE) {
        throw new Error("Sessao nao esta dentro de um caso. Navegue para cases/<nome> antes.");
      }

      const body = { query, limit, peca, parent_peca, fase, documento, numero_processo, categoria, agrupar };

      // Search current case
      const searches = [apiPost(`/cases/${CASE.name}/search`, body)];

      // Cross-reference
      const extraCasos = resolveCasos(casos);
      for (const caseName of extraCasos) {
        searches.push(
          apiPost(`/cases/${caseName}/search`, body).catch(() => ({ results: [], groups: [] }))
        );
      }

      const allResults = await Promise.all(searches);

      if (agrupar) {
        const groups = allResults.flatMap((r) => r.groups || []);
        if (groups.length === 0) {
          return { content: [{ type: "text", text: "Nenhum resultado encontrado." }] };
        }
        const text = extraCasos.length > 0
          ? `Cross-reference: caso atual + [${extraCasos.join(", ")}]\n\n${JSON.stringify(groups, null, 2)}`
          : JSON.stringify(groups, null, 2);
        return { content: [{ type: "text", text }] };
      }

      const merged = allResults.flatMap((r) => r.results || []).sort((a, b) => b.score - a.score);
      const results = merged.slice(0, limit);

      if (results.length === 0) {
        return { content: [{ type: "text", text: "Nenhum resultado encontrado." }] };
      }

      const text = extraCasos.length > 0
        ? `Cross-reference: caso atual + [${extraCasos.join(", ")}]\n\n${JSON.stringify(results, null, 2)}`
        : JSON.stringify(results, null, 2);

      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro na busca: ${err.message}` }], isError: true };
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
    documento: z.string().describe("Nome do documento (campo 'documento' do resultado de busca)"),
    chunk_index: z.number().int()
      .describe("Indice do chunk central (campo 'chunk_index' do resultado de busca)"),
    janela: z.number().int().min(1).max(10).default(3)
      .describe("Numero de chunks antes e depois do central (default 3, max 10)"),
  },
  async ({ documento, chunk_index, janela }) => {
    try {
      if (!CASE) {
        throw new Error("Sessao nao esta dentro de um caso.");
      }
      const data = await apiPost(`/cases/${CASE.name}/contexto`, {
        documento,
        chunk_index,
        janela,
      });

      const chunks = data.chunks || [];
      if (chunks.length === 0) {
        return { content: [{ type: "text", text: "Nenhum chunk encontrado nessa janela." }] };
      }

      const formatted = chunks
        .map((c) => {
          const marker = c.chunk_index === chunk_index ? " [CENTRAL]" : "";
          return `--- chunk ${c.chunk_index}${marker} ---\n${c.content}`;
        })
        .join("\n\n");

      const from = Math.max(0, chunk_index - janela);
      const to = chunk_index + janela;
      const header = `Documento: ${documento}\nChunks ${from}-${to} (central: ${chunk_index})\n\n`;
      return { content: [{ type: "text", text: header + formatted }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro ao expandir contexto: ${err.message}` }], isError: true };
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
      if (!CASE) {
        throw new Error("Sessao nao esta dentro de um caso.");
      }
      const data = await apiGet(`/cases/${CASE.name}/stats`);
      const lines = [
        `=== ${data.case_name} (${data.collection}) ===`,
        `Pontos total: ${data.total_points}`,
        "",
        "Por peca:",
        ...data.pecas.map((p) => `  ${p.peca}: ${p.count}`),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro ao obter stats: ${err.message}` }], isError: true };
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
      const data = await apiGet("/cases");
      const cases = data.cases || [];

      if (cases.length === 0) {
        return { content: [{ type: "text", text: "Nenhum caso encontrado." }] };
      }

      const formatted = cases
        .map((c) => {
          const isCurrent = CASE && CASE.name === c.name;
          return `${isCurrent ? "* " : "  "}${c.name}`;
        })
        .join("\n");

      const header = CASE
        ? `Caso ativo: ${CASE.name}\n\nCasos disponiveis:\n`
        : "Nenhum caso ativo (sessao fora de cases/). Casos disponiveis:\n";

      return { content: [{ type: "text", text: header + formatted }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro ao listar casos: ${err.message}` }], isError: true };
    }
  }
);

// Tool: info (local — reads cwd and yaml)
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
      `API: ${API_BASE}`,
    ];
    if (CASE_CONFIG?.processos_relacionados?.length) {
      lines.push(`Processos relacionados: ${CASE_CONFIG.processos_relacionados.join(", ")}`);
    }
    const manifestoExists = existsSync(join(CASE.dir, "documentos.yaml"));
    lines.push(`Cronologia enriquecida: ${manifestoExists ? "sim (manifesto disponivel)" : "nao"}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// Tool: manifesto (local — reads YAML file)
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
          content: [{ type: "text", text: "Nenhum caso ativo." }],
          isError: true,
        };
      }
      const yamlPath = join(CASE.dir, "documentos.yaml");
      if (!existsSync(yamlPath)) {
        return {
          content: [{ type: "text", text: "Manifesto nao encontrado. Rode 'case-ingest enrich && case-ingest manifesto' primeiro." }],
          isError: true,
        };
      }
      const content = readFileSync(yamlPath, "utf-8");
      return { content: [{ type: "text", text: content }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro ao ler manifesto: ${err.message}` }], isError: true };
    }
  }
);

// Tool: metadata
server.tool(
  "metadata",
  "Retorna metadados extraidos do caso atual: partes (autor/reu), advogados, " +
    "numero do processo, tipo de acao, valor da causa, contratos, pedido principal, " +
    "dispositivos de decisoes e ultimos andamentos. " +
    "Use no inicio da sessao para entender o caso.",
  {},
  async () => {
    try {
      if (!CASE) {
        throw new Error("Sessao nao esta dentro de um caso.");
      }
      const data = await apiGet(`/cases/${CASE.name}/metadata`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro ao obter metadata: ${err.message}` }], isError: true };
    }
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
