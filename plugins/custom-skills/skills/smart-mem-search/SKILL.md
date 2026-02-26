---
name: smart-mem-search
description: Busca inteligente na memoria com multiplas queries e refinamento automatico. Use para buscas complexas, explorar topicos amplos, ou quando /mem-search simples nao encontrou. Keywords: deep search, busca profunda, explorar memoria, investigar historico, smart search
---

# Smart Memory Search

Busca avancada com multiplas queries, refinamento e sintese. Para quando uma unica busca nao basta.

## Execucao OBRIGATORIA

Voce DEVE executar os comandos abaixo via Bash. NAO tente "lembrar" sozinho.

### Passo 1: Gerar 3 queries complementares

A partir do pedido do usuario, formule 3 queries com angulos diferentes:
- Query 1: termos diretos do pedido
- Query 2: sinonimos ou termos relacionados
- Query 3: contexto mais amplo ou consequencias

### Passo 2: Executar as 3 buscas

```bash
echo '{"action":"search","query":"QUERY 1","limit":5,"threshold":0.3}' | timeout 5 nc -U /tmp/claude-cogmem.sock
echo '{"action":"search","query":"QUERY 2","limit":5,"threshold":0.3}' | timeout 5 nc -U /tmp/claude-cogmem.sock
echo '{"action":"search","query":"QUERY 3","limit":5,"threshold":0.3}' | timeout 5 nc -U /tmp/claude-cogmem.sock
```

### Passo 3: Deduplicar e sintetizar

- Remover chunks duplicados (mesmo id)
- Ordenar por score
- Sintetizar uma resposta coerente

### Passo 4: Refinamento (se necessario)

Se os resultados nao cobrem o pedido, gerar queries adicionais baseadas nos chunks encontrados (termos que apareceram nos resultados podem guiar novas buscas).

## Exemplo

Usuario: "o que decidimos sobre o pipeline de voz?"

Queries geradas:
1. "decisao pipeline voz audio STT TTS"
2. "whisper kokoro piper voice sidecar"
3. "benchmark transcricao sintese fala"

## Apresentacao

Apresentar como narrativa sintetizada, nao como lista de chunks:

```
Baseado em 12 memorias de 3 sessoes (21-22/02):

**Pipeline de voz - decisoes:**
- STT: whisper.cpp via whisper-server (warm), modelo large-v3-turbo
- TTS: Kokoro-82M (substituiu Piper)
- Refinamento: Claude sonnet pos-STT para pontuacao

**Contexto:** benchmarks mostraram whisper.cpp 32% mais rapido que faster-whisper...
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
