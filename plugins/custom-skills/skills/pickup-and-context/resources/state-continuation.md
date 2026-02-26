# Continuacao de Estado Entre Sessoes

Padroes da Anthropic para manter estado e permitir que Claude retome trabalho de onde parou.

---

## Principio: Estado Explicito, Nao Implicito

A documentacao da Anthropic para tarefas longas enfatiza: "save your current progress and state to memory before the context window refreshes". O mesmo principio se aplica entre sessoes -- o estado deve ser salvo de forma explicita e recuperavel.

## Tres Formas de Estado

### 1. Estado Estruturado (dados)
Informacao que pode ser parseada por codigo. Usar JSON, tabelas, ou formatos maquina-legivel.

**Quando usar:** status de tasks, metricas, configuracoes

```json
{
  "plan": "docs/plans/2026-02-08-sdk-reporter.md",
  "tasks_complete": [1, 2, 3, 4],
  "current_task": 5,
  "branch": "work/session-20260208-060435",
  "last_test_result": "pass",
  "blockers": []
}
```

### 2. Estado Narrativo (contexto)
Informacao que requer interpretacao. Usar prosa densa em Markdown.

**Quando usar:** decisoes, justificativas, problemas encontrados

```markdown
O reporter estava enviando `"content"` no POST mas o daemon esperava
`"response_text"`. Corrigido alinhando com o schema AnalysisRun do DuckDB.
Essa inconsistencia causou 3 sessoes de debugging ate ser identificada.
```

### 3. Estado Implicito (no codebase)
Informacao que vive no codigo e nao precisa ser documentada -- apenas referenciada.

**Quando usar:** implementacoes, testes, configs

```markdown
Ver implementacao em `src/main.rs:extract_report_metadata()` para detalhes.
```

## Padrao "Review Before Act"

A Anthropic recomenda explicitamente que ao retomar trabalho, Claude deve primeiro revisar o estado antes de agir:

```markdown
## O que fazer

1. **Leia** o contexto detalhado: `docs/contexto/DDMMYYYY-slug.md`
2. **Leia** o plano: `docs/plans/YYYY-MM-DD-feature.md`
3. **Verifique** o ambiente: `cargo build && cargo test`
4. **Retome** na Task N do plano
```

Essa sequencia "ler -> verificar -> agir" evita que a nova sessao assuma coisas incorretas sobre o estado do sistema.

## Git Como Checkpoint

Commits sao a forma mais robusta de estado implicito. O documento de contexto deve sempre listar os commits recentes:

```
e99597d feat(reporter): dotenv, opus alias, primeiro report Opus executado
9925045 fix: alinhar payload reporter com schema AnalysisRun
```

Se algo der errado, a nova sessao pode fazer `git log` e `git diff` para reconstruir o contexto.

## Evitar Duplicacao de Estado

Regra: cada pedaco de informacao deve viver em UM lugar.

| Informacao | Onde Vive | No Prompt |
|------------|-----------|-----------|
| Implementacao | Codigo fonte | Referenciar path |
| Decisoes | Doc de contexto | Resumir 1 frase |
| Tasks | Plano em docs/plans/ | Apontar task atual |
| Config | .env, Cargo.toml | Nao documentar |
| Metricas | Doc de contexto | Tabela |
