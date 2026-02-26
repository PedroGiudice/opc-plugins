---
name: mem-search
description: Buscar na memoria vetorial de sessoes passadas. Use quando perguntar sobre trabalho anterior, implementacoes passadas, decisoes tomadas, ou historico do projeto. Keywords: remember, recall, last time, before, history, what did we, how did we, lembrar, historico, memoria
---

# Memory Search

Busca semantica no historico de sessoes via cogmem (Rust daemon + sqlite-vec).

## Execucao OBRIGATORIA

Voce DEVE executar o comando abaixo via Bash. NAO tente "lembrar" sozinho. NAO use Grep em arquivos. A memoria esta no banco vetorial, acessivel APENAS via socket.

```bash
echo '{"action":"search","query":"TERMOS DE BUSCA","limit":5,"threshold":0.3}' | timeout 5 nc -U /tmp/claude-cogmem.sock
```

Substitua `TERMOS DE BUSCA` pela query semantica. Use linguagem natural, nao keywords soltas.

## Parametros

| Parametro | Default | Descricao |
|-----------|---------|-----------|
| query | obrigatorio | Busca semantica (linguagem natural) |
| limit | 5 | Max resultados |
| threshold | 0.3 | Score minimo (0.0-1.0, cosine similarity) |
| repo_path | null | Filtrar por repo (ex: "/home/opc/.claude") |
| days | 30 | Periodo em dias |

## Estrategias de Busca

Se a primeira query retornar poucos resultados, tente:

1. **Reformular** -- termos diferentes, mais genericos ou mais especificos
2. **Abaixar threshold** -- `"threshold":0.2` para resultados mais distantes
3. **Aumentar limit** -- `"limit":10` para mais candidatos
4. **Remover repo_path** -- buscar em todos os repos
5. **Aumentar days** -- `"days":90` para periodo maior

## Exemplo de queries boas

```
"decisao sobre banco de dados vetorial"
"bug no hook cogmem JSON multiline"
"benchmark whisper.cpp vs faster-whisper CPU"
"como configuramos auto-update no Tauri"
```

## Apresentacao dos Resultados

1. Agrupar por relevancia (score mais alto primeiro)
2. Mostrar data e sessao de origem
3. Resumir em vez de colar dados brutos
4. Destacar a informacao que o usuario pediu

## Se a Busca Falhar (Connection Refused / Timeout)

Cogmem roda via systemd user service. Reiniciar com:

```bash
systemctl --user restart cogmem
sleep 2
# Tentar novamente
```

Se systemd nao estiver disponivel (fallback manual):

```bash
pkill -f 'release/cogmem' 2>/dev/null; sleep 1
rm -f /tmp/claude-cogmem.sock /tmp/claude-cogmem.pid
nohup ~/.claude/memory/cogmem/target/release/cogmem > /tmp/cogmem.log 2>&1 &
sleep 2
```

## Arquitetura

- **Daemon:** cogmem (Rust), socket Unix em /tmp/claude-cogmem.sock
- **Embeddings:** BGE-M3 (1024 dimensoes) via Ollama local (OLLAMA_URL override)
- **Storage:** SQLite + sqlite-vec (cosine similarity)
- **Chunks:** ~300 tokens por chunk, capturados automaticamente a cada sessao
