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

Protocolos de acesso, estratégias de query e troubleshooting para as bases de
conhecimento jurídico. Referência obrigatória para qualquer agente que precise
buscar informação jurídica.

> **Acesso é por MCP tools dos plugins** — não por comandos de shell. As tools
> funcionam tanto na VM quanto na cmr-002 (plugins instalados via marketplace
> `opc-plugins`). Os antigos caminhos por `curl`/`cargo`/`nc`/`sqlite3` estão
> **desativados**: o servidor STJ `:3100` e o TEI `:8080` não existem mais, o
> embedding hoje é ONNX in-process, e os dados migraram de SQLite para Qdrant.

## Bases Disponíveis

| Base | Conteúdo | Plugin MCP |
|------|----------|------------|
| case-knowledge | Documentos do caso ativo (resolvido pelo cwd) | `case-knowledge` |
| stj-vec | Acórdãos do STJ | `stj-vec-tools` |
| legal-knowledge-base | Legislação brasileira | `legal-vec-tools` |
| cogmem | Memória de sessões | `cogmem-tools` |
| doutrina | Livros/textos (archive.org) | skill `/archive-search` |

## Protocolos de Acesso

### 1. Case Knowledge (documentos do caso ativo)

Plugin `case-knowledge`. Resolve o caso pelo **cwd** (a sessão precisa estar
dentro de `cases/<slug>/`). Faz proxy para a `case-knowledge-api`
(`127.0.0.1:8422` na VM; `100.123.73.128:8422` via Tailscale na cmr-002), sobre
as collections `case-{slug}` no Qdrant.

**Orientação do caso:** `metadata` (partes, valores, andamentos), `manifesto`
(índice cronológico), `stats` (distribuição por peça), `facet(key)` (contagem
de qualquer campo), `info`, `list_cases`.

**Busca:** `search` — busca semântica DENSE (batch até 20 queries; filtros
`peca`, `parent_peca`, `fase`, `documento`, `numero_processo`, `categoria`;
`agrupar=true` diversifica). Especializadas: `buscar_interseccao` (dois temas
juntos), `buscar_cronologico` (reordena por posição processual),
`buscar_diversificado` (panorama por documentos), `recommend`
(mais-como-este), `discover` (direção de X evitando Y), `comparar`
(duplicatas/argumentos repetidos), `cross_ref(kind, value)` (onde mais os
autos citam um processo/súmula/tema/dispositivo).

**Leitura na íntegra:** o `content` do search é PREVIEW (1200 chars).
`contexto(documento, chunk_index, janela)` — vizinhança completa;
`document(documento, from_chunk?)` — a peça INTEIRA em ordem sequencial.
Citação/transcrição exigem íntegra lida por uma dessas duas.

**Memória do caso:** `memoria_search` — sessões anteriores DESTE caso
(legal-cogmem). A memória também é injetada automaticamente a cada prompt
(hook). Fora de um caso, só `list_cases` opera; as demais retornam erro.

**Quando usar:** fatos do caso, peças processuais, provas, perícias.
Protocolo completo de leitura: skill `leitura-autos`.

### 2. STJ Jurisprudência

Plugin `stj-vec-tools`.

- `stj-vec-tools:search` — busca densa
- `stj-vec-tools:search_formula` — busca com re-rank jurídico (boost por seção/citação); preferir para fundamentação
- `stj-vec-tools:filters` — valores de filtro válidos (ministro, classe, órgão julgador, ano)
- `stj-vec-tools:document` — acórdão completo por `doc_id`

**Response:** itens com `content`, `score`, metadados (número do acórdão, relator,
data, órgão julgador).

**Quando usar:** fundamentação jurisprudencial, posicionamento do STJ, teses
consolidadas, temas repetitivos.

### 3. Legal Knowledge Base (Legislação)

Plugin `legal-vec-tools`.

- `legal-vec-tools:search` — busca por dispositivo ou tema
- `legal-vec-tools:document` — dispositivo específico por `doc_id`

**Diplomas:** CF/88, CC/2002, CPC/2015, CPP, CP, CLT, CDC, ECA, CTN e leis esparsas.

**Quando usar:** texto normativo exato, fundamentação legal, verificação de artigos.

### 4. Cogmem (Memória de Sessões)

Plugin `cogmem-tools`.

- `cogmem-tools:search` — sessões anteriores, decisões, pesquisas já feitas
- `cogmem-tools:context` — attention state + chunks relevantes

**Quando usar:** retomar contexto de trabalho anterior. Para memória **do caso**,
usar `case-knowledge:memoria_search` (é por-caso).

