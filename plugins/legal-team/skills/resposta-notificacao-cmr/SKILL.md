---
name: resposta-notificacao-cmr
description: >
  Redigir, minutar ou revisar RESPOSTA (contranotificacao) a notificacao
  extrajudicial recebida por cliente do escritorio — cobranca, imputacao de
  falha, pedido de rescisao, restituicao, indenizacao ou suspensao de
  pagamentos. Use quando o operador pedir para "responder a notificacao",
  "contranotificar" ou "minutar resposta extrajudicial". NAO cobre peca
  processual (redacao-cmr + gerar-peca-cmr) nem a notificacao ATIVA (primeira
  carta). Requer redacao-cmr como base de estilo; formatacao .docx via
  gerar-peca-cmr (classe RespostaNotificacaoCMR).
---

# Resposta a notificacao extrajudicial — protocolo CMR

Extraida de 2 respostas reais enviadas pelo escritorio (jul/2026, corpus mais
maduro que as cartas de 2024-2025). O genero tem um unico objetivo: **negativa
total no merito, cordialidade total na forma, e nenhuma palavra que sirva de
confissao em juizo depois**. A carta de resposta e um documento pre-litigio:
presuma que ela sera anexada a uma peticao inicial contra a cliente.

**REQUIRED BACKGROUND:** redacao-cmr (nucleo invariante: ordem direta, voz
ativa, frase-lamina, conectivos da casa). Esta skill so define o que MUDA no
genero. Formatacao final: gerar-peca-cmr, classe `RespostaNotificacaoCMR`
(Arial 12, 1.15, sem numeracao — NAO usar PecaCMR).

## Registro do genero (difere da peca — erros mais comuns)

1. **O destinatario e "V.Sas." SEMPRE.** A carta fala COM o notificante, nao
   sobre ele: "V.Sas. contrataram", "a Notificacao de V.Sas.", "Nao e dado a
   V.Sas.". NUNCA terceira pessoa ("a Notificante alega") e NUNCA alcunha
   definida para o notificante — so a cliente ganha termo definido
   ("[CLIENTE]" entre aspas na primeira mencao).
2. **O sujeito do relato e "A Notificacao"** (o documento), com verbos de
   atribuicao: "A Notificacao relata que...", "Relata, ainda, que...", "Da
   conjugacao desses fatos, V.Sas. requerem...". Nunca adira aos fatos
   narrados — atribua-os sempre.
3. **Zero lamento, zero desculpa.** "Lamentamos os transtornos" e confissao
   disfarcada de cortesia. O apreco e pela RELACAO, nunca pelo evento: a
   formula fixa do movimento 3 e o unico lugar de cordialidade inicial.
4. **Termos do contrato sem glosa didatica.** O destinatario conhece o
   contrato que assinou: escreva "Formulario de Pedido (Order Form) nº X" como
   nome proprio, sem traduzir nem explicar SaaS/B2B. A regra de glosa da
   redacao-cmr vale para peca (leitor = juizo), nao para carta entre as partes.
5. **Numeros secos.** Valores SEM extenso ("R$ 100.000,00"), datas DD.MM.AAAA.
   O extenso repetido e retorica de peca; a carta e sobria.
6. **Lei como reforco parentetico** ao fim do periodo, diploma por extenso:
   "(artigo 393 do Codigo Civil)". O fundamento principal e sempre o CONTRATO
   (clausula); a lei confirma. Zero jurisprudencia, zero doutrina, zero
   latinismo.
7. **Conectivos do genero:** Inicialmente / por consequencia / Ainda que /
   Tampouco (dentro de periodo) / Por fim / Por essas razoes / Nao obstante.
   Vedados na carta: "Nao e so.", "Tampouco prospera" (abertura recursal),
   "Ademais", "Com efeito", escaladores de peca.
8. **Zero enfase tipografica no corpo** (sem negrito, sem italico — nem em
   estrangeirismo). Negrito so no nome do destinatario, no enderecamento.

## O protocolo — 13 movimentos

Formulas literais completas em `references/formulas-resposta-notificacao.md`.
Movimentos 8 e 9 sao condicionais; os demais, obrigatorios e NESTA ordem.

