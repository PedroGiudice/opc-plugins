# deep-research

MCP plugin que expoe a Gemini Deep Research API como tools nativas no Claude Code,
fechando o gap entre WebSearch raso e pesquisa agentiva profunda.

## O que faz

Pesquisa profunda real: o agente do Gemini le paginas inteiras, itera buscas,
cruza fontes e retorna relatorio citado em markdown. Util para:

- Pesquisa juridica (doutrina, jurisprudencia, legislacao)
- Comparacoes tecnicas detalhadas (frameworks, stacks, libraries)
- Analises regulatorias e mudancas legais
- Due diligence e panoramas de mercado
- Qualquer pergunta onde WebSearch retornaria snippets superficiais

## Componentes

### MCP Tools

| Tool | Descricao | Tempo tipico |
|------|-----------|--------------|
| `deep_research` | Pesquisa direta (bloqueia ate concluir) | 2-15 min |
| `deep_research_plan` | Gera plano via collaborative planning | ~30s |
| `deep_research_refine` | Refina plano existente com feedback | ~30s |
| `deep_research_execute` | Executa plano aprovado | 2-15 min |

### Agentes

| Agente | Funcao |
|--------|--------|
| `deep-researcher` | Especialista em pesquisa profunda, usa as tools MCP como motor primario |

## Modelos

| Modelo (alias) | Model ID | Perfil |
|----------------|----------|--------|
| `fast` | `deep-research-preview-04-2026` | Rapido, 2-5 min |
| `max` | `deep-research-max-preview-04-2026` | Exaustivo, 5-15 min |

## Setup

### Pre-requisitos

- Node.js 18+
- API key do Google AI Studio com tier pago (Free tier nao suporta grounding)

### Variaveis de ambiente

```bash
export GOOGLE_API_KEY="sua-key-do-google-ai-studio"
# ou
export GEMINI_API_KEY="sua-key-do-google-ai-studio"
```

### Variaveis opcionais

```bash
# Intervalo de polling em ms (default: 10000 = 10s)
export DEEP_RESEARCH_POLL_INTERVAL_MS=15000

# Timeout maximo em ms (default: 1800000 = 30 min)
export DEEP_RESEARCH_MAX_WAIT_MS=2400000
```

### Instalacao via marketplace

```
/plugin install deep-research@opc-plugins
```

Apos habilitar o plugin, as tools `mcp__plugin_deep-research_deep-research__*`
ficam disponiveis e o agente `deep-researcher` pode ser invocado via Task tool.

## Uso

### Via agente (recomendado)

```
Use o deep-researcher para fazer pesquisa profunda sobre <tema>
```

O agente automaticamente decide entre fast/max, planning/direct, e formata o output.

### Direto via tool

Pesquisa simples:
```
deep_research(query="...", model="fast")
```

Com planning:
```
1. deep_research_plan(query="...", model="max")     -> retorna plan_id
2. deep_research_execute(plan_id="...")              -> retorna relatorio
```

## Custos

Pesquisa Deep Research consome tokens do Gemini 3.1 Pro. Estimativa por chamada:

- `fast`: ~$0.10 - $0.50 por pesquisa
- `max`: ~$0.50 - $3.00 por pesquisa

Habilite Project Spend Caps no console do Google AI Studio para evitar surpresas.

## Troubleshooting

**Erro "GOOGLE_API_KEY nao definida":** exporte a variavel de ambiente antes
de iniciar o Claude Code.

**Tools nao aparecem em `/mcp`:** reinicie o Claude Code apos instalar o plugin.

**Timeout em chamadas `max`:** aumente `DEEP_RESEARCH_MAX_WAIT_MS`. Algumas
queries muito complexas podem levar 20+ minutos.

**Free tier:** nao funciona. Deep Research exige grounding (Google Search) que
e bloqueado no free tier. Migre para tier pago. Sintoma: a tool falha em runtime
com erro de permission/grounding, mesmo com `GOOGLE_API_KEY` valida — a key
existe e e aceita, mas o modelo de Deep Research nao esta liberado.

**Env vars nao chegam ao Claude Code:** se voce iniciar o Claude Code via launcher
GUI ou systemd user service, variaveis exportadas apenas no `.zshrc`/`.bashrc`
podem nao estar disponiveis ao processo. Exporte em `~/.profile` ou no unit file
do systemd, ou inicie o Claude Code a partir do shell interativo.
