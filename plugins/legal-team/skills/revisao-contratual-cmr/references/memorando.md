# Estrutura dos entregáveis

Dois documentos, sempre. Ambos colados no chat (o operador revisa no chat);
o memorando também gravado como `.md` ao lado do arquivo revisado (e em
`.docx` só se o operador pedir — via gerar-peca-cmr, Arial 11, 1,15).

## 1. Memorando de revisão

Cabeçalho obrigatório:

```
# Revisão — <instrumento> (<partes>)

Versão revisada: "<arquivo>" (<data>). <Marcas de terceiro: N alterações de
<autor>, <data>, não aceitas — analisadas como ficarão aceitas.>
Premissa: representamos <PARTE>. Se a premissa estiver errada, os pontos <n>
invertem de sinal.
Regime: <tipo societário / natureza do contrato — ex.: Ltda pura, CC arts.
1.052-1.087; corretagem, CC 722-729; prestação de serviços B2B, CC 593-609>.
```

Seções, nesta ordem:

**A. Defeitos que travam o instrumento** — itens numerados, do mais grave ao
menos grave. Cada item:
- título: "Cláusula X — diagnóstico em uma frase";
- o problema e o **efeito prático para o cliente** (quem paga, quando, quanto);
- dispositivo verificado na base (se houver);
- **redação proposta em blockquote**, pronta para colar, com a numeração da
  cláusula;
- quando couber: "Nota de negociação" (o que a contraparte vai pedir) e
  "posição de recuo aceitável";
- quando houver duas saídas: (i)/(ii) com **recomendação explícita** e o
  porquê.

**B. Defeitos de coerência interna** — tabela `Cláusula | Problema |
Correção`: remissões erradas, numeração quebrada, definições inconsistentes,
regimes de juros/índices duplicados, concordância, resíduo de outro contrato,
tabela vazia, pontuação partida.

**C. Lacunas a preencher** — o que o instrumento não trata e deveria
(administração e aprovação de contas, tributo da operação, contrato social
vigente, unipessoalidade, anexo referenciado e ausente).

**D. Fundamentos verificados na base** — lista dos dispositivos e precedentes
efetivamente conferidos, um por linha, com o que dizem. Em seguida, separado:
**"Não localizados na base: ... Verificar antes de citar."**

**O que está bom e deve ser mantido** — cláusulas que protegem o cliente e não
devem ser tocadas na negociação (evita que a contraparte as "melhore").

**Pendências que dependem do cliente** — dados que só ele tem (valor da
multa, lista de exclusão, registro ANVISA, foro, signatário). Entram como
`[● rótulo]` no redline. Uma lista só, sem pedir documento que não seja
imprescindível.

Etiquetas de severidade nos títulos de A: `– crítico`, `– relevante`,
`– secundário`.

## 2. Versão curta (uma página)

Para o operador encaminhar ao chefe ou ao cliente sem editar. Formato:

```
Revisão — <instrumento> — <data>

Pontos estruturais (mudam o patamar de risco)
1. **<título>** — <2 linhas: problema + o que propomos>.
2. ...
3. ...

Ajustes pontuais
- <cláusula>: <1 linha>.
- ...

Depende do cliente: <lista curta>.
```

Sem fundamentos legais, sem blockquote, sem tabela. Até ~500 palavras.

## 3. Rodada de negociação (versão devolvida pela contraparte)

Quando o que chega é a versão com as alterações da outra parte:

1. Diff cláusula a cláusula contra a nossa última versão (pandoc de ambas;
   `--track-changes=all` se houver marcas). Catálogo numerado (#001...) só como
   referência cruzada.
2. Agrupar em **blocos temáticos**; classificar em 3 níveis (aceitável /
   preocupante / inviável).
3. Ficha por item: o que a alteração pretende → instituto subjacente →
   implicação teórica (compatibilidade com o regime; contradição interna) →
   implicação prática (quem ganha agilidade, quem ganha proteção) → mérito:
   **incorporar / modular / descartar**.
4. Distinguir remoção deliberada de perda editorial antes de discutir mérito.
5. Issues list com veredito em negrito abrindo cada linha (acolhida /
   acolhida em parte / não acolhida / pendente de definição negocial) e
   **ordem de concessão** para a mesa: o que cede primeiro, o que não cede.
6. Comentário da contraparte é pedido de trabalho: responder cada um (ver
   SKILL.md).

## 4. Redação das cláusulas propostas

Registro de redacao-cmr, sem linguagem de contencioso. Princípios que
apareceram em toda revisão bem recebida: definições controladas (termo
capitalizado, definido uma vez); gatilho objetivo ("ausência de quórum em 2
reuniões consecutivas com intervalo mínimo de 30 dias", não "impasse");
exaustividade de cenários (4 cenários = 4 previsões); silêncio intencional
documentado no memorando (lei supletiva resolve); nunca dado inventado (CNPJ,
NIRE, valor, endereço — placeholder `[●]`).
