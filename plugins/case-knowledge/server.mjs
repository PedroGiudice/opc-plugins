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
import { memoriaSearch } from "./memoria.mjs";

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
    query: z.union([z.string(), z.array(z.string()).min(1).max(20)])
      .describe("Texto para busca em linguagem natural. " +
        "Aceita string (1 query) ou array de strings (batch de ate 20 queries em uma chamada). " +
        "Use array quando precisar de varias buscas relacionadas — paraleliza server-side e economiza round trips."),
    limit: z.number().int().min(1).max(50).default(10)
      .describe("Numero maximo de resultados por query (default 10, max 50)"),
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

      const isBatch = Array.isArray(query);
      const body = { query, limit, peca, parent_peca, fase, documento, numero_processo, categoria, agrupar };

      // Batch mode: 1 chamada na API com array de queries (Qdrant search_batch nativo).
      // Cross-reference em batch nao e suportado.
      if (isBatch) {
        if (casos && casos.length > 0) {
          throw new Error("Cross-reference (casos) nao e suportado em batch. Use uma query por vez.");
        }
        const data = await apiPost(`/cases/${CASE.name}/search`, body);
        if (!data.batch || data.batch.length === 0) {
          return { content: [{ type: "text", text: "Nenhum resultado encontrado." }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(data.batch, null, 2) }] };
      }

      // Single mode (mantem cross-reference)
      const searches = [apiPost(`/cases/${CASE.name}/search`, body)];
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

