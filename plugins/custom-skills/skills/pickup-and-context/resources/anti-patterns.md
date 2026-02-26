# Anti-Padroes em Prompts de Retomada

Erros comuns que reduzem a eficacia de documentos de contexto e prompts de retomada, com correcoes baseadas na documentacao da Anthropic.

---

## 1. Prompt Generico ("Fizemos varias coisas")

**Problema:** Contexto vago forca a nova sessao a gastar tokens redescobrindo o que foi feito.

**Ruim:**
```markdown
Na sessao anterior trabalhamos no reporter e corrigimos alguns bugs.
Continue o trabalho.
```

**Bom:**
```markdown
Na sessao anterior: (1) corrigimos payload do reporter -- campo `content`
renomeado para `response_text` para alinhar com schema AnalysisRun,
(2) adicionamos dotenvy para .env, (3) primeiro report Opus executado
com sucesso ($10.31, 653K tokens).

Retomar na Task 5 do plano: `docs/plans/2026-02-08-sdk-reporter.md`
```

**Principio Anthropic:** "Seja explicito e direto. Nao presuma que o modelo inferira suas intencoes a partir de prompts vagos."

---

## 2. Prompt Sem Proximos Passos

**Problema:** O documento de contexto registra o que foi feito mas o prompt nao diz o que fazer. A nova sessao fica sem direcao.

**Ruim:**
```markdown
## Contexto
<paragrafos detalhados sobre o que foi feito>

## Arquivos
<lista de arquivos>
```

**Bom:**
```markdown
## Contexto rapido
<1 paragrafo>

## Proximos passos (por prioridade)
### 1. Atualizar estimated_itpm()
<instrucoes exatas>
### 2. Implementar run_query
<instrucoes exatas>
```

**Principio Anthropic:** "Focus on incremental progress -- making steady advances on a few things at a time."

---

## 3. Copiar Arquivos Inteiros

**Problema:** Desperdicar tokens copiando codigo que ja existe no filesystem. A nova sessao pode ler os arquivos.

**Ruim:**
```markdown
Aqui esta o conteudo completo de main.rs:
```rust
// 200 linhas de codigo
```
```

**Bom:**
```markdown
Ver `memory/claude-reporter/src/main.rs` -- funcao principal `run_agent()`
(linha ~80) faz o loop de tool use. Funcao `extract_report_metadata()`
(linha ~150) parseia o markdown do report.
```

**Excecao:** Snippets de interface/contrato (payloads JSON, schemas) DEVEM ser incluidos porque definem como componentes se comunicam.

---

## 4. Omitir Pendencias

**Problema:** A nova sessao nao sabe o que ficou incompleto e pode assumir que tudo esta pronto.

**Ruim:**
```markdown
O reporter esta funcionando. O frontend consome os dados.
```

**Bom:**
```markdown
O reporter esta funcionando. O frontend consome os dados, MAS:
1. **query_text nao e parseado** -- campos period/model/tokens/cost retornam vazios
2. **estimated_itpm() desatualizado** -- usa 30K mas Tier 2 permite 60K
3. **--thinking flag nao implementada** -- unica feature do design doc pendente
```

**Principio Anthropic:** Salvar estado completo, incluindo o que falta, nao apenas o que foi feito.

---

## 5. Ignorar Plano Existente

**Problema:** Se ha um plano em `docs/plans/`, o prompt cria instrucoes redundantes em vez de apontar para o plano.

**Ruim:**
```markdown
## Proximos passos
1. Criar o endpoint...
2. Implementar a tool...
3. Testar com Haiku...
(repetindo tasks que ja estao no plano)
```

**Bom:**
```markdown
## Proximos passos
Continuar plano: `docs/plans/2026-02-08-sdk-reporter.md`
Progresso: Tasks 1-4 completas. Retomar Task 5 (run_query tool).
```

---

## 6. Prosa Onde Dados Cabem Melhor

**Problema:** Informacao estruturada escrita como texto corrido e mais dificil de processar.

**Ruim:**
```markdown
Modificamos o main.rs para adicionar dotenvy e extract_metadata,
o tools.rs nao mudou, criamos o .env com a API key e o .gitignore
para protege-lo.
```

**Bom:**
```markdown
| Arquivo | Status |
|---------|--------|
| `src/main.rs` | +dotenvy, +extract_metadata |
| `src/tools.rs` | Sem mudanca |
| `.env` | Criado (API key, gitignored) |
```

**Principio Anthropic:** Use formatos estruturados (tabelas, JSON, listas) para dados. Reserve prosa para narrativa e justificativas.

---

## 7. Prompt Sem Comandos de Verificacao

**Problema:** A nova sessao nao sabe como confirmar que o ambiente esta funcional antes de comecar a trabalhar.

**Ruim:**
```markdown
(fim do prompt sem secao de verificacao)
```

**Bom:**
```markdown
## Como verificar
```bash
cargo build --release 2>&1 | tail -1  # deve mostrar "Finished"
curl -s http://localhost:3939/api/health  # deve retornar {"status":"ok"}
```
```

Se os comandos falham, a sessao sabe que precisa resolver o ambiente antes de avancar nas tasks.
