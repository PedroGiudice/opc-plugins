---
name: redacao-cmr
description: >
  Redigir documentos juridicos no estilo do escritorio CMR — pecas processuais
  (contestacao, apelacao, contrarrazoes, embargos, memoriais), cartas,
  notificacoes e respostas extrajudiciais. Use quando o operador pedir para
  "redigir", "escrever", "minutar" ou "responder" qualquer documento juridico,
  ou revisar texto para o padrao da casa. Baseada em engenharia reversa de 12
  documentos protocolados/enviados (2024-2026). Cobre estilo de escrita,
  concatenacao logica e estrutura argumentativa em 3 camadas: nucleo invariante,
  escala por complexidade e involucro por genero. Compoe com gerar-peca-cmr
  (formatacao .docx) e leitura-autos (compreensao previa).
---

# Redacao no estilo CMR

Extraido de 12 documentos finais do escritorio (4 contestacoes, 3 apelacoes,
contrarrazoes, embargos, memoriais, 2 cartas-resposta; 2024-2026). O alvo e o
estilo **2026** (o mais maduro do corpus). Tres camadas: o nucleo que nunca
muda, os dispositivos que entram conforme a COMPLEXIDADE cresce, e o involucro
que muda por genero. Complexidade — nao o tipo de peca — e o eixo: embargos
podem ser simples ou complexos; a estrutura acompanha o grau de complexidade.

## Pre-requisitos (nunca pule)

1. **Compreensao dos autos**: skill `leitura-autos` executada; fatos com fonte.
2. **Fundamentos com integra lida**: toda ementa que sera transcrita foi lida
   inteira (`stj-vec:document`, `case-knowledge:document`/`contexto`). Regra de
   citacao do projeto: ementa INTEGRAL em bloco ou apenas o numero — nunca
   trecho solto.
3. Dados do caso verificados (partes, numeros, valores, datas) — nunca de
   memoria.
4. Formatacao final: skill `gerar-peca-cmr` (PecaCMR/ContratoCMR/AditamentoCMR).

---

## Camada 1 — Nucleo invariante (vale em TUDO)

### Voz e registro

- Peca: terceira pessoa da parte ("a Re requer", "a Apelada entende").
  Carta: plural institucional do escritorio ("reafirmamos", "expomos").
- Formal sem arcaismo ornamental. Vocabulario civilista preciso (resilicao,
  denuncia, distrato, trato sucessivo, convalidacao tacita, exercicio regular
  de direito).
- **Anglicismo nunca entra sem glosa** na primeira ocorrencia: "SaaS (Software
  as a Service, Software como Servico, em portugues)", "B2B (negocios entre
  empresas)". Instrumentos ganham apelido: "(doravante 'MSA')".
- Latinismo dosado por genero: carta = zero; contestacao = moderado (*pacta
  sunt servanda*); recurso = concentrado (*venire contra factum proprium*,
  *extra petita*, *ratio decidendi*, "por amor ao debate"). Sempre em italico.

### Periodo e ritmo

- Alternancia deliberada: periodo longo subordinado (com incisos entre
  travessoes) fechado por **frase-lamina curta**: "Sem razao, contudo." /
  "A contradicao e manifesta." / "Essa distincao e decisiva."
- Frase-topico taxativa abrindo o nucleo argumentativo: "Os contratos tem
  prazo determinado."
- Aforismo com ponto-e-virgula ou travessao: "Sem inadimplemento, nao ha
  resolucao; sem resolucao, nao ha restituicao." / "Quem conhece de antemao o
  fato que qualifica como vicio nao incorre em erro — pratica ato de vontade
  consciente."
- Anafora negativa para lacuna probatoria: "Nao juntou [...]. Nao requereu
  [...]. Nao alegou [...]."
- Dois-pontos como operador de definicao/desfecho e antitese: "E uma obrigacao
  de meio, nao de resultado: ...".
- Incisos romanos (i), (ii)... para premissas e requisitos.

### Conectivos — os da casa e os vedados

