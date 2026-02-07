#!/usr/bin/env python3
"""Gemini Bridge MCP Server — Context offloading via Gemini CLI.

Zero dependencies. Implements JSON-RPC 2.0 with Content-Length framing (MCP stdio transport).
"""

import json
import sys
import subprocess
import shutil
import os
from datetime import datetime

# ---------------------------------------------------------------------------
# File-based debug logging (writes to /tmp/gemini-bridge.log)
# ---------------------------------------------------------------------------

_LOG_FILE = "/tmp/gemini-bridge.log"

def _log(msg: str) -> None:
    """Append a timestamped message to the debug log file."""
    try:
        with open(_LOG_FILE, "a") as f:
            f.write(f"[{datetime.now().isoformat()}] [PID={os.getpid()}] {msg}\n")
    except Exception:
        pass  # Never crash on logging

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
            "gemini CLI not found in PATH. Install: npm install -g @google/gemini-cli"
        )
    return path


def build_prompt(mode: str, focus: str | None = None) -> str:
    """Build the prompt string for the given exploration mode."""
    template = TEMPLATES[mode]
    focus_line = f"FOCO ADICIONAL: {focus}" if focus and mode == "onboarding" else ""
    return template.format(focus=focus or "", focus_line=focus_line)


def run_gemini(prompt: str, path: str) -> dict:
    """Execute gemini CLI in yolo mode and return structured result."""
    gemini = find_gemini()
    cmd = [
        gemini,
        "-p", prompt,
        "--yolo",
        "--output-format", "json",
    ]

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=300,
        cwd=path,
    )

    stderr = result.stderr.strip()

    if result.returncode != 0:
        return {
            "status": "error",
            "text": f"Gemini CLI error (exit {result.returncode}):\n{stderr}",
            "stderr": stderr,
        }

    # Try to extract response and stats from JSON output
    try:
        data = json.loads(result.stdout)
        response_text = data.get("response", result.stdout)
        stats = data.get("stats", {})

        # Extract tool call count from stats for validation
        tool_tokens = 0
        for model_stats in stats.get("models", {}).values():
            tool_tokens += model_stats.get("tokens", {}).get("tool", 0)

        # Check for signs of hallucination: no tool tokens = no files read
        tool_errors = [l for l in stderr.split("\n") if "Error executing tool" in l]

        return {
            "status": "completed",
            "text": response_text,
            "stats": stats,
            "tool_tokens": tool_tokens,
            "tool_errors": tool_errors,
            "stderr_summary": stderr[:500] if stderr else None,
        }
    except json.JSONDecodeError:
        return {
            "status": "completed",
            "text": result.stdout.strip(),
            "stderr_summary": stderr[:500] if stderr else None,
        }


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
    _log(f"EXPLORE called with args: {json.dumps(args)}")
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
        gemini_result = run_gemini(prompt, path)

        text = gemini_result.get("text", "")
        status = gemini_result.get("status", "unknown")

        # Build metadata footer for transparency
        meta_parts = [f"\n\n---\n_Gemini Bridge | mode: {mode} | status: {status}_"]

        if gemini_result.get("tool_errors"):
            meta_parts.append(f"_Tool errors: {'; '.join(gemini_result['tool_errors'][:5])}_")

        if gemini_result.get("stderr_summary"):
            # Only include if there's something beyond normal startup messages
            stderr = gemini_result["stderr_summary"]
            if "Error" in stderr or "error" in stderr:
                meta_parts.append(f"_Stderr: {stderr[:200]}_")

        output = text + "\n".join(meta_parts)
        is_error = status == "error"

        return {"content": [{"type": "text", "text": output}], "isError": is_error}
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
    _log("SERVER STARTED")
    _log(f"Python: {sys.version}")
    _log(f"CWD: {os.getcwd()}")
    _log(f"stdin isatty: {sys.stdin.isatty()}, stdout isatty: {sys.stdout.isatty()}")

    msg_count = 0
    while True:
        try:
            request = read_message()
            if request is None:
                _log("read_message returned None (EOF). Exiting.")
                break

            msg_count += 1
            method = request.get("method", "???")
            req_id = request.get("id", "no-id")
            _log(f"MSG #{msg_count}: method={method} id={req_id}")

            response = handle_request(request)
            if response is not None:
                write_message(response)
                _log(f"RESPONSE sent for method={method} id={req_id}")
            else:
                _log(f"No response for method={method} (notification)")

        except json.JSONDecodeError as e:
            _log(f"JSON decode error: {e}")
            continue
        except KeyboardInterrupt:
            _log("KeyboardInterrupt. Exiting.")
            break
        except Exception as e:
            _log(f"EXCEPTION: {e}")
            sys.stderr.write(f"gemini-bridge error: {e}\n")
            sys.stderr.flush()

    _log(f"SERVER EXITING after {msg_count} messages")


if __name__ == "__main__":
    main()
