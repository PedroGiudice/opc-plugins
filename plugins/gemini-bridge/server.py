#!/usr/bin/env python3
"""Gemini Bridge MCP Server — Context offloading via Gemini CLI.

Zero dependencies. Implements JSON-RPC 2.0 with Content-Length framing (MCP stdio transport).
"""

import json
import sys
import subprocess
import shutil

# ---------------------------------------------------------------------------
# Prompt templates per exploration mode
# ---------------------------------------------------------------------------

TEMPLATES = {
    "onboarding": """\
Acione a skill gemini-assistant.

TAREFA: Mapeamento completo do projeto.
{focus_line}
INSTRUCOES:
1. Identifique diretorios principais e seu proposito
2. Liste stack tecnologica e dependencias-chave
3. Descreva entry points e fluxo de dados principal
4. Identifique padroes arquiteturais e convencoes
5. Liste pontos de atencao ou complexidade

FORMATO: Markdown denso com secoes. Bullet points, nao prosa.
Inclua arquivo:linha quando relevante.""",

    "targeted": """\
Acione a skill gemini-assistant.

TAREFA: Analise focada.
FOCO: {focus}

INSTRUCOES:
1. Leia e analise os arquivos relevantes ao foco
2. Identifique dependencias upstream (quem chama)
3. Identifique dependencias downstream (quem e chamado)
4. Documente contratos: inputs, outputs, side effects
5. Liste edge cases e pontos de atencao
6. Se algo fora do foco parecer relevante, mencione brevemente

FORMATO: Bullet points com arquivo:linha. Denso, sem prosa.""",

    "verify": """\
Acione a skill gemini-assistant.

TAREFA: Verificacao de funcionamento.
VERIFICAR: {focus}

INSTRUCOES:
1. Trace o fluxo completo do que esta sendo verificado
2. Identifique se a implementacao corresponde a intencao
3. Busque inconsistencias, gaps, ou paths nao cobertos
4. Compare com padroes usados em outras partes do projeto
5. Se encontrar problemas, classifique: critico / alerta / nota

FORMATO: Status (OK/PROBLEMA) por item. Evidencias com arquivo:linha.""",

    "research": """\
Acione a skill gemini-assistant.

TAREFA: Pesquisa de padroes.
PESQUISAR: {focus}

INSTRUCOES:
1. Busque todas as ocorrencias e implementacoes relacionadas
2. Identifique o padrao dominante usado
3. Liste excecoes ao padrao (se houver)
4. Documente convencoes implicitas
5. Se existirem inconsistencias entre arquivos, reporte

FORMATO: Padrao identificado + lista de ocorrencias com arquivo:linha.""",
}

# ---------------------------------------------------------------------------
# Gemini CLI invocation
# ---------------------------------------------------------------------------

def find_gemini() -> str:
    """Locate the gemini CLI binary."""
    path = shutil.which("gemini")
    if not path:
        raise FileNotFoundError(
            "gemini CLI not found in PATH. Install: npm install -g @anthropic-ai/gemini-cli"
        )
    return path


def build_prompt(mode: str, focus: str | None = None) -> str:
    """Build the prompt string for the given exploration mode."""
    template = TEMPLATES[mode]
    focus_line = f"FOCO ADICIONAL: {focus}" if focus and mode == "onboarding" else ""
    return template.format(focus=focus or "", focus_line=focus_line)


def run_gemini(prompt: str, path: str) -> str:
    """Execute gemini CLI in plan mode and return the response text."""
    gemini = find_gemini()
    cmd = [
        gemini,
        "-p", prompt,
        "--approval-mode", "plan",
        "--output-format", "json",
        path,
    ]

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=300,
        cwd=path,
    )

    if result.returncode != 0:
        stderr = result.stderr.strip()
        return f"Gemini CLI error (exit {result.returncode}):\n{stderr}"

    # Try to extract just the response from JSON output
    try:
        data = json.loads(result.stdout)
        return data.get("response", result.stdout)
    except json.JSONDecodeError:
        # Fallback: return raw output
        return result.stdout.strip()


# ---------------------------------------------------------------------------
# Tool definition
# ---------------------------------------------------------------------------

