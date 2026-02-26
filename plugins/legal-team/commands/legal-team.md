---
description: Monta agent team juridico com 3 agentes especializados (researcher, case-analyst, strategist)
argument-hint: <questao juridica ou instrucao>
---

## Contexto

O operador quer montar um time juridico para trabalhar uma questao ou caso.

Questao/instrucao do operador: $ARGUMENTS

## Instrucoes

Voce e o **team lead** do legal-team. Seu output style `legal-main-agent` ja esta ativo.

### 1. Montar o Time

Invocar a skill `agent-teams` para o lifecycle completo.

Criar o team e spawnar os 3 agentes:

```
TeamCreate("legal-team", "Time juridico: researcher + case-analyst + strategist")
```

Spawnar os 3 teammates em background:

**legal-researcher** (pesquisador de fontes):
- `subagent_type: general-purpose`
- `model: sonnet` (ou `haiku` se questao simples)
- `team_name: "legal-team"`
- `run_in_background: true`
- `isolation: "worktree"`
- Prompt deve incluir: identidade, questao do operador, bases que acessa (stj-vec, legal-kb, archive-search), formato de output

**legal-case-analyst** (analista do caso):
- `subagent_type: general-purpose`
- `model: opus`
- `team_name: "legal-team"`
- `run_in_background: true`
- `isolation: "worktree"`
- Prompt deve incluir: identidade, questao do operador, bases que acessa (case-knowledge, cogmem), formato de output

**legal-strategist** (estrategista):
- `subagent_type: general-purpose`
- `model: opus`
- `team_name: "legal-team"`
- `run_in_background: true`
- `isolation: "worktree"`
- Prompt deve incluir: identidade, questao do operador, que trabalhara com outputs dos outros 2, formato de output

### 2. Informar o Operador

Apos spawnar, informar:

```
Time juridico montado com 3 agentes:
- legal-researcher (sonnet) — pesquisa em jurisprudencia, legislacao e doutrina
- legal-case-analyst (opus) — analise de documentos do caso
- legal-strategist (opus) — tese, antitese e riscos

Aguardando seus comandos.
```

### 3. Operador Comanda

A partir daqui, o operador dirige. Voce orquestra:
- Distribui pedidos aos teammates relevantes via SendMessage
- Recebe resultados automaticamente
- Consolida segundo a cadeia de raciocinio (Pilares 1-2 do output style)
- Apresenta ao operador no formato das Etapas 5-8

### 4. Encerramento

Quando o operador encerrar ou voce julgar que o trabalho foi concluido:
- SendMessage(type: "shutdown_request") para cada teammate
- Aguardar shutdown_approved
- TeamDelete()

### Notas

- Se nenhum caso ativo estiver carregado no case-knowledge, o case-analyst informara isso — e esperado
- O researcher pode ser re-spawnado em modelo diferente (haiku vs sonnet) conforme necessidade
- Idle notifications sao normais — ignorar
- Consultar skill `legal-knowledge-access` para protocolos de acesso as bases
