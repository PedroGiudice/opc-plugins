---
name: gemini-bridge-tool-development
description: Guide for developing custom tools for the gemini-bridge MCP server. Covers tool definition, execution function, dispatcher registration, NDJSON framing, testing, and subagent integration. Use when adding new tools to the gemini-bridge server or modifying existing ones.
---

# Developing Custom Tools for gemini-bridge MCP Server

## Purpose

Guide for adding, modifying, or debugging tools in the `gemini-bridge` MCP server.
The server is a hand-rolled Node.js JSON-RPC 2.0 implementation (zero dependencies, no SDK).

## Architecture

```
~/.claude.json          -> registra "gemini-bridge" apontando para o binary
~/opc-plugins/plugins/gemini-bridge/
  server.mjs            -> MCP server (fonte canonica)
  wrapper.mjs           -> resolve ${CLAUDE_PLUGIN_ROOT} para server.mjs
  package.json          -> bin: gemini-bridge-mcp
```

**Protocolo:** JSON-RPC 2.0 sobre stdio com NDJSON (newline-delimited JSON).

**NAO usar Content-Length framing.** O Claude Code MCP client usa NDJSON:
- Leitura: busca `\n` no buffer, `JSON.parse(linha)`
- Escrita: `JSON.stringify(msg) + "\n"`

## Anatomia de uma Tool

Cada tool tem 4 partes obrigatorias:

### 1. Tool Definition (JSON Schema)

```javascript
const MY_TOOL = {
  name: "tool-name",
  description: "Descricao concisa. Claude usa isso para decidir quando chamar.",
  inputSchema: {
    type: "object",
    properties: {
      param1: { type: "string", description: "O que e este parametro" },
      param2: {
        type: "string",
        enum: ["opcao1", "opcao2"],
        description: "Opcoes validas",
      },
      optionalParam: { type: "string", description: "Opcional" },
    },
    required: ["param1", "param2"],
  },
};
```

**Regras para `description`:**
- Deve permitir ao Claude decidir QUANDO usar a tool
- Incluir modes/variantes se houver
- Maximo ~200 caracteres para nao poluir o system prompt

**Regras para `inputSchema`:**
- Sempre `type: "object"` no root
- `required` so para parametros obrigatorios
- `enum` quando ha opcoes fixas
- `description` em TODOS os parametros

### 2. Execution Function

```javascript
async function executeTool(args) {
  log(`TOOL_NAME called with args: ${JSON.stringify(args)}`);

  // Validacao de args
  const param1 = args.param1;
  if (!param1) {
    return {
      content: [{ type: "text", text: "param1 is required" }],
      isError: true,
    };
  }

  try {
    // Logica da tool
    const result = await doWork(param1);

    // Formato de retorno MCP
    return {
      content: [{ type: "text", text: result }],
      isError: false,
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `Error: ${e.message}` }],
      isError: true,
    };
  }
}
```

**Formato de retorno obrigatorio:**
```javascript
{
  content: [{ type: "text", text: "resultado como string" }],
  isError: boolean  // true se falhou
}
```

### 3. Registro no tools/list

Em `handleRequest`, adicionar ao array de tools:

```javascript
if (method === "tools/list") {
  return {
    jsonrpc: "2.0",
    id: reqId,
    result: { tools: [EXPLORE_TOOL, MY_TOOL] },
  };
}
```

### 4. Registro no dispatcher (tools/call)

No bloco `_async` do main loop, adicionar o case:

```javascript
if (response && response._async) {
  let result;
  if (response.toolName === "explore") {
    result = await executeExplore(response.args);
  } else if (response.toolName === "tool-name") {
    result = await executeTool(response.args);
  } else {
    result = {
      content: [{ type: "text", text: `Unknown tool: ${response.toolName}` }],
      isError: true,
    };
  }
  // ...
}
```

## Checklist para Nova Tool

1. Definir `const MY_TOOL = { name, description, inputSchema }`
2. Implementar `async function executeTool(args)` com validacao e try/catch
3. Adicionar `MY_TOOL` ao array em `tools/list`
4. Adicionar case no dispatcher do main loop
5. Bump version em `serverInfo`
6. Testar com NDJSON pipe (ver secao Testing)
7. `npm link` para atualizar o binary
8. `claude mcp list` para confirmar Connected
9. Se a tool precisa de subagente dedicado, criar em `~/.claude/agents/`

## Testing

### Teste manual via NDJSON pipe

```bash
# Handshake basico
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  | timeout 5 node ~/opc-plugins/plugins/gemini-bridge/server.mjs 2>/dev/null

# Fluxo completo: init + tools/list + tools/call
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"tool-name","arguments":{"param1":"valor"}}}' \
  | timeout 30 node ~/opc-plugins/plugins/gemini-bridge/server.mjs 2>/dev/null
```

### Verificar logs

```bash
tail -20 /tmp/gemini-bridge.log
```

### Verificar conexao Claude Code

```bash
# Reconstruir binary
cd ~/opc-plugins/plugins/gemini-bridge && npm link

# Testar
claude mcp list | grep gemini
```

**A tool so aparece em sessoes NOVAS.** Se adicionou uma tool mid-session,
reinicie o Claude Code para que a tool seja descoberta.

## Subagente Dedicado (Opcional)

Se a tool precisa de um subagente dedicado (como `gemini-bridge-explorer`):

```markdown
<!-- ~/.claude/agents/my-tool-agent.md -->
---
name: my-tool-agent
description: Descricao curta do que o agente faz com a tool.
tools: mcp__gemini-bridge__tool-name
---

# My Tool Agent

Voce usa `mcp__gemini-bridge__tool-name` para [proposito].

## Uso

mcp__gemini-bridge__tool-name(param1, param2)
```

**Naming da tool no Claude Code:** `mcp__gemini-bridge__<tool-name>`
O hyphen do server name e preservado. Exemplo: `mcp__gemini-bridge__explore`.

## Armadilhas Conhecidas

| Armadilha | Impacto | Prevencao |
|-----------|---------|-----------|
| Content-Length framing | Server nunca recebe mensagens | Usar NDJSON: `JSON.stringify(msg) + "\n"` |
| Tool nao aparece mid-session | Tool existe mas Claude nao ve | Reiniciar sessao apos adicionar tool |
| `isError` ausente no retorno | Claude nao sabe se falhou | Sempre incluir `isError: boolean` |
| `description` vaga | Claude chama a tool errada | Ser especifico sobre quando/como usar |
| Sem `log()` na execucao | Debug impossivel | Sempre logar args no inicio |
| Timeout sem fallback | Server trava | Sempre ter timeout + try/catch |

## Referencia: Fluxo MCP Completo

```
Claude Code MCP Client              gemini-bridge server
        |                                    |
        |-- {"method":"initialize"}\n ------>|
        |<-- {"result":{...}}\n -------------|
        |                                    |
        |-- {"method":"notifications/initialized"}\n -->|
        |   (sem resposta)                   |
        |                                    |
        |-- {"method":"tools/list"}\n ------>|
        |<-- {"result":{"tools":[...]}}\n ---|
        |                                    |
        |-- {"method":"tools/call",...}\n -->|
        |   (server executa tool)            |
        |<-- {"result":{content:[...]}}\n ---|
```

Toda mensagem e uma linha JSON terminada em `\n`. Sem headers. Sem Content-Length.
