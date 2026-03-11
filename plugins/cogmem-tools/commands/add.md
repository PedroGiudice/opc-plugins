---
description: Adiciona conteudo a memoria cognitiva para recuperacao futura
argument-hint: <conteudo para memorizar>
allowed-tools:
  - mcp__cogmem-tools__insert
---

## Instrucoes

O usuario quer adicionar conteudo a memoria cognitiva. Conteudo: $ARGUMENTS

### Processo

1. Execute `mcp__cogmem-tools__insert` com o conteudo fornecido
2. Confirme a insercao com a mensagem retornada pelo daemon
3. Sugira verificacao: "Verifique com `/cogmem-tools:search <termos-chave>`"

### Formato de output

```
Conteudo inserido na memoria cognitiva.

Mensagem: <resposta do daemon>

Para verificar, use: /cogmem-tools:search <termos relevantes do conteudo>
```

### Notas

- O session_id e gerado automaticamente (formato: mcp-manual-TIMESTAMP)
- O token_count e estimado automaticamente (chars/4)
- Se houver erro de conexao, informe que o daemon cogmem pode nao estar rodando
