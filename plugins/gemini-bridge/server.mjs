#!/usr/bin/env node
/**
 * Gemini Bridge MCP Server — Context offloading via Gemini CLI.
 * Pure Node.js, zero dependencies. JSON-RPC 2.0 with Content-Length framing.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { execSync } from "node:child_process";

const LOG_FILE = "/tmp/gemini-bridge.log";

function log(msg) {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [PID=${process.pid}] ${msg}\n`);
  } catch {}
}

// --- Prompt templates per exploration mode ---

const TEMPLATES = {
  onboarding: `Acione a skill gemini-assistant.

TAREFA: Mapeamento completo do projeto.
{focus_line}
INSTRUCOES:
1. Identifique diretorios principais e seu proposito
2. Liste stack tecnologica e dependencias-chave
3. Descreva entry points e fluxo de dados principal
4. Identifique padroes arquiteturais e convencoes
5. Liste pontos de atencao ou complexidade

FORMATO: Markdown denso com secoes. Bullet points, nao prosa.
Inclua arquivo:linha quando relevante.`,

  targeted: `Acione a skill gemini-assistant.

TAREFA: Analise focada.
FOCO: {focus}

INSTRUCOES:
1. Leia e analise os arquivos relevantes ao foco
2. Identifique dependencias upstream (quem chama)
3. Identifique dependencias downstream (quem e chamado)
4. Documente contratos: inputs, outputs, side effects
5. Liste edge cases e pontos de atencao
6. Se algo fora do foco parecer relevante, mencione brevemente

FORMATO: Bullet points com arquivo:linha. Denso, sem prosa.`,

  verify: `Acione a skill gemini-assistant.

TAREFA: Verificacao de funcionamento.
VERIFICAR: {focus}

INSTRUCOES:
1. Trace o fluxo completo do que esta sendo verificado
2. Identifique se a implementacao corresponde a intencao
3. Busque inconsistencias, gaps, ou paths nao cobertos
4. Compare com padroes usados em outras partes do projeto
5. Se encontrar problemas, classifique: critico / alerta / nota

FORMATO: Status (OK/PROBLEMA) por item. Evidencias com arquivo:linha.`,

  research: `Acione a skill gemini-assistant.

TAREFA: Pesquisa de padroes.
PESQUISAR: {focus}

INSTRUCOES:
1. Busque todas as ocorrencias e implementacoes relacionadas
2. Identifique o padrao dominante usado
3. Liste excecoes ao padrao (se houver)
4. Documente convencoes implicitas
5. Se existirem inconsistencias entre arquivos, reporte

FORMATO: Padrao identificado + lista de ocorrencias com arquivo:linha.`,
};

function buildPrompt(mode, focus) {
  let template = TEMPLATES[mode];
  const focusLine = focus && mode === "onboarding" ? `FOCO ADICIONAL: ${focus}` : "";
  return template.replace("{focus_line}", focusLine).replace("{focus}", focus || "");
}

// --- Gemini CLI invocation ---

function findGemini() {
  try {
    return execSync("which gemini", { encoding: "utf8" }).trim();
  } catch {
    throw new Error("gemini CLI not found in PATH. Install: npm install -g @google/gemini-cli");
  }
}

function runGemini(prompt, path) {
  return new Promise((resolve) => {
    const gemini = findGemini();
    const child = spawn(gemini, ["-p", prompt, "--yolo", "--output-format", "json"], {
      cwd: path,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 300_000,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end();

    child.on("close", (code) => {
      stderr = stderr.trim();
      if (code !== 0) {
        resolve({ status: "error", text: `Gemini CLI error (exit ${code}):\n${stderr}`, stderr });
        return;
      }
      try {
        const data = JSON.parse(stdout);
        const responseText = data.response || stdout;
        const stats = data.stats || {};
        let toolTokens = 0;
        for (const ms of Object.values(stats.models || {})) {
          toolTokens += (ms.tokens?.tool || 0);
        }
        const toolErrors = stderr.split("\n").filter((l) => l.includes("Error executing tool"));
        resolve({
          status: "completed",
          text: responseText,
          stats,
          tool_tokens: toolTokens,
          tool_errors: toolErrors,
          stderr_summary: stderr.slice(0, 500) || null,
        });
      } catch {
        resolve({ status: "completed", text: stdout.trim(), stderr_summary: stderr.slice(0, 500) || null });
      }
    });

    child.on("error", (err) => {
      resolve({ status: "error", text: `Spawn error: ${err.message}` });
    });
  });
}

// --- Tool definition ---

const EXPLORE_TOOL = {
  name: "explore",
  description:
    "Explore a codebase via Gemini CLI with context offloading. " +
    "Modes: onboarding (map project from zero), " +
    "targeted (focused analysis of specific area), " +
    "verify (check functionality/consistency), " +
    "research (find patterns across codebase).",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute directory path to explore" },
      mode: {
        type: "string",
        enum: ["onboarding", "targeted", "verify", "research"],
        description: "Exploration mode",
      },
      focus: {
        type: "string",
        description: "What to focus on. Required for targeted/verify/research. Optional for onboarding.",
      },
    },
    required: ["path", "mode"],
  },
};

// --- Tool execution ---

async function executeExplore(args) {
  log(`EXPLORE called with args: ${JSON.stringify(args)}`);
  const path = args.path || ".";
  const mode = args.mode || "onboarding";
  const focus = args.focus;

  if (!TEMPLATES[mode]) {
    return { content: [{ type: "text", text: `Unknown mode: ${mode}. Use: onboarding, targeted, verify, research` }], isError: true };
  }

  if (["targeted", "verify", "research"].includes(mode) && !focus) {
    return { content: [{ type: "text", text: `'focus' parameter required for mode '${mode}'` }], isError: true };
  }

  try {
    const prompt = buildPrompt(mode, focus);
    const result = await runGemini(prompt, path);
    const text = result.text || "";
    const status = result.status || "unknown";

    let meta = `\n\n---\n_Gemini Bridge | mode: ${mode} | status: ${status}_`;
    if (result.tool_errors?.length) {
      meta += `\n_Tool errors: ${result.tool_errors.slice(0, 5).join("; ")}_`;
    }
    if (result.stderr_summary && /[Ee]rror/.test(result.stderr_summary)) {
      meta += `\n_Stderr: ${result.stderr_summary.slice(0, 200)}_`;
    }

    return { content: [{ type: "text", text: text + meta }], isError: status === "error" };
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
}

// --- JSON-RPC 2.0 with newline-delimited JSON (MCP stdio spec) ---

function writeMessage(msg) {
  const line = JSON.stringify(msg) + "\n";
  process.stdout.write(line);
}

function handleRequest(request) {
  const method = request.method || "";
  const reqId = request.id;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: reqId,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "gemini-bridge", version: "0.3.0" },
      },
    };
  }

  if (method === "notifications/initialized") return null;

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id: reqId, result: { tools: [EXPLORE_TOOL] } };
  }

  if (method === "tools/call") {
    const params = request.params || {};
    const toolName = params.name || "";
    const args = params.arguments || {};
    // Return a promise marker — handled in main loop
    return { _async: true, toolName, args, reqId };
  }

  if (reqId !== undefined && reqId !== null) {
    return { jsonrpc: "2.0", id: reqId, error: { code: -32601, message: `Method not found: ${method}` } };
  }

  return null;
}

// --- Main loop ---

async function main() {
  log("SERVER STARTED (Node.js)");
  log(`Node: ${process.version}`);
  log(`CWD: ${process.cwd()}`);
  log(`stdin isTTY: ${process.stdin.isTTY}, stdout isTTY: ${process.stdout.isTTY}`);

  let buffer = "";
  let msgCount = 0;

  process.stdin.setEncoding("utf8");

  process.stdin.on("data", async (chunk) => {
    buffer += chunk;

    while (true) {
      // NDJSON: look for newline delimiter
      const nlIndex = buffer.indexOf("\n");
      if (nlIndex === -1) break;

      const line = buffer.slice(0, nlIndex).replace(/\r$/, "");
      buffer = buffer.slice(nlIndex + 1);

      if (!line.trim()) continue; // Skip empty lines

      try {
        const request = JSON.parse(line);
        msgCount++;
        const method = request.method || "???";
        const reqId = request.id ?? "no-id";
        log(`MSG #${msgCount}: method=${method} id=${reqId}`);

        const response = handleRequest(request);

        if (response && response._async) {
          let result;
          if (response.toolName === "explore") {
            result = await executeExplore(response.args);
          } else {
            result = { content: [{ type: "text", text: `Unknown tool: ${response.toolName}` }], isError: true };
          }
          writeMessage({ jsonrpc: "2.0", id: response.reqId, result });
          log(`RESPONSE sent for async tools/call id=${response.reqId}`);
        } else if (response) {
          writeMessage(response);
          log(`RESPONSE sent for method=${method} id=${reqId}`);
        } else {
          log(`No response for method=${method} (notification)`);
        }
      } catch (e) {
        log(`Parse/handle error: ${e.message}`);
      }
    }
  });

  process.stdin.on("end", () => {
    log(`stdin EOF. SERVER EXITING after ${msgCount} messages`);
    process.exit(0);
  });

  process.stdin.on("error", (err) => {
    log(`stdin error: ${err.message}`);
    process.exit(1);
  });
}

main();
