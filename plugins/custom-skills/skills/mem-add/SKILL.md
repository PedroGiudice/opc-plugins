---
name: mem-add
description: Adicionar manualmente conteudo a memoria vetorial. Use quando quiser salvar uma decisao, descoberta, ou informacao importante para sessoes futuras. Keywords: remember this, save this, memorize, adicionar memoria, guardar, lembrar
---

# Memory Add

Adiciona conteudo ao banco de memoria vetorial via cogmem daemon.

## Execucao OBRIGATORIA

Voce DEVE executar o comando abaixo via Bash. NAO tente salvar de outra forma.

```bash
echo '{"action":"insert","session_id":"manual-add","content":"CONTEUDO AQUI","repo_path":"/caminho/do/repo","token_count":0}' | timeout 10 nc -U /tmp/claude-cogmem.sock
```

Substitua:
- `CONTEUDO AQUI` pelo texto a salvar (escape aspas com \")
- `/caminho/do/repo` pelo repo atual (usar $PWD ou CLAUDE_PROJECT_DIR)

## Formato Recomendado para Conteudo

Para melhor recuperacao semantica:

```
[TIPO: decisao|descoberta|padrao|bug|solucao]
[CONTEXTO: breve contexto]
[CONTEUDO: informacao principal]
```

### Exemplo

```bash
echo '{"action":"insert","session_id":"manual-add","content":"[TIPO: decisao] [CONTEXTO: escolha de STT engine] [CONTEUDO: Decidimos usar whisper.cpp via whisper-server (warm) com modelo large-v3-turbo. Motivo: 32% mais rapido que faster-whisper em CPU, pontuacao automatica, robusto a ruido externo.]","repo_path":"/home/opc/.claude","token_count":50}' | timeout 10 nc -U /tmp/claude-cogmem.sock
```

## Verificacao

Apos inserir, confirmar com busca:

```bash
echo '{"action":"search","query":"termos do conteudo inserido","limit":1}' | timeout 5 nc -U /tmp/claude-cogmem.sock
```

## Se o Socket Nao Existir

```bash
pgrep -f cogmem || nohup ~/.claude/memory/cogmem/target/release/cogmem > /tmp/cogmem.log 2>&1 &
sleep 1
```

## Arquitetura

- **Daemon:** cogmem (Rust), socket Unix em /tmp/claude-cogmem.sock
- **Embeddings:** BGE-M3 (1024 dimensoes) via OCI Ollama
- **Storage:** SQLite + sqlite-vec (cosine similarity)
- Conteudo fica disponivel em todas as sessoes futuras
