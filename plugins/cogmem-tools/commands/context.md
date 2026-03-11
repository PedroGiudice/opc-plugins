---
description: Retorna attention state (hot/warm) e chunks relevantes para um prompt
argument-hint: <prompt para contexto>
allowed-tools:
  - mcp__cogmem-tools__context
---

## Instrucoes

O usuario quer obter o contexto cognitivo para um prompt. Prompt: $ARGUMENTS

### Processo

1. Execute `mcp__cogmem-tools__context` com o prompt fornecido
2. Formate o resultado de forma legivel:
   - **Attention state:** conceitos ativados, turno atual
   - **Arquivos HOT** (alta relevancia) com path completo
   - **Arquivos WARM** (relevancia media) com path completo
   - **Chunks vetoriais** relevantes (conteudo truncado a 500 chars se necessario)
   - **Vector available:** se busca vetorial funcionou
3. Se nenhum resultado for retornado, informe que nao ha contexto para o prompt
4. Se houver erro de conexao, informe que o daemon cogmem pode nao estar rodando

### Formato de output

```
### Contexto cognitivo: "<prompt>"

**Turno:** N | **Vector:** disponivel/indisponivel

---

**Conceitos ativados:** conceito1, conceito2, ...

**Arquivos HOT:**
- /path/to/file1.ext
- /path/to/file2.ext

**Arquivos WARM:**
- /path/to/file3.ext

---

**Chunks relevantes** (N resultado(s))

**1.** [score: 0.033] 2026-03-05 07:14
Conteudo do chunk aqui...

**2.** [score: 0.016] 2026-02-28 15:30
Conteudo do chunk aqui...
```
