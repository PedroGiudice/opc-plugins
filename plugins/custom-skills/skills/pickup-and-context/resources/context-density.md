# Densidade de Contexto

Como escrever documentos de contexto que sejam densos o suficiente para preservar conhecimento, sem desperdicar tokens.

---

## Principio: Densidade Sobre Verbosidade

A documentacao oficial da Anthropic enfatiza que Claude funciona melhor com informacao concisa e estruturada do que com texto longo e repetitivo. Cada frase no documento de contexto deve carregar informacao unica.

### Teste de densidade

Para cada paragrafo, pergunte: "Se eu remover isso, a proxima sessao perde informacao critica?" Se nao, remover.

## O Que Incluir (Sempre)

### Decisoes arquiteturais
Decisoes sao a informacao de maior valor. Sem elas, a proxima sessao pode refazer trabalho ou tomar decisoes conflitantes.

**Ruim:**
```
Discutimos sobre usar Python ou Rust e decidimos por Rust.
```

**Bom:**
```
Decisao: Rust em vez de Python para o reporter.
Motivo: precisa rodar como cron job, startup rapido, sem runtime.
Alternativa descartada: Python com anthropic SDK -- mais simples mas
startup de 2s inaceitavel para hook.
```

### Estado exato dos arquivos
Tabelas sao mais densas que prosa para esse tipo de informacao.

```markdown
| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src/main.rs` | Modificado | +dotenvy, +extract_metadata |
| `src/tools.rs` | Sem mudanca | -- |
| `.env` | Criado | API key, gitignored |
```

### Numeros e metricas
Dados quantitativos perdem-se facilmente em prosa. Usar tabelas ou listas.

```markdown
| Metrica | Valor |
|---------|-------|
| Tokens input | 653K |
| Custo | $10.31 |
| Tempo | 692s |
```

### Pendencias com prioridade
Cada pendencia e um ponto de decisao para a proxima sessao.

```markdown
1. **Atualizar rate limits** (alta) -- Tier 2 ativo, estimated_itpm() desatualizado
2. **--thinking flag** (baixa) -- unica feature nao implementada do design doc
```

## O Que Excluir (Sempre)

- **Tentativas falhas triviais** -- "tentei X, nao funcionou, tentei Y" so importa se a falha e instrutiva
- **Codigo completo** -- referenciar o arquivo, nao copiar. Excecao: snippets de config/payload que definem interfaces
- **Contexto obvio do codebase** -- se a informacao esta no CLAUDE.md ou README, nao repetir
- **Historico de conversa** -- o documento de contexto nao e transcricao

## Formato de Snippets

Incluir snippets APENAS quando definem interfaces ou contratos entre componentes:

```json
// Payload que o reporter envia ao daemon -- ESTE snippet e essencial
{
  "id": "sdk-report-{timestamp}",
  "mode": "sdk_report",
  "response_text": "markdown do report"
}
```

Nao incluir snippets de implementacao interna -- a proxima sessao pode ler o arquivo.
