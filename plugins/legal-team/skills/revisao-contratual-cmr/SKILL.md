---
name: revisao-contratual-cmr
description: >
  Use quando o operador pedir para revisar, analisar, entender, comentar ou
  fazer redline (marca de revisão) de contrato, minuta, acordo de sócios ou
  quotistas, cessão de quotas, aditivo, estatuto, contrato social, confissão
  de dívida, acordo de pagamento ou qualquer instrumento recebido em .docx/PDF,
  inclusive versão devolvida pela contraparte com marcas ou comentários de
  outro advogado. NÃO cobre redigir contrato do zero (gerar-peca-cmr,
  ContratoCMR) nem resposta a notificação (resposta-notificacao-cmr).
---

# Revisão contratual — protocolo CMR

Extraído de 18 revisões reais (jun-set/2026: acordos de sócios, cessão de
quotas, SaaS, supply, aditivos trabalhistas, confissão de dívida, estatuto).
Duas regras que o operador repetiu em todas e que esta skill torna
invariantes:

1. **Revisão é adendo sobre o original, nunca documento novo.** O redline sai
   do arquivo da contraparte com a formatação idêntica; só muda se o operador
   pedir explicitamente para mudar a formatação.
2. **O operador decide quando há redline.** O fluxo padrão termina no
   memorando e na versão curta. Às vezes ele só quer entender o contrato e
   saber se há lacunas que valem edição. Redline só depois do pedido.

**REQUIRED BACKGROUND:** redacao-cmr (registro, período, conectivos) para o
texto do memorando e das cláusulas propostas. Formatação de documento novo
(memorando em .docx, contrato do zero): gerar-peca-cmr.

## Protocolo de abertura (antes de qualquer opinião)

| # | Gate | O que fazer |
|---|------|-------------|
| 1 | **Posição** | Quem representamos? Se o operador não disse, adotar premissa e DECLARÁ-LA no topo do memorando ("Premissa: representamos o CEDENTE; se errada, os pontos 4, 6 e 9 invertem de sinal"). Risco só existe a partir de uma posição. Posição neutra (orquestração entre sócias) também é posição: avaliar pelo mérito, não pela origem da sugestão. |
| 2 | **Cópia de trabalho** | Copiar o arquivo para o scratchpad com nome ASCII (acento no nome quebra pandoc, Copy-Item e caminhos UNC). Nunca editar o original. |
| 3 | **Radiografia** | `python scripts/redline_docx.py radiografia <docx>`: marcas de revisão por autor, comentários, placeholders (`XXXX`, `[●]`, `()`, `___`), numeração automática, fonte padrão. Marcas de terceiro condicionam tudo: analisar o texto **como ficará aceito** e nunca reescrever `w:ins`/`w:del` alheios. A hipótese "veio com track changes" costuma ser falsa: provar no XML. |
| 4 | **Cotejo** | Contrato nunca é lido sozinho: proposta comercial, questionário de due diligence, e-mails do cliente, versão anterior nossa, modelo do escritório. Divergência entre documentos (representante, valor, prazo, objeto) é achado de primeira ordem. |
| 5 | **Íntegra** | Ler o instrumento inteiro (pandoc para ler; python-docx quando precisar de tabelas) antes de qualificar qualquer cláusula. Em PDF pequeno, o operador prefere leitura como imagem a OCR. |

## Análise

- **Checklist por família de instrumento:** `references/checklists.md`
  (transversal + acordo de sócios, cessão de quotas, contrato social e
  estatuto, prestação de serviços e SaaS, supply e distribuição, aditivo
  trabalhista, confissão de dívida e acordo de pagamento).
- **Grounding:** `references/fontes.md`. Buscar ANTES de citar; quando o
  artigo é conhecido, buscar também pelo número; o que não foi localizado vai
  numa lista própria com "verificar antes de citar". Nunca preencher lacuna
  com memória. Jurisprudência é insumo para calibrar a posição, não citação
  em cláusula ou memorando (salvo pedido).
- **Registrabilidade é filtro autônomo** (DREI, Junta, RCPJ): o que vale
  perante terceiros é o instrumento registrado, não o parassocial.
- **Comentário de outro advogado na minuta é pedido de trabalho.** Examinar a
  passagem e responder com uma de três posições: alterei e por quê; não
  alterei e por que a redação atual é a melhor; há duas opções e recomendo
  esta. Nunca "me diga o que você quis dizer".