- **Da casa:** Portanto; Assim; Contudo; Ainda que; Tampouco; Alias; Inclusive;
  porquanto (registro recursal); decerto; Vejamos: (sempre antes de prova ou
  jurisprudencia); Pelo contrario:; "Nao e so." / "Mas nao e so." / "Nao
  bastasse" (escalada); "Primeiro, porque... Segundo, porque..."; "Mais
  relevante ainda:"; Frise-se. Conclusoes: "Diante do exposto" / "Por todo o
  exposto" (pecas), "Por essas razoes" (cartas).
- **Vedados:** "Ocorre que", "Data venia" cru (a casa usa "com a devida
  venia"), pergunta retorica, "Destarte"/"Outrossim" (raridade estatistica —
  evite). **Ponto de exclamacao: NUNCA, sem excecao** — nem no vocativo
  recursal, que vai "NOBRES JULGADORES, / COLENDA CAMARA," (instrucao
  expressa do socio, 07/07/2026; pecas antigas do corpus com "!" no vocativo
  NAO devem ser imitadas nesse ponto).
- "Ademais"/"Com efeito": tolerados com parcimonia em peca extensa; nunca em
  carta.
- Retomada a distancia SEMPRE adverbial-generica ("conforme ja exaustivamente
  demonstrado", "conforme amplamente demonstrado em sede de Contestacao") —
  nunca por numero de capitulo. Nao numere capitulos.

### Precisao numerica como retorica

- Datas DD.MM.AAAA; em contagem de prazo, dia da semana entre parenteses.
- Valores decisivos: algarismo + extenso entre parenteses, repetidos
  integralmente a cada ocorrencia.
- Se ha conta, MOSTRE a conta (equacao em linha propria) e repita o
  numero-ancora nas secoes-chave ("quase 25 vezes", "4.000%").

### Enfase tipografica (medida nos .docx)

- **Negrito:** enderecamento, nomes das partes, "Processo nº" + numero, nome
  da peca, resultado do pedido ("TOTALMENTE improcedente"), documentos-chave.
  Nas cartas: quase nenhum (so o destinatario no enderecamento).
- **Italico:** estrangeirismos, latinismos, citacoes em bloco.
- Grifo seu dentro de citacao: marcar "(NG)" ou "– grifos acrescidos" apos a
  referencia (padrao 2026; nao use as variantes antigas gn/GN/NA/grifamos).

### Citacao (protocolo unico)

- **Jurisprudencia:** anuncio + dois-pontos ("Nesse sentido:" / "Vejamos:")
  -> ementa INTEGRAL em bloco (cortes com "(...)") -> referencia parentetica
  completa AO FINAL (tribunal; classe e numero; relator; orgao julgador;
  datas) -> marca de grifo -> **paragrafo-eco** reaplicando a ratio ao caso.
  Alternativa unica: referencia inline so por numero e metadados. NUNCA
  retalho de ementa no corpo. **Zero doutrina** (autoridade = contrato, lei,
  precedente; em materia tecnica, fontes de mercado nomeadas: Gartner, IBM).
- **Precedente domestico:** sentencas de casos analogos da propria cliente,
  por numero + partes: "(Sentenca processo nº [CNJ] – [Autora] x [Cliente])",
  introduzidas por "Esse entendimento vem sendo reiteradamente adotado...".
- **Lei:** dispositivo DECISIVO transcrito literalmente ("que estabelece:
  '...'") ou em bloco; instrumental por referencia curta ("art. 85, §2º, do
  CPC"). Em carta, diploma sempre por extenso e a lei entra como REFORCO
  entre parenteses no fim do periodo.
- **Clausula:** numero + verbo dicendi + parafrase, transcrevendo entre aspas
  so a expressao decisiva ("a clausula 11.2 do MSA dispoe que..."). Contrato
  estrangeiro: "transcritas e traduzidas".
- **Adversario:** cite as palavras dele entre aspas e devolva como confissao
  — a municao preferida da casa.

### Tom adversarial — deferencia calibrada por alvo

| Alvo | Tratamento |
|------|-----------|
| Juizo / decisao favoravel | "r. Sentenca", "d. Juizo", "acertadamente", "muitissimo acertado" — aliada intocavel |
| Decisao atacada (apelacao/embargos) | "com a devida venia" SEMPRE antes da divergencia; em embargos, elogio tatico a forma antes de demolir o conteudo ("Nao obstante o reconhecimento da qualidade tecnica da fundamentacao..."); critica mira o ATO ("o v. Acordao desconsiderou"), nunca o julgador |
| Parte adversa | Sem venia. Conduta nomeada com lastro documental: "oportunista", "distorce os fatos", "tenta induzir este Tribunal em erro". Estilo 2026: acusar por substantivo com prova, nao por adjetivo solto |
| Fato grave nao provado | Insinuacao factual sem conclusao: exponha os fatos em sequencia e NAO escreva a palavra ("fraude") — os fatos falam |

Ataque sempre ao argumento e a conduta, jamais a pessoa. Cortesia estrategica
como arma: apreço e recusa na mesma respiracao; advertencia "com a maxima
cordialidade"; concessao sempre algemada ("sem reconhecer nenhuma
responsabilidade", "ressalvado, desde logo, que...").

---

## Camada 2 — Escala por COMPLEXIDADE (o eixo)

O que muda quando o documento cresce nao e o registro — e a infraestrutura de
orientacao do leitor. Adicione dispositivos NESTA ordem, conforme necessidade:

| Complexidade | Dispositivos |
|---|---|
| **Baixa** (carta, memorial, manifestacao simples: 1-5 pgs) | Sem capitulos ou 1-2 titulos. Encadeamento logico-classificatorio (carta: clausula a clausula) ou cronologico (memorial: datas e atos). Frase-topico + arremate seco por paragrafo. Zero jurisprudencia (carta) ou so as decisoes do proprio caso (memorial) |
| **Media** (contestacao/recurso focado: 10-17 pgs) | Capitulos com titulo-TESE em caps (nunca "DO DIREITO" neutro; a conclusao no titulo: "INEXISTENCIA DE ERRO SUBSTANCIAL E CONVALIDACAO TACITA"). Bloco narrativo bipartido antes do merito. Paragrafo-sintese fechando CADA capitulo (Portanto/Dessa forma/Assim). Frase-dobradica fechando a sintese ("E o que sera esmiucado adiante.") |
| **Alta** (peca extensa, multiplas teses: 18+ pgs) | + Tese-mae com capitulos-consequencia ("afastada a incidencia do CDC, renasce a plena eficacia da clausula") OU roteiro explicito (mapa-indice dos vicios nos embargos; capitulo "DAS QUESTOES RELEVANTES" com bullets espelhados). + Recapitulacao enumerada fechando o capitulo central ("Por todo o exposto, ficou demonstrado que:" + itens). + Numero-ancora repetido nas secoes-chave. NUNCA escale por acumulo de capitulos autonomos sem sintese — e o padrao 2024 que gerava duplicacao |
| **Fatico-tecnica** (qualquer tamanho) | Anteponha infraestrutura didatica: GLOSSARIO formal ("A fim de melhor tornar a compreensao dos fatos, considerando o carater tecnico da presente demanda"), glosa de cada termo, aritmetica exposta |

Hierarquia de teses SEMPRE explicita e rotulada: "SUBSIDIARIAMENTE:" no
titulo, "Caso seja o entendimento de V. Exa." no corpo, blindagem "o que se
admite exclusivamente por amor ao debate" / "apenas por dever de
argumentacao". Pedidos em ate 3 degraus: principal -> subsidiario ->
alternativo dentro do subsidiario ("caso V. Exas. entendam inadequado o
percentual, seja arbitrada equitativamente").

## Camada 3 — Involucro por GENERO

Formulas literais completas em `references/formulas-cmr.md`. Mapa:

| Genero | Abertura | Corpo | Fecho |
|---|---|---|---|
| Peca de 1º grau | Enderecamento em caps -> "Processo nº" -> periodo unico de qualificacao com o nome da peca em caps integrado a frase -> TEMPESTIVIDADE com conta exposta | Sintese da inicial (verbos de atribuicao: "narram", "sustentam", "aduzem") -> virada -> REALIDADE FATICA -> merito por titulos-tese | Pedidos "seja/sejam + participio", protesto por provas + depoimento pessoal "sob pena de confissao", publicacoes exclusivas "sob pena de nulidade", "Termos em que, / Pede deferimento." + local e data |
| Recurso | Peca BIPARTIDA: interposicao (com preparo exato) + razoes com "Apelante:/Apelada:" e "NOBRES JULGADORES, / COLENDA CAMARA," (sem exclamacao) | Tempestividade -> sintese dos fatos -> sintese da SENTENCA (plantando a contradicao) -> merito do concreto ao abstrato -> subsidiario rotulado | + efeito suspensivo e inversao da sucumbencia; honorarios "entre 10% e 20% ... art. 85, §2º" |
| Embargos | Enderecamento NOMINAL ao relator; "opor tempestivamente o competente recurso de" | Mapa-indice dos vicios (vicio -> inciso do art. 1.022 -> dispositivo violado) -> desenvolvimento com paralelismo -> prequestionamento como secao autonoma | Cascata de pedidos com verbos variados ("Requer, ademais" / "Postula-se" / "Subsidiariamente") |
| Carta/notificacao | Local e data -> bloco de enderecamento (A/C + e-mail) -> "Ref.:" -> "Prezados Senhores," -> "Na qualidade de advogados da [cliente] ('[Termo]') e com sua expressa autorizacao, serve a presente para..., contranotifica-los do quanto segue:" | Sintese da pretensao adversa COM AS PALAVRAS DELA -> apreço + anuncio da recusa -> refutacao clausula a clausula -> refutacao preventiva do proximo argumento | Binario: recusa integral e especifica + porta aberta ao dialogo com ressalva -> "Sem mais para o momento, / Atenciosamente," + nome + OAB |
| Memoriais | Titulo + identificacao do recurso + partes por papel + julgadores NOMEADOS com tratamento completo | Narrativa cronologica continua (sem capitulos), decisoes favoraveis transcritas, quantificacao retorica | "Diante o exposto... entende... e espera seja negado provimento" (modestia formal: "entende/espera", nao "requer") |

---

## Controle de qualidade (antes de entregar)

1. [ ] Todo fato tem fonte nos autos; toda ementa transcrita foi lida integra?
2. [ ] Numeros conferidos (datas, valores, prazos, CNJ)?
3. [ ] Conectivos vedados ausentes? Exclamacao/pergunta retorica ausentes?
4. [ ] Cada capitulo fecha com paragrafo-sintese? Subsidiario rotulado?
5. [ ] Deferencia calibrada (venia so para decisao; parte sem venia)?
6. [ ] Glosa em todo anglicismo; apelidos "doravante" definidos?
7. [ ] Grifo padronizado (NG / grifos acrescidos)?
8. [ ] Zero doutrina nominal; jurisprudencia integral-ou-numero?
9. [ ] Revisao ortografica completa (o corpus 2024 tinha typos; o alvo e 2026:
       limpo)?

## O que NAO imitar do corpus

- Typos e lapsos de revisao (2024) — o padrao e o texto limpo de 2026.
- Duplicacao de secoes (padrao 2024 de peca longa sem recapitulacao).
- Coloquialismo metaforico ("cai como uma luva") — fora da media da casa.
- Variantes antigas de marca de grifo (gn/GN/NA/grifamos).

## Referencias

- `references/formulas-cmr.md` — arsenal literal: aberturas, fechos,
  dobradicas, escaladores, blindagens, formatos de referencia por tribunal.
- Analise completa por faixa (fonte desta skill, com dados de cliente):
  `/home/opc/pecas-cmr/_analise/` na VM (NAO versionada; nao replicar em repo).
