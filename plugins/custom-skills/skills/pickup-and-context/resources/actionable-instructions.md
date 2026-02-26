# Instrucoes Acionaveis

Como escrever a secao de "proximos passos" de um prompt de retomada de forma que a nova sessao possa comecar a trabalhar imediatamente.

---

## Principio: Diga O Que Fazer, Nao O Que Pensar

A documentacao da Anthropic e explicita: Claude responde melhor a instrucoes diretas e especificas do que a descricoes vagas. "Seja direto" (Be Direct) e o principio central.

### Ruim (vago, descritivo)
```
Precisamos melhorar o sistema de rate limiting do reporter.
```

### Bom (acionavel, especifico)
```
Em `memory/claude-reporter/src/anthropic.rs`, funcao `estimated_itpm()`:
- Opus/Sonnet: 30K -> 60K
- Haiku: 50K -> 100K
Isso reduz delays proativos pela metade.
```

## Anatomia de um Passo Acionavel

Cada passo deve conter:

1. **Onde** -- arquivo e funcao/secao exata
2. **O que** -- a mudanca concreta
3. **Por que** -- motivacao em uma frase (para contexto de decisao)
4. **Como verificar** -- comando ou criterio de sucesso

```markdown
### 1. Adicionar endpoint run_query ao daemon

**Onde:** `memory/claude-memory/src/transport/http.rs`
**O que:** Novo handler `POST /api/query` que aceita `{sql: "SELECT ..."}` read-only
**Por que:** Dar ao agente reporter capacidade de SQL direto no DuckDB
**Verificar:** `curl -X POST http://localhost:3939/api/query -d '{"sql":"SELECT count(*) FROM chunks"}'`
```

## Ordenacao por Prioridade

A Anthropic recomenda "focus on incremental progress". Os passos devem estar ordenados por:

1. **Bloqueadores** -- coisas que impedem outros passos
2. **Alta prioridade** -- maior impacto, menor esforco
3. **Media prioridade** -- importante mas nao urgente
4. **Baixa prioridade / futuro** -- nice-to-have

Numerar explicitamente. Nao usar bullets para proximos passos -- a ordem importa.

## Referenciar Planos Existentes

Se existe um plano em `docs/plans/`, o prompt NAO deve reescrever as tasks. Deve apontar para o plano e indicar o progresso:

```markdown
## Proximos passos

Continuar execucao do plano: `docs/plans/2026-02-08-sdk-reporter-agent-design.md`

**Progresso atual:** Tasks 1-4 completas. Retomar na Task 5 (Tool run_query).
**Ultima verificacao:** `cargo test` passando, 0 warnings.
```

## Comandos de Verificacao

Todo prompt de retomada deve terminar com comandos que a nova sessao pode executar para confirmar que o ambiente esta funcional:

```markdown
## Como verificar

```bash
# Build
cd ~/.claude/memory/claude-reporter && cargo build --release

# Testar reporter
./target/release/claude-reporter --days 1 --dry-run

# Verificar daemon
curl -s http://localhost:3939/api/analyses?mode=sdk_report | head -5
```
```

Esses comandos servem como "smoke test" -- se passam, o ambiente esta pronto.