- **Separar decisão jurídica de decisão negocial.** A negocial volta ao
  operador com recomendação e ordem de concessão, não com menu.

## Entregáveis (sempre os dois, colados no chat)

1. **Memorando por gravidade** — estrutura em `references/memorando.md`:
   A. defeitos que travam o instrumento (com redação proposta em blockquote),
   B. coerência interna em tabela, C. lacunas, D. fundamentos verificados e
   não localizados, mais "o que está bom e deve ser mantido" e "pendências que
   dependem do cliente". Cada item etiquetado crítico / relevante /
   secundário.
2. **Versão curta** (até uma página) para o operador encaminhar ao chefe ou
   ao cliente: pontos estruturais + ajustes pontuais. "Não pode ser uma
   montanha de texto." Memorando de 20 páginas não é lido; o catálogo longo é
   referência, o documento de decisão tem 3 páginas.

O que NÃO entra: lista de documentos a pedir ao cliente (trabalhar com o que
foi enviado; pedido só se for impossível concluir sem ele, um pedido só, com
justificativa); alerta sobre obviedade profissional; jurisprudência transcrita;
motivação comercial do cliente dentro de cláusula.

## Redline (só a pedido do operador)

Mecânica completa em `references/redline.md`; biblioteca em
`scripts/redline_docx.py` (testes em `scripts/tests/`, rodam na VM e na
cmr-002). Regras:

- **Formatação idêntica ao original.** Edição por texto vivo sobre o
  `document.xml` original; parágrafo novo herda numeração e recuo do
  parágrafo-modelo; nenhuma outra parte do pacote é reescrita.
- **Redline x comentário:** tudo que comporta redação vai em marca de
  revisão, com base na avaliação já feita no memorando; fica em comentário só
  o que exige número ou decisão comercial que não temos. Dado pendente entra
  como `[● rótulo]` no próprio texto.
- **Autor das marcas** é parâmetro: "CMR Advogados" por padrão; "Carlos
  Magno" quando o operador disser que a rodada sai em nome dele.
- **Verificação obrigatória:** `verificar` (rejeitar tudo devolve o
  original) e leitura do texto aceito; onde houver Word (cmr-002), render com
  markup e leitura das páginas em imagem antes de entregar.
- Entregar o redline ao lado do original com sufixo `- redline CMR <data>`;
  versão limpa só se pedida (assinatura).

## Controle de qualidade

1. [ ] Posição declarada no topo? Premissa marcada como premissa?
2. [ ] Marcas e comentários de terceiros inventariados e preservados?
3. [ ] Todo dispositivo citado foi conferido na base? Lista de "não
       localizados" presente?
4. [ ] Cada defeito tem efeito prático para o cliente e redação proposta?
5. [ ] Tabela de coerência interna cobre remissões, numeração, definições,
       regimes de juros e índices repetidos?
6. [ ] "O que está bom" e "pendências do cliente" presentes?
7. [ ] Versão curta cabe em uma página e foi colada no chat?
8. [ ] Redline gerado só após pedido, com `verificar` limpo e formatação
       intocada?

## Sinais de que está saindo do protocolo

| Pensamento | Realidade |
|-----------|-----------|
| "Entrego a versão limpa, é mais fácil de ler" | O operador precisou cobrar "você gerou o .docx com os tracked changes?". Quem volta para a contraparte é o redline. |
| "Reescrevo a cláusula inteira, fica melhor" | "Não reescreva tudo... pra não enviarmos um documento novo do zero." Inserir e ajustar; substituir só quando a cláusula é irrecuperável. |
| "Peço ao cliente o contrato social/os anexos" | Trabalhar com o que há; registrar a lacuna nas pendências. Pedido só se for impossível concluir sem ele. |
| "Esse artigo eu sei de cor" | Foi assim que CC 1.078 §3º virou "não localizado" e MP 2.200-2 virou citação sem conferência. Buscar, inclusive pelo número. |
| "Sugestão da contraparte é ataque" | "Posição absolutamente imparcial... há sugestões interessantes." Avaliar pelo mérito. |
| "90 itens, cada um explicado" | Agrupar por bloco temático e classificar em 3 níveis. Decisão exige 3 páginas. |
| "Já vou gerar o redline junto" | Só a pedido. Às vezes o operador só quer entender o contrato. |
