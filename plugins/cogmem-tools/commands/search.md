---
description: Busca na memoria cognitiva de sessoes anteriores
argument-hint: <query de busca>
allowed-tools:
  - mcp__cogmem-tools__search
---

## Instrucoes

O usuario quer buscar na memoria cognitiva. Query: $ARGUMENTS

### Processo

1. Execute `mcp__cogmem-tools__search` com a query fornecida (limit: 5)
2. Formate o resultado de forma legivel:
   - Para cada chunk retornado, mostre:
     - **Score RRF** (valores tipicos: 0.01-0.03)
     - **Data** (timestamp formatado como data legivel)
     - **Sessao** (session_id resumido)
     - **Conteudo** (texto do chunk, truncado a 500 chars se necessario)
   - No final, indique total de resultados e range de scores
3. Se nenhum resultado for retornado, informe que nao ha memoria sobre o tema
4. Se houver erro de conexao, informe que o daemon cogmem pode nao estar rodando

### Formato de output

```
### Resultados da busca: "<query>"

**N resultado(s)** | Scores: X.XXX - Y.YYY

---

**1.** [score: 0.033] 2026-03-05 07:14
Conteudo do chunk aqui...

**2.** [score: 0.016] 2026-02-28 15:30
Conteudo do chunk aqui...
```
