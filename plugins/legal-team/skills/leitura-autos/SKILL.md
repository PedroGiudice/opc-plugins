---
name: leitura-autos
description: >
  Use quando precisar ler, compreender ou qualificar os autos de um caso —
  "ler os autos", "entender o caso", "o que aconteceu no processo",
  "qualifica o caso", "em que fase esta", "resume o processo", "leitura
  estruturada", "read the case files". Protocolo operacional de leitura em
  ordem processual usando as tools do case-knowledge (metadata, manifesto,
  search com filtro peca, document, contexto, buscar_cronologico). Tambem
  quando um subagente ou peca depender de compreensao previa dos autos.
---

# Leitura de Autos

Autos tem ordem narrativa. Ler fora de ordem e ler capitulos aleatorios de um
livro: voce entende palavras, perde o sentido. Este protocolo transforma a
regra em execucao com as tools certas.

**Regra transversal:** o `content` do `search` e PREVIEW. Compreensao, citacao
e transcricao exigem integra — `document` (peca inteira) ou `contexto`
(vizinhanca de um chunk). Nunca conclua teor a partir de preview.

## Passo 0 — Mapa do caso (antes de ler qualquer peca)

1. `metadata` — partes, advogados, numero do processo, valor da causa,
   dispositivos de decisoes, ultimos andamentos.
2. `manifesto` — o indice cronologico: quais documentos existem, tipo, data
   de juntada, volume. E o seu sumario dos autos.
3. `stats` — distribuicao por peca (quanto existe de cada coisa).
4. `memoria_search("o que ja foi feito neste caso")` — sessoes anteriores
   podem ja ter lido e qualificado; nao repita trabalho.

Se `manifesto` indicar erro (pipeline sem enrich), navegue por
`facet(key="documento")` + `facet(key="peca")`.

## Passo 1 — Sequencia de leitura

Ordem obrigatoria para compreensao inicial. Para cada etapa: localize o
documento no manifesto (ou `search` com o filtro `peca`), e leia a peca
central INTEIRA com `document(documento)` — pecas centrais nao se leem por
amostra de busca.

| # | Peca | Filtro | O que extrair |
|---|------|--------|---------------|
| 1 | Peticao inicial | `peca: inicial` | causa de pedir + pedidos |
| 2 | Contestacao | `peca: contestacao` | preliminares + merito (atencao: pode conter reconvencao) |
| 3 | Replica | `peca: replica` | resposta as preliminares e ao merito |
| 4 | Decisoes interlocutorias | `peca: decisao_interlocutoria` | saneamento, provas, tutelas |
| 5 | Sentenca / Acordao | `peca: sentenca` / `peca: acordao` | fundamentacao + dispositivo |
| 6 | Ultimos atos | `buscar_cronologico(query, order_field="doc_order")` ou cauda do manifesto | estado atual, prazos em curso |

`document` fatia documentos grandes: continue com o `from_chunk` indicado no
aviso ate cobrir a peca. Anexos e documentos acessorios (procuracoes,
comprovantes, contratos juntados) podem ser lidos por `search` + `contexto`
dirigidos, guiados pelo que as pecas principais referenciam.

## Passo 2 — Cruzamentos (apos a leitura sequencial)

- Pedido vs fundamentacao vs documentos juntados: coerentes?
  `buscar_interseccao` cruza dois temas; `comparar(peca=...)` acha argumentos
  repetidos/incontroversos entre pecas.
- Citacoes: `facet` nos campos `processos_citados`/`sumulas_citadas`/
  `temas_repetitivos`; `cross_ref(kind, value)` mostra onde mais os autos
  citam o mesmo item.
- Datas e sequencia causal: a cronologia narrada e possivel? Lacunas
  temporais relevantes?

## Casos com multiplos processos (autos apartados)

Agravos, recursos e cumprimentos tem numero CNJ proprio e vivem na mesma
collection. Isole por arquivo antes de ler:

- `documento: <arquivo do agravo>` ou `numero_processo: <CNJ>`
- Leia os autos PRINCIPAIS antes do recurso — o recurso so faz sentido em
  relacao ao processo originario.

## Vedacoes

- Nao confiar no rotulo: uma "sentenca" no PJe pode ser decisao
  interlocutoria; uma "contestacao" pode conter reconvencao. Classifique
  pelo conteudo LIDO.
- Nao pular pecas intermediarias — decisao so se entende no contexto das
  peticoes que a antecederam.
- Nao ler "tudo de uma vez" numa busca generica. Compreensao e cumulativa:
  inicial primeiro, depois a defesa COMO resposta aquele pedido.

## Saida esperada

Ao final, sintetize: qualificacao (natureza, ramo, fase), partes e posicoes,
pedidos e estado de cada um, ultima movimentacao relevante e prazos em curso,
contradicoes ou lacunas detectadas — cada item com o documento-fonte.
