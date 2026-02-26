---
name: legal-knowledge-access
description: >
  This skill should be used when the user asks to "search legal databases",
  "find jurisprudence", "search legislation", "query STJ", "search case documents",
  "access legal knowledge base", "buscar jurisprudencia", "pesquisar legislacao",
  or when a legal agent team needs instructions on how to access knowledge bases.
  Provides complete protocols for all 4 legal knowledge bases: case-knowledge,
  stj-vec, legal-knowledge-base, and cogmem.
---

# Legal Knowledge Access

Protocolos de acesso, estrategias de query e troubleshooting para as 4 bases de
conhecimento juridico. Referencia obrigatoria para qualquer agente que precise
buscar informacao juridica.

## Bases Disponiveis

| Base | Conteudo | Tamanho | Interface |
|------|----------|---------|-----------|
| case-knowledge | Documentos do caso ativo | Por caso | MCP tool / CLI |
| stj-vec | Acordaos STJ | 13.48M chunks | HTTP API :3100 |
| legal-knowledge-base | Legislacao brasileira | 85k chunks | CLI Rust |
| cogmem | Memoria de sessoes | 2735+ chunks | Unix socket |

## Protocolos de Acesso

### 1. Case Knowledge

**MCP tool (preferivel):**
```
search_case("responsabilidade civil")
```

**CLI:**
```bash
cd ~/.claude/case-knowledge && cargo run --release -- search "responsabilidade civil"
```

**Response format:** JSON array com campos `content`, `source`, `score`, `metadata`.

**Quando usar:** questoes sobre fatos do caso, pecas processuais, provas, pericias.

### 2. STJ Jurisprudencia

**HTTP API:**
```bash
curl -s -X POST http://localhost:3100/search \
  -H "Content-Type: application/json" \
  -d '{"query":"dano moral quantum indenizatorio","limit":10}'
```

**Parametros opcionais:** `limit` (default 10, max 50).

**Response format:** JSON com array `results`, cada item tem `content`, `score`, `metadata` (numero do acordao, relator, data, turma).

**Quando usar:** fundamentacao em jurisprudencia, verificacao de posicionamento do STJ, teses consolidadas, temas repetitivos.

### 3. Legal Knowledge Base (Legislacao)

**CLI:**
```bash
cd ~/.claude/legal-knowledge-base/ingest && \
  cargo run --release -- -c legal-vec.toml search "usucapiao extraordinario"
```

**Diplomas disponiveis:** CF/88, CC/2002, CPC/2015, CPP, CP, CLT, CDC, ECA, CTN, leis esparsas.

**Response format:** texto dos chunks com score de relevancia e metadados (diploma, artigo).

**Quando usar:** texto normativo exato, fundamentacao legal, verificacao de artigos.

### 4. Cogmem (Memoria de Sessoes)

**Unix socket:**
```bash
echo '{"action":"search","params":{"query":"estrategia recursal","limit":5}}' | \
  nc -U /tmp/claude-cogmem.sock
```

**Response format:** JSON com `results` array, campos `content`, `score`, `source`.

**Quando usar:** retomar contexto de sessoes anteriores, decisoes ja tomadas, pesquisas ja feitas.

## Estrategias de Query Juridica

### Termos Tecnicos vs. Linguagem Natural

Preferir termos tecnicos juridicos nas queries:

| Em vez de | Usar |
|-----------|------|
| "prazo pra recorrer" | "prazo recursal" |
| "pagar divida" | "adimplemento obrigacional" |
| "dono do imovel" | "proprietario" ou "titular do dominio" |
| "contrato quebrado" | "inadimplemento contratual" ou "resolucao contratual" |
| "demitido sem justa causa" | "dispensa imotivada" ou "rescisao sem justa causa" |

### Sinonimos e Variantes

Executar multiplas queries quando o termo tem variantes:

```
Query 1: "responsabilidade civil objetiva"
Query 2: "responsabilidade sem culpa"
Query 3: "teoria do risco"
```

### Queries Compostas

Para temas complexos, decompor em queries atomicas:

```
Tema: "Prescricao em acao de reparacao de danos por acidente de trabalho"
Query 1: "prescricao reparacao danos" (legal-knowledge-base)
Query 2: "prescricao acidente trabalho" (STJ)
Query 3: "prazo prescricional art 7 XXIX CF" (legal-knowledge-base)
```

## Templates para Teammates

### Template: Pesquisador de Jurisprudencia