### 5. Doutrina (archive-search)

Skill `/archive-search` — livros e textos no archive.org. Usar para fundamentação
doutrinária e obras clássicas.

## Estratégias de Query Jurídica

### Termos Técnicos vs. Linguagem Natural

Preferir termos técnicos jurídicos nas queries:

| Em vez de | Usar |
|-----------|------|
| "prazo pra recorrer" | "prazo recursal" |
| "pagar dívida" | "adimplemento obrigacional" |
| "dono do imóvel" | "proprietário" ou "titular do domínio" |
| "contrato quebrado" | "inadimplemento contratual" ou "resolução contratual" |
| "demitido sem justa causa" | "dispensa imotivada" ou "rescisão sem justa causa" |

### Sinônimos e Variantes

Executar múltiplas queries quando o termo tem variantes:

```
Query 1: "responsabilidade civil objetiva"
Query 2: "responsabilidade sem culpa"
Query 3: "teoria do risco"
```

O overlap lexical entre a pergunta e o texto-fonte é baixo no jurídico — busca
puramente literal falha. Expandir siglas e sinônimos é regra, não exceção.

### Queries Compostas (decomposição)

Para temas complexos, decompor em queries atômicas, cada uma na base certa:

```
Tema: "Prescrição em ação de reparação de danos por acidente de trabalho"
Query 1: legal-vec-tools:search       "prescrição reparação de danos"
Query 2: stj-vec-tools:search_formula "prescrição acidente de trabalho"
Query 3: legal-vec-tools:search       "prazo prescricional art 7 XXIX CF"
```

Decomposição multi-perspectiva (explodir a pergunta em ângulos complementares e
cruzar resultados) supera uma única reformulação.

## Templates para Teammates

### Template: Pesquisador de Jurisprudência

```
Você é um pesquisador jurídico especializado em jurisprudência do STJ.

TAREFA: Pesquisar posicionamento do STJ sobre [TEMA].

ACESSO À BASE (MCP tools):
- stj-vec-tools:search_formula  (preferir; re-rank jurídico)
- stj-vec-tools:filters         (para descobrir ministro/classe/órgão)
- stj-vec-tools:document        (acórdão completo por doc_id)

Execute ao menos 3 queries com termos variados.

OUTPUT ESPERADO:
1. Posição majoritária (com números dos acórdãos)
2. Posições divergentes (se houver)
3. Temas repetitivos relacionados
4. Súmulas aplicáveis
```

### Template: Pesquisador de Legislação

```
Você é um pesquisador jurídico especializado em legislação.

TAREFA: Localizar fundamentação legal para [TEMA].

ACESSO À BASE (MCP tools):
- legal-vec-tools:search    (busca por dispositivo/tema)
- legal-vec-tools:document  (dispositivo por doc_id)

Execute ao menos 2 queries. Verificar CF, código específico e leis esparsas.

OUTPUT ESPERADO:
1. Dispositivos legais aplicáveis (artigo completo)
2. Hierarquia normativa entre eles
3. Alterações legislativas recentes (se identificáveis)
```

### Template: Antagonista (Antítese)

```
Você é um advogado da parte contrária. Sua função é encontrar os MELHORES
argumentos contra a tese: [TESE].

ACESSO ÀS BASES (MCP tools):
- STJ: stj-vec-tools:search_formula "[QUERY CONTRÁRIA]"
- Legislação: legal-vec-tools:search "[QUERY]"

OUTPUT ESPERADO:
1. Contra-argumentos jurídicos (com fundamento)
2. Jurisprudência desfavorável
3. Riscos processuais que a tese ignora
4. Pontos fracos da argumentação
```

## Troubleshooting

As bases são MCP tools — não há serviço de shell para reiniciar. Se uma tool
falhar:

1. **Reportar a falha** ao operador (qual tool, qual erro retornado).
2. **Oferecer alternativa**: outra base relevante, busca web, ou pedir o texto
   ao operador.
3. **Nunca** cair para `curl`/`cargo run`/`nc`/`sqlite3` da VM — esses caminhos
   estão desativados e não funcionam na cmr-002.
4. **Nunca** preencher a lacuna com memória. "Não localizei na base" é resposta
   legítima e preferível a fabricar.

Se o plugin não aparecer na sessão, confirmar que o marketplace `opc-plugins`
está instalado e o plugin habilitado (`case-knowledge`, `stj-vec-tools`,
`legal-vec-tools`, `cogmem-tools`).

## Additional Resources

### Reference Files

- **`references/query-patterns.md`** — Padrões de query por área do direito