EXPLORE_TOOL = {
    "name": "explore",
    "description": (
        "Explore a codebase via Gemini CLI with context offloading. "
        "Modes: onboarding (map project from zero), "
        "targeted (focused analysis of specific area), "
        "verify (check functionality/consistency), "
        "research (find patterns across codebase)."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Absolute directory path to explore",
            },
            "mode": {
                "type": "string",
                "enum": ["onboarding", "targeted", "verify", "research"],
                "description": "Exploration mode",
            },
            "focus": {
                "type": "string",
                "description": (
                    "What to focus on. Required for targeted/verify/research. "
                    "Optional for onboarding (adds emphasis without limiting)."
                ),
            },
        },
        "required": ["path", "mode"],
    },
}

# ---------------------------------------------------------------------------
# Tool execution
# ---------------------------------------------------------------------------

def execute_explore(args: dict) -> dict:
    """Execute the explore tool and return MCP result."""
    path = args.get("path", ".")
    mode = args.get("mode", "onboarding")
    focus = args.get("focus")

    # Validate mode
    if mode not in TEMPLATES:
        return {
            "content": [{"type": "text", "text": f"Unknown mode: {mode}. Use: onboarding, targeted, verify, research"}],
            "isError": True,
        }

    # Validate focus requirement
    if mode in ("targeted", "verify", "research") and not focus:
        return {
            "content": [{"type": "text", "text": f"'focus' parameter required for mode '{mode}'"}],
            "isError": True,
        }

    try:
        prompt = build_prompt(mode, focus)
        result = run_gemini(prompt, path)
        return {"content": [{"type": "text", "text": result}]}
    except FileNotFoundError as e:
        return {"content": [{"type": "text", "text": str(e)}], "isError": True}
    except subprocess.TimeoutExpired:
        return {"content": [{"type": "text", "text": "Gemini CLI timeout (300s exceeded)"}], "isError": True}
    except Exception as e:
        return {"content": [{"type": "text", "text": f"Error: {e}"}], "isError": True}


# ---------------------------------------------------------------------------
# JSON-RPC 2.0 with Content-Length framing (MCP stdio transport)
# ---------------------------------------------------------------------------

def read_message() -> dict | None:
    """Read a JSON-RPC message from stdin with Content-Length framing."""
    headers = {}
    while True:
        line = sys.stdin.readline()
        if not line:
            return None  # EOF
        line = line.rstrip("\r\n")
        if line == "":
            break  # End of headers
        if ":" in line:
            key, value = line.split(":", 1)
            headers[key.strip()] = value.strip()

    length = int(headers.get("Content-Length", 0))
    if length == 0:
        return None

    content = sys.stdin.read(length)
    if not content:
        return None

    return json.loads(content)


def write_message(msg: dict) -> None:
    """Write a JSON-RPC message to stdout with Content-Length framing."""
    content = json.dumps(msg)
    header = f"Content-Length: {len(content)}\r\n\r\n"
    sys.stdout.write(header)
    sys.stdout.write(content)
    sys.stdout.flush()


def handle_request(request: dict) -> dict | None:
    """Route a JSON-RPC request to the appropriate handler."""
    method = request.get("method", "")
    req_id = request.get("id")

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "gemini-bridge", "version": "0.1.0"},
            },
        }

    if method == "notifications/initialized":
        return None  # Notification — no response

    if method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"tools": [EXPLORE_TOOL]},
        }

    if method == "tools/call":
        params = request.get("params", {})
        tool_name = params.get("name", "")
        args = params.get("arguments", {})

        if tool_name == "explore":
            result = execute_explore(args)
        else:
            result = {
                "content": [{"type": "text", "text": f"Unknown tool: {tool_name}"}],
                "isError": True,
            }

        return {"jsonrpc": "2.0", "id": req_id, "result": result}

    # Unknown method
    if req_id is not None:
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        }

    return None


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main() -> None:
    """MCP server main loop: read requests, dispatch, write responses."""
    while True:
        try:
            request = read_message()
            if request is None:
                break  # EOF or connection closed

            response = handle_request(request)
            if response is not None:
                write_message(response)

        except json.JSONDecodeError:
            continue
        except KeyboardInterrupt:
            break
        except Exception as e:
            # Log to stderr (visible in debug mode), don't crash
            sys.stderr.write(f"gemini-bridge error: {e}\n")
            sys.stderr.flush()


if __name__ == "__main__":
    main()