| # | Movimento | Funcao |
|---|-----------|--------|
| 1 | Contranotificacao de abertura | Legitimacao ("Na qualidade de advogados... com sua expressa autorizacao... contranotifica-los do quanto segue:") |
| 2 | Relato-espelho | Reproduzir a notificacao em termos neutros e controlaveis: fatos ("A Notificacao relata que...") -> pretensoes ("Da conjugacao desses fatos, V.Sas. requerem..."). CADA pedido listado aqui sera negado um a um no movimento 10 — nao omita nenhum |
| 3 | Apreco + transparencia | Formula fixa: apreco pela relacao + anuncio de que as providencias "nao encontram respaldo nos instrumentos que regem a contratacao" |
| 4 | Tese-mae | UM paragrafo com a razao central da recusa ("O evento que fundamenta a Notificacao — [X] — nao constitui falha da [CLIENTE]." ou "A Notificacao de V.Sas. nao imputa a [CLIENTE] nenhum descumprimento, defeito ou falha.") |
| 5 | Perimetro obrigacional | "A obrigacao que a [CLIENTE] assumiu perante V.Sas. esta na clausula [X] do [CONTRATO] e consiste em [...]" — delimitar O QUE foi prometido antes de negar o resto |
| 6 | Desenvolvimento clausula a clausula | 1 paragrafo = 1 fundamento (clausula + consequencia). Arremate-padrao: "O [CONTRATO] previu a hipotese que V.Sas. agora invocam, e alocou o respectivo risco." |
| 7 | Utilidade economica | "Nao se sustenta, por consequencia, a alegacao de que a utilidade economica da contratacao estaria comprometida." + clausulas de taxas nao cancelaveis/nao reembolsaveis e de garantia limitada |
| 8 | (SE houver ciencia previa) Boa-fe invertida | "Nao e dado a V.Sas. invocar agora como surpresa aquilo de que tinham plena ciencia ao contratar (artigo 422 do Codigo Civil)." |
| 9 | (SE a cliente colaborou) Colaboracao ressalvada | "Ainda que sem qualquer responsabilidade pelo ocorrido, [...] Essa conduta reafirma a boa-fe [...] e nao constitui reconhecimento de responsabilidade." |
| 10 | Negativa estruturada | "Sendo essa a estrutura da contratacao, a [CLIENTE] nao pode acolher as providencias requeridas na Notificacao." + anafora ("Nao lhe cabe [...]. Nao cabe a [CLIENTE] [...].") cobrindo TODOS os pedidos do movimento 2. Suspensao de pagamentos anunciada: rebater com o artigo 476 do Codigo Civil (pressupoe inadimplemento inexistente) |
| 11 | Paridade empresarial | "Por fim, cuida-se de relacao entre sociedades empresarias, para a qual se presumem a paridade e a simetria [...] (artigo 421-A do Codigo Civil)." Paragrafo AUTONOMO e afirmativo — nunca condicional defensivo ("caso se pretenda sustentar...") |
| 12 | Sintese + reserva | "Por essas razoes, a [CLIENTE] nao acolhe nenhuma das providencias requeridas na Notificacao de V.Sas., e nao reconhece [lista], reservando-se todos os direitos decorrentes do [CONTRATO], inclusive quanto a exigibilidade das obrigacoes de pagamento." |
| 13 | Porta aberta ressalvada + fecho | "Nao obstante, e em consideracao a relacao e a boa-fe [...], permanece inteiramente aberta ao dialogo tecnico e comercial — ressalvado, desde logo, que qualquer tratativa dessa natureza nao importa reconhecimento de responsabilidade nem altera as obrigacoes assumidas [...]." -> "Sem mais para o momento, / Atenciosamente," + nome + OAB |

## Taticas do genero

- **A notificacao e a sua melhor prova.** Extraia admissoes do proprio texto
  adverso e devolva: "A propria Notificacao de V.Sas. registra que [...]", "a
  Notificacao de V.Sas. nao afirma o contrario", "Todas as falhas nela
  descritas sao expressamente atribuidas, pela propria Notificacao, a
  [TERCEIRO]". Antes de redigir, releia a notificacao PROCURANDO o que ela
  admite.
- **Expressoes adversas entre aspas, depois desmontadas.** Cite a expressao
  exata da notificacao ("etapas indissociaveis", "imprestavel") e demonstre
  que o contrato ou os fatos a desmentem.
- **Toda concessao algemada.** Qualquer mencao a colaboracao, tratativa ou
  gesto comercial — passado ou futuro — carrega ressalva expressa de
  nao-reconhecimento de responsabilidade. Sem excecao.
- **Responda todos os pedidos.** Pedido nao respondido e pedido meio
  concedido. O movimento 10 espelha, na negativa, a lista (i)-(n) do
  movimento 2.

## Checklist do genero (alem do da redacao-cmr)

1. [ ] Notificante tratado como V.Sas. do inicio ao fim (nenhuma terceira
       pessoa, nenhuma alcunha)?
2. [ ] Nenhum lamento, desculpa ou reconhecimento de dano/transtorno?
3. [ ] Movimentos 1-7 e 10-13 presentes, na ordem? 8-9 avaliados?
4. [ ] Cada pedido do relato-espelho negado nominalmente no movimento 10?
5. [ ] Toda colaboracao/tratativa com ressalva de nao-reconhecimento?
6. [ ] Fundamento = clausula; lei so parentetica; zero jurisprudencia/doutrina?
7. [ ] Valores sem extenso; sem glosa; sem enfase tipografica; sem
       conectivos de peca?
8. [ ] Reserva de direitos na sintese (movimento 12)?
9. [ ] Formatacao com `RespostaNotificacaoCMR` (nao PecaCMR)?
