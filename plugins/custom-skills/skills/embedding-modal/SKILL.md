---
name: embedding-modal
description: Pipeline de embedding via Modal GPU (BGE-M3, dense + sparse). Use quando precisar gerar embeddings para o Case Knowledge System, re-embeddar documentos, ou importar embeddings no knowledge.db. Invoke via /embedding-modal.
---

# Embedding Modal - Case Knowledge System

Pipeline para gerar embeddings dense + sparse via Modal GPU (L4) usando FlagEmbedding BGE-M3.

**Siga este roteiro LITERALMENTE. Nao improvise, nao pule etapas.**

---

## Quick Reference

| Item | Valor |
|------|-------|
| Modelo | BGE-M3 (FlagEmbedding) |
| GPU | L4 ($0.80/h) |
| Dimensao dense | 1024 |
| Sparse | Lexical weights (token_id: weight) |
| Volume dados | `case-knowledge-data` |
| Volume modelo | `stj-vec-models` |
| Scripts | `/home/opc/stj-vec/tools/case-benchmark/` |
| Throughput | ~79 emb/s (L4), ~45 emb/s (T4) |
| Custo tipico | ~$0.005 por 638 chunks |

---

## Pipeline Completo (3 etapas)

### Etapa 1: Chunk Export

Transforma arquivo de texto em JSONL de chunks (max 512 tokens, overlap 64).

```bash
python3 /home/opc/stj-vec/tools/case-benchmark/01_chunk_export.py \
  <ARQUIVO_INPUT> \
  <OUTPUT_DIR>/chunks.jsonl
```

Output: JSONL com `{id, content}` por linha.

### Etapa 2: Upload + Embed no Modal

```bash
# Upload JSONL para volume Modal
modal volume put case-knowledge-data <OUTPUT_DIR>/chunks.jsonl chunks/

# Rodar embedding (L4 GPU, dense + sparse)
modal run /home/opc/stj-vec/tools/case-benchmark/02_modal_embed.py \
  --source chunks
```

Output no volume: `embeddings/chunks.{npz,json,sparse.json}`

### Etapa 3: Download + Import

```bash
# Download dos 3 arquivos
modal volume get case-knowledge-data embeddings/chunks.npz <OUTPUT_DIR>/embeddings/
modal volume get case-knowledge-data embeddings/chunks.json <OUTPUT_DIR>/embeddings/
modal volume get case-knowledge-data embeddings/chunks.sparse.json <OUTPUT_DIR>/embeddings/

# Import para knowledge.db (dense + sparse)
python3 /home/opc/stj-vec/tools/case-benchmark/03_import_embeddings.py \
  --input <OUTPUT_DIR>/embeddings \
  --db <CASE_DIR>/knowledge.db
```

---

## Estrutura do knowledge.db

Apos import, o DB contem:

| Tabela | Conteudo |
|--------|----------|
| `vec_chunks` | Virtual table sqlite-vec, KNN cosine (1024 dims) |
| `sparse_index` | Tabela invertida (token_id, chunk_id, weight) com indice em token_id |
| `chunks` | Texto dos chunks (id, doc_id, content, chunk_index) |
| `documents` | Metadados dos documentos (id, source_file) |

---

## Busca Hibrida

O MCP server `search-case` faz:

1. **Dense**: embed query via Ollama (bge-m3 local) -> KNN no vec_chunks
2. **Sparse**: tokeniza query com XLM-RoBERTa tokenizer -> lookup na sparse_index -> soma pesos
3. **Fusao**: Reciprocal Rank Fusion (RRF) com peso 50/50

Server: `/home/opc/stj-vec/tools/search-case/server.py`
Wrapper: `/home/opc/stj-vec/tools/search-case/wrapper.mjs`

---

## Parametros Importantes

| Parametro | Valor | Onde |
|-----------|-------|------|
| `GPU_CONFIG` | `"L4"` | 02_modal_embed.py |
| `BATCH_SIZE` | 128 | 02_modal_embed.py |
| `MAX_TOKENS` | 512 | 01_chunk_export.py |
| `OVERLAP_TOKENS` | 64 | 01_chunk_export.py |
| `MIN_CHUNK_TOKENS` | 30 | 01_chunk_export.py |
| `MIN_SPARSE_WEIGHT` | 0.01 | 02_modal_embed.py |
| `RRF_K` | 60 | server.py |
| `DENSE_WEIGHT` | 0.5 | server.py |
| `SPARSE_WEIGHT` | 0.5 | server.py |

---

## Troubleshooting

| Problema | Solucao |
|----------|---------|
| `modal volume get` cria arquivo em vez de dir | Baixar cada arquivo individualmente |
| Cold start lento (~15-20s) | Normal na primeira chamada, container fica quente por 120s |
| Ollama nao retorna sparse | Correto: Ollama so faz dense. Sparse vem do Modal. |
| Chunks muito pequenos ignorados | `MIN_CHUNK_TOKENS=30` filtra chunks curtos |
| OOM no Modal | Reduzir BATCH_SIZE (64, 32) antes de trocar GPU |

---

## Benchmark de Referencia (1MB legal doc, 638 chunks)

| GPU | Embed time | Total | Custo | Throughput | VRAM |
|-----|-----------|-------|-------|-----------|------|
| L4 | 8.1s | 23.4s | $0.005 | 79 emb/s | 2.5GB/22GB |
| T4 | 14.3s | 30.2s | $0.005 | 45 emb/s | 2.5GB/14.6GB |