// Tool: memoria_search
server.tool(
  "memoria_search",
  "Busca na MEMORIA DAS SESSOES de trabalho deste caso (decisoes, raciocinio, " +
    "o que ja foi feito) — legal-cogmem. Diferente de `search`, que busca nos " +
    "DOCUMENTOS do caso (autos, contratos). Use para perguntas como 'o que ja " +
    "decidimos sobre X neste caso?'.",
  {
    query: z.string().min(3).describe("Pergunta em linguagem natural"),
    limit: z.number().int().min(1).max(20).optional()
      .describe("Max resultados (default 5)"),
    days: z.number().int().min(1).optional()
      .describe("Janela temporal em dias (default 30)"),
    threshold: z.number().min(0).max(1).optional()
      .describe("Score minimo (default do daemon)"),
  },
  async (params) => {
    try {
      if (!CASE) {
        throw new Error("Sessao nao esta dentro de um caso. Navegue para cases/<nome> antes.");
      }
      const text = await memoriaSearch(params, CASE);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro na busca de memoria: ${err.message}` }], isError: true };
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

// Tool: recommend
server.tool(
  "recommend",
  "Dado chunk_ids de resultados relevantes (positivos) e opcionalmente irrelevantes (negativos), " +
    "encontra chunks vetorialmente similares aos positivos e diferentes dos negativos. " +
    "Util para expandir resultados de busca, encontrar mais do mesmo tipo de conteudo, " +
    "ou refinar uma pesquisa a partir de exemplos. " +
    "Aceita batch via 'queries' — multiplas combinacoes positive/negative em uma chamada (Qdrant recommend_batch).",
  {
    positive: z.array(z.string()).optional()
      .describe("Chunk IDs relevantes (single mode). Use isto OU 'queries', nao ambos."),
    negative: z.array(z.string()).optional()
      .describe("Chunk IDs irrelevantes (single mode, opcional)"),
    queries: z.array(z.object({
      positive: z.array(z.string()).min(1),
      negative: z.array(z.string()).optional().default([]),
    })).max(20).optional()
      .describe("Batch mode: ate 20 pares positive/negative em uma chamada. " +
        "Use quando precisar de varios recommends relacionados — paraleliza server-side."),
    peca: z.string().optional()
      .describe("Filtrar por peca processual"),
    limit: z.number().int().min(1).max(20).default(5)
      .describe("Numero maximo de resultados por query (default 5, max 20)"),
  },
  async ({ positive, negative, queries, peca, limit }) => {
    try {
      if (!CASE) {
        throw new Error("Sessao nao esta dentro de um caso.");
      }
      const isBatch = Array.isArray(queries) && queries.length > 0;
      if (!isBatch && (!positive || positive.length === 0)) {
        throw new Error("Forneca 'positive' (single) ou 'queries' (batch).");
      }

      const body = { limit };
      if (peca) body.peca = peca;
      if (isBatch) {
        body.queries = queries;
      } else {
        body.positive = positive;
        if (negative && negative.length > 0) body.negative = negative;
      }

      const res = await fetchWithRetry(`${API_BASE}/cases/${CASE.name}/recommend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
      const data = await res.json();

      if (isBatch) {
        return {
          content: [{ type: "text", text: JSON.stringify(data.batch, null, 2) }],
        };
      }

      const lines = data.map(
        (r) =>
          `[${r.score.toFixed(3)}] chunk_id=${r.chunk_id} ci:${r.chunk_index} ` +
          `peca=${r.peca || "?"} | ${r.content.slice(0, 200)}...`
      );
      return {
        content: [
          { type: "text", text: lines.join("\n\n") || "Nenhum resultado." },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Erro no recommend: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: facet — analytics nativa de payload
server.tool(
  "facet",
  "Conta valores distintos em um campo do payload (Qdrant facet API). " +
    "Util para perguntas tipo 'quantos chunks de cada peca', 'quais documentos existem', " +
    "'distribuicao de fases processuais'. Suporta filtro por peca para escopear.",
  {
    key: z.string().describe("Campo do payload (peca, fase, documento, sistema_assinatura, etc.)"),
    limit: z.number().int().min(1).max(200).default(50)
      .describe("Numero maximo de valores distintos retornados"),
    peca: z.string().optional().describe("Filtrar por peca antes de contar"),
  },
  async ({ key, limit, peca }) => {
    try {
      if (!CASE) throw new Error("Sessao nao esta dentro de um caso.");
      const data = await apiPost(`/cases/${CASE.name}/facet`, { key, limit, peca });
      const lines = data.hits.map((h) => `${h.value}: ${h.count}`);
      return { content: [{ type: "text", text: lines.join("\n") || "Nenhum valor encontrado." }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro no facet: ${err.message}` }], isError: true };
    }
  }
);

// Tool: comparar — search_matrix_pairs (detecta duplicatas, similaridade)
server.tool(
  "comparar",
  "Calcula similaridade entre amostra de chunks do caso (Qdrant search_matrix_pairs). " +
    "Util para: detectar duplicatas/copias, encontrar argumentos repetidos entre pecas, " +
    "comparar inicial vs replica para identificar pontos rebatidos vs incontroversos. " +
    "Retorna pares (a, b, score) ordenados por similaridade.",
  {
    sample: z.number().int().min(10).max(1000).default(200)
      .describe("Numero de pontos amostrados para comparacao (default 200)"),
    limit: z.number().int().min(1).max(100).default(20)
      .describe("Numero de pares mais similares a retornar"),
    peca: z.string().optional().describe("Restringir comparacao a uma peca"),
    documento: z.string().optional().describe("Restringir comparacao a um documento"),
  },
  async ({ sample, limit, peca, documento }) => {
    try {
      if (!CASE) throw new Error("Sessao nao esta dentro de um caso.");
      const data = await apiPost(`/cases/${CASE.name}/comparar`, { sample, limit, peca, documento });
      const lines = data.pairs.map((p) => `[${p.score.toFixed(3)}] ${p.a} <-> ${p.b}`);
      return { content: [{ type: "text", text: lines.join("\n") || "Nenhum par encontrado." }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro no comparar: ${err.message}` }], isError: true };
    }
  }
);

// Tool: discover — busca guiada por contexto positive/negative
server.tool(
  "discover",
  "Busca guiada por pares de exemplos (positive_target, negative_target) (Qdrant discover API). " +
    "Diferente de recommend (busca similar a positivos), o discover busca NA DIRECAO positiva, " +
    "EVITANDO a negativa. Use para desambiguacao: ex 'argumentos da Autora, NAO da Re'. " +
    "Cada par define uma direcao semantica; o resultado e influenciado por todos os pares.",
  {
    target: z.string().optional()
      .describe("Query alvo (texto que sera embedado) OU chunk_id especifico"),
    target_chunk_id: z.string().optional()
      .describe("Chunk_id especifico como alvo (alternativa a target). Use se ja tem o chunk."),
    context_pairs: z.array(z.tuple([z.string(), z.string()])).min(1).max(10)
      .describe("Lista de pares [positive_chunk_id, negative_chunk_id]. " +
        "Cada par define uma direcao: o positivo eh o que voce quer, o negativo o que evita."),
    peca: z.string().optional().describe("Filtrar resultados por peca"),
    limit: z.number().int().min(1).max(20).default(5),
  },
  async ({ target, target_chunk_id, context_pairs, peca, limit }) => {
    try {
      if (!CASE) throw new Error("Sessao nao esta dentro de um caso.");
      const body = { context_pairs, limit };
      if (peca) body.peca = peca;
      if (target_chunk_id) body.target_chunk_id = target_chunk_id;
      else if (target) body.target_query = target;

      const data = await apiPost(`/cases/${CASE.name}/discover`, body);
      const lines = data.map(
        (r) => `[${r.score.toFixed(3)}] ci:${r.chunk_index} peca=${r.peca || "?"} | ${r.content.slice(0, 200)}...`
      );
      return { content: [{ type: "text", text: lines.join("\n\n") || "Nenhum resultado." }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro no discover: ${err.message}` }], isError: true };
    }
  }
);

// Tool: buscar_cronologico — recall amplo + rerank cronologico
server.tool(
  "buscar_cronologico",
  "Busca semantica com rerank cronologico (Qdrant Query API com prefetch). " +
    "Stage 1: recall amplo por similaridade (default 100 candidatos). " +
    "Stage 2: reordena por data_juntada (mais recentes primeiro). " +
    "Use quando precisa dos chunks mais RECENTES sobre um tema, nao apenas os mais SIMILARES. " +
    "Ex: 'argumentos sobre tutela em ordem cronologica de juntada'.",
  {
    query: z.string().describe("Texto da busca semantica"),
    recall_limit: z.number().int().min(20).max(500).default(100)
      .describe("Tamanho do recall amplo (default 100)"),
    limit: z.number().int().min(1).max(50).default(10)
      .describe("Numero final de resultados apos rerank"),
    peca: z.string().optional(),
    order_field: z.enum(["doc_order", "posicao_relativa", "chunk_index"]).default("doc_order")
      .describe("Campo de ordenacao (precisa range index): " +
        "doc_order (ordem canonica do documento — proxy cronologico), " +
        "posicao_relativa (posicao do chunk dentro do doc, 0.0-1.0), " +
        "chunk_index (indice sequencial). " +
        "Nao aceita data_juntada (indexada como Keyword)."),
    ascending: z.boolean().default(false)
      .describe("Ordem crescente (default false = mais recentes primeiro)"),
  },
  async ({ query, recall_limit, limit, peca, order_field, ascending }) => {
    try {
      if (!CASE) throw new Error("Sessao nao esta dentro de um caso.");
      const data = await apiPost(`/cases/${CASE.name}/buscar_cronologico`, {
        query, recall_limit, limit, peca, order_field, ascending,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
    }
  }
);

// Tool: buscar_interseccao — chunks que aparecem nos top de DUAS queries
server.tool(
  "buscar_interseccao",
  "Busca por intersecao semantica de DUAS queries (Qdrant Query API com prefetch). " +
    "Stage 1: top N candidatos para query_a. " +
    "Stage 2: re-rankeia esses candidatos pela query_b. " +
    "Resultado: chunks que aparecem bem nas DUAS queries. " +
    "MUITO mais preciso que filtrar resultados de uma busca simples por outro tema. " +
    "Ex: 'tutela de urgencia' + 'danos materiais' = chunks que tratam dos DOIS topicos juntos, " +
    "nao chunks que mencionam um e tangenciam o outro.",
  {
    query_a: z.string().describe("Primeira query (recall amplo)"),
    query_b: z.string().describe("Segunda query (rerank dos candidatos da query_a)"),
    recall_limit: z.number().int().min(20).max(500).default(100)
      .describe("Tamanho do recall amplo na query_a"),
    limit: z.number().int().min(1).max(50).default(10)
      .describe("Numero final de resultados"),
    peca: z.string().optional(),
  },
  async ({ query_a, query_b, recall_limit, limit, peca }) => {
    try {
      if (!CASE) throw new Error("Sessao nao esta dentro de um caso.");
      const data = await apiPost(`/cases/${CASE.name}/buscar_interseccao`, {
        query_a, query_b, recall_limit, limit, peca,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
    }
  }
);

// Tool: buscar_diversificado — recall amplo + groups (1 chunk por grupo)
server.tool(
  "buscar_diversificado",
  "Busca semantica com diversificacao por documento/peca (Qdrant Query API com query_groups). " +
    "Stage 1: recall amplo. " +
    "Stage 2: agrupa por campo (default 'documento'), retorna 1 chunk por grupo. " +
    "Garante diversidade — evita que um documento grande monopolize os resultados. " +
    "Diferente de search agrupar=true (one-stage), aqui o recall e mais amplo. " +
    "Ex: 'inadimplemento contratual' diversificado = N documentos distintos que tratam do tema.",
  {
    query: z.string().describe("Texto da busca"),
    recall_limit: z.number().int().min(50).max(500).default(200)
      .describe("Tamanho do recall amplo (default 200)"),
    groups: z.number().int().min(1).max(30).default(10)
      .describe("Numero de grupos distintos retornados"),
    chunks_per_group: z.number().int().min(1).max(5).default(1)
      .describe("Chunks por grupo (default 1 — maxima diversidade)"),
    group_by: z.enum(["documento", "peca"]).default("documento")
      .describe("Campo de agrupamento (default documento)"),
    peca: z.string().optional(),
  },
  async ({ query, recall_limit, groups, chunks_per_group, group_by, peca }) => {
    try {
      if (!CASE) throw new Error("Sessao nao esta dentro de um caso.");
      const data = await apiPost(`/cases/${CASE.name}/buscar_diversificado`, {
        query, recall_limit, groups, chunks_per_group, group_by, peca,
      });
      return { content: [{ type: "text", text: JSON.stringify(data.groups, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
    }
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