```
Voce e um pesquisador juridico especializado em jurisprudencia do STJ.

TAREFA: Pesquisar posicionamento do STJ sobre [TEMA].

ACESSO A BASE:
curl -s -X POST http://localhost:3100/search \
  -H "Content-Type: application/json" \
  -d '{"query":"[QUERY]","limit":15}'

Execute ao menos 3 queries com termos variados.

OUTPUT ESPERADO:
1. Posicao majoritaria (com numeros dos acordaos)
2. Posicoes divergentes (se houver)
3. Temas repetitivos relacionados
4. Sumulas aplicaveis
```

### Template: Pesquisador de Legislacao

```
Voce e um pesquisador juridico especializado em legislacao.

TAREFA: Localizar fundamentacao legal para [TEMA].

ACESSO A BASE:
cd ~/.claude/legal-knowledge-base/ingest && \
  cargo run --release -- -c legal-vec.toml search "[QUERY]"

Execute ao menos 2 queries. Verificar CF, codigo especifico e leis esparsas.

OUTPUT ESPERADO:
1. Dispositivos legais aplicaveis (artigo completo)
2. Hierarquia normativa entre eles
3. Alteracoes legislativas recentes (se identificaveis)
```

### Template: Antagonista (Antitese)

```
Voce e um advogado da parte contraria. Sua funcao e encontrar os MELHORES
argumentos contra a tese: [TESE].

ACESSO AS BASES:
- STJ: curl -s -X POST http://localhost:3100/search -H "Content-Type: application/json" -d '{"query":"[QUERY CONTRARIA]","limit":10}'
- Legislacao: cd ~/.claude/legal-knowledge-base/ingest && cargo run --release -- -c legal-vec.toml search "[QUERY]"

OUTPUT ESPERADO:
1. Contra-argumentos juridicos (com fundamento)
2. Jurisprudencia desfavoravel
3. Riscos processuais que a tese ignora
4. Pontos fracos da argumentacao
```

## Troubleshooting

### TEI down (embeddings)

```bash
# Verificar
curl -s localhost:8080/health

# Reiniciar
docker restart tei-bge-m3

# Fallback: queries funcionam mas com qualidade reduzida se TEI caiu
# apos a indexacao (indices ja existem)
```

### cogmem socket not found

```bash
# Verificar
ls -la /tmp/claude-cogmem.sock

# Reiniciar
systemctl --user restart cogmem

# Verificar logs
journalctl --user -u cogmem -n 20
```

### stj-vec server down

```bash
# Verificar
curl -s localhost:3100/health

# Reiniciar (verificar processo)
# O servidor roda como processo separado — consultar CLAUDE.md do projeto stj-vec
```

### legal-knowledge-base nao compilado

```bash
# Compilar
cd ~/.claude/legal-knowledge-base/ingest && cargo build --release

# Verificar toml
cat legal-vec.toml
```

## Queries SQLite3 Diretas (Bypass)

Quando as interfaces normais falham, acessar SQLite diretamente:

### cogmem

```bash
sqlite3 ~/.claude/memory/cogmem/cogmem.db \
  "SELECT content, source FROM chunks WHERE content LIKE '%termo%' LIMIT 10;"
```

### case-knowledge

```bash
# knowledge.db fica no diretorio do caso ativo
sqlite3 ~/.claude/case-knowledge/[caso]/knowledge.db \
  "SELECT content, source FROM chunks WHERE content LIKE '%termo%' LIMIT 10;"
```

### legal-knowledge-base

```bash
sqlite3 ~/.claude/legal-knowledge-base/ingest/legal-vec.db \
  "SELECT content, source FROM chunks WHERE content LIKE '%artigo%' LIMIT 10;"
```

**Nota:** queries SQLite LIKE nao usam embeddings — sao busca textual pura.
Para FTS5 (quando disponivel):

```bash
sqlite3 [db] "SELECT content, source FROM fts_chunks WHERE fts_chunks MATCH 'termo1 AND termo2' LIMIT 10;"
```

## Pipeline de Embedding (Atualizacao)

### cogmem

Gerenciado automaticamente pelo daemon. Novos chunks sao embedados via TEI na ingestao.

Para re-embedding em massa:
```bash
cd ~/.claude/memory/cogmem && python3 scripts/reembed.py
```
Usar sentence-transformers, nao TEI (TEI crashia sob carga sustentada).

### legal-knowledge-base

```bash
cd ~/.claude/legal-knowledge-base/ingest
# Adicionar novos documentos em sources/
cargo run --release -- -c legal-vec.toml ingest
```

### case-knowledge

```bash
cd ~/.claude/case-knowledge
cargo run --release -- ingest /caminho/para/novos/documentos/
```

### stj-vec

Pipeline Modal GPU para embeddings dense + sparse (BGE-M3). Consultar skill `/embedding-modal`.

## Additional Resources

### Reference Files

Para detalhes avancados sobre cada base:
- **`references/query-patterns.md`** — Padroes de query por area do direito
