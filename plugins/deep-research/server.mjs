#!/usr/bin/env node
/**
 * MCP server for Gemini Deep Research API.
 *
 * Tools:
 *   deep_research          - direct research (blocking, returns full report)
 *   deep_research_plan     - generate research plan, returns {plan_id, plan}
 *   deep_research_refine   - refine existing plan with feedback
 *   deep_research_execute  - execute approved plan, returns full report
 *
 * Transport: stdio
 * Models: deep-research-preview-04-2026 (fast), deep-research-max-preview-04-2026 (max)
 *
 * Required env: GOOGLE_API_KEY or GEMINI_API_KEY
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

const MODELS = {
  fast: "deep-research-preview-04-2026",
  max: "deep-research-max-preview-04-2026",
};

const POLL_INTERVAL_MS = parseInt(process.env.DEEP_RESEARCH_POLL_INTERVAL_MS || "10000", 10);
const MAX_WAIT_MS = parseInt(process.env.DEEP_RESEARCH_MAX_WAIT_MS || "1800000", 10); // 30 min

function getApiKey() {
  const key = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GOOGLE_API_KEY ou GEMINI_API_KEY não está definida no ambiente.");
  }
  return key;
}

function getClient() {
  return new GoogleGenAI({ apiKey: getApiKey() });
}

function extractText(interaction) {
  if (!interaction.outputs || !Array.isArray(interaction.outputs)) return "";
  return interaction.outputs
    .filter((o) => o && typeof o.text === "string" && o.text.length > 0)
    .map((o) => o.text)
    .join("\n\n");
}

function extractUsage(interaction) {
  const u = interaction.usage;
  if (!u) return null;
  const parts = [];
  if (u.input_tokens != null) parts.push(`input=${u.input_tokens}`);
  if (u.output_tokens != null) parts.push(`output=${u.output_tokens}`);
  if (u.total_thought_tokens != null) parts.push(`thoughts=${u.total_thought_tokens}`);
  if (u.total_tokens != null) parts.push(`total=${u.total_tokens}`);
  return parts.length ? parts.join(", ") : null;
}

async function pollUntilDone(client, interactionId) {
  const start = Date.now();
  // small initial delay so the first poll doesn't hit immediately
  await new Promise((r) => setTimeout(r, 2000));

  while (true) {
    if (Date.now() - start > MAX_WAIT_MS) {
      throw new Error(`Timeout: pesquisa excedeu ${MAX_WAIT_MS / 1000}s`);
    }
    const interaction = await client.interactions.get(interactionId);
    const status = interaction.status;
    if (status === "completed") {
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.error(`[deep-research] concluído em ${elapsed}s`);
      const usage = extractUsage(interaction);
      if (usage) console.error(`[deep-research] usage: ${usage}`);
      return interaction;
    }
    if (status === "failed") {
      const err = interaction.error || "unknown error";
      throw new Error(`Pesquisa falhou: ${typeof err === "string" ? err : JSON.stringify(err)}`);
    }
    if (status === "cancelled") {
      throw new Error("Pesquisa cancelada.");
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

function resolveModel(modelArg) {
  const m = (modelArg || "fast").toLowerCase();
  if (!(m in MODELS)) {
    throw new Error(`Modelo inválido: '${modelArg}'. Use 'fast' ou 'max'.`);
  }
  return MODELS[m];
}

async function doResearch({ query, model }) {
  const client = getClient();
  const agent = resolveModel(model);
  console.error(`[deep-research] research start: ${agent}`);
  const created = await client.interactions.create({
    agent,
    input: query,
    background: true,
    store: true,
  });
  console.error(`[deep-research] interaction_id: ${created.id}`);
  const interaction = await pollUntilDone(client, created.id);
  return { interaction_id: created.id, text: extractText(interaction) };
}

async function doPlan({ query, model }) {
  const client = getClient();
  const agent = resolveModel(model);
  console.error(`[deep-research] plan start: ${agent}`);
  const created = await client.interactions.create({
    agent,
    input: query,
    agent_config: { type: "deep-research", collaborative_planning: true },
    background: true,
    store: true,
  });
  const interaction = await pollUntilDone(client, created.id);
  return { plan_id: created.id, plan: extractText(interaction) };
}

async function doRefine({ plan_id, feedback, model }) {
  const client = getClient();
  const agent = resolveModel(model);
  console.error(`[deep-research] refine start (prev: ${plan_id})`);
  const created = await client.interactions.create({
    agent,
    input: feedback,
    agent_config: { type: "deep-research", collaborative_planning: true },
    previous_interaction_id: plan_id,
    background: true,
    store: true,
  });
  const interaction = await pollUntilDone(client, created.id);
  return { plan_id: created.id, plan: extractText(interaction) };
}

async function doExecute({ plan_id, model }) {
  const client = getClient();
  const agent = resolveModel(model);
  console.error(`[deep-research] execute start (plan: ${plan_id})`);
  const created = await client.interactions.create({
    agent,
    input: "Proceda com a pesquisa conforme o plano aprovado.",
    agent_config: { type: "deep-research", collaborative_planning: false },
    previous_interaction_id: plan_id,
    background: true,
    store: true,
  });
  console.error(`[deep-research] interaction_id: ${created.id}`);
  const interaction = await pollUntilDone(client, created.id);
  return { interaction_id: created.id, text: extractText(interaction) };
}

function asMcpResult(payload) {
  // For research/execute results: return the report text directly so the
  // assistant sees the report, with a small JSON header suffix for traceability.
  if (typeof payload?.text === "string") {
    const header = `<!-- interaction_id: ${payload.interaction_id} -->\n\n`;
    return { content: [{ type: "text", text: header + payload.text }] };
  }
  // For plan/refine results: return a JSON-ish text response so the assistant
  // can parse plan_id easily.
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function asMcpError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: `[deep-research] erro: ${msg}` }],
  };
}

const server = new McpServer(
  { name: "deep-research", version: "0.1.1" },
  { capabilities: { tools: {} } }
);

const modelSchema = z.enum(["fast", "max"]).optional().describe(
  "Modelo: 'fast' (deep-research-preview, 2-5 min) ou 'max' (deep-research-max, 5-15 min, mais profundo). Padrão: fast."
);

server.registerTool(
  "deep_research",
  {
    description:
      "Pesquisa profunda agentiva via Gemini Deep Research. O agente lê páginas inteiras, itera buscas, cruza fontes e retorna relatório citado em markdown. Bloqueia até concluir (2-15 min conforme modelo). Use para perguntas que exijam síntese multi-fonte, jurisprudência, doutrina, comparações técnicas, ou qualquer pesquisa onde WebSearch retornaria snippets rasos.",
    inputSchema: {
      query: z
        .string()
        .min(10)
        .describe("Pergunta de pesquisa. Quanto mais específica, melhor o resultado."),
      model: modelSchema,
    },
  },
  async ({ query, model }) => {
    try {
      const result = await doResearch({ query, model });
      return asMcpResult(result);
    } catch (err) {
      console.error("[deep-research] research error:", err);
      return asMcpError(err);
    }
  }
);

server.registerTool(
  "deep_research_plan",
  {
    description:
      "Gera plano de pesquisa via collaborative planning (~30s). Retorna {plan_id, plan}. Permite revisar a estratégia antes de gastar tempo/tokens da pesquisa completa. Use para queries críticas onde o ângulo importa. Depois use deep_research_refine para ajustar ou deep_research_execute para rodar.",
    inputSchema: {
      query: z
        .string()
        .min(10)
        .describe("Pergunta de pesquisa para a qual o plano será gerado."),
      model: modelSchema,
    },
  },
  async ({ query, model }) => {
    try {
      const result = await doPlan({ query, model });
      return asMcpResult(result);
    } catch (err) {
      console.error("[deep-research] plan error:", err);
      return asMcpError(err);
    }
  }
);

server.registerTool(
  "deep_research_refine",
  {
    description:
      "Refina plano de pesquisa existente com feedback. Retorna novo {plan_id, plan}. Use após deep_research_plan quando o plano inicial precisar de ajuste de escopo, foco ou ângulo.",
    inputSchema: {
      plan_id: z
        .string()
        .min(1)
        .describe("ID retornado por deep_research_plan ou deep_research_refine anterior."),
      feedback: z
        .string()
        .min(5)
        .describe("Instruções de ajuste ao plano (ex: 'foque mais em X, ignore Y, adicione fontes de Z')."),
      model: modelSchema,
    },
  },
  async ({ plan_id, feedback, model }) => {
    try {
      const result = await doRefine({ plan_id, feedback, model });
      return asMcpResult(result);
    } catch (err) {
      console.error("[deep-research] refine error:", err);
      return asMcpError(err);
    }
  }
);

server.registerTool(
  "deep_research_execute",
  {
    description:
      "Executa plano de pesquisa aprovado. Bloqueia até retornar relatório completo (2-15 min conforme modelo). Use após deep_research_plan ou deep_research_refine.",
    inputSchema: {
      plan_id: z
        .string()
        .min(1)
        .describe("ID do plano a executar (retornado por deep_research_plan ou deep_research_refine)."),
      model: modelSchema,
    },
  },
  async ({ plan_id, model }) => {
    try {
      const result = await doExecute({ plan_id, model });
      return asMcpResult(result);
    } catch (err) {
      console.error("[deep-research] execute error:", err);
      return asMcpError(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[deep-research] MCP server pronto");
