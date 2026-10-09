# aidv-autos

Mod do Claude Code (plugin de hooks de função) que desenha as pesquisas
jurídicas na linguagem do AiDV em vez do JSON cru, nas três fontes:

| Fonte | Tools | Glifo | Lista | Leitura no painel |
|---|---|---|---|---|
| Autos do caso | `case-knowledge` `search` | ■ azul (marcador de família por peça) | peça, fls., data, parte, título | "Peça inteira" (`document`) e "Contexto" (`contexto`) |
| Jurisprudência do STJ | `stj-vec-tools` `search` e `search_formula` | ◈ lavanda | processo, órgão, Min., data, seção | "Inteiro teor" (`document`, acórdão por seção) |
| Legislação | `legal-vec-tools` `search` | § verde | "CC, art. 206", "Súmula 547 do STJ"... + texto | "Dispositivo inteiro" (`document`) |

Item 2 do roteiro "AiDV dentro do Claude" (ver
`case-docs/docs/contexto/05102026-mods-claude-code-aidv-contexto.md`).
Desde a v0.2 (05/10/2026) cobre as três fontes; o nome `aidv-autos` ficou
pelo id do painel e das chaves de estado (renomear é decisão do empacotamento).

## O que desenha

- **Linha da busca no transcript** (`ui.render` em `ToolUse`): "Buscou nos
  autos: «query» (filtros) · N trechos em M peças", dobrada por padrão, com os
  botões "Detalhes" (lista de peças na própria linha: marcador de família
  ■ ato / ○ expediente / ◆ anexo, rótulo da peça em português na cor do tom
  AiDV, fls., data de juntada, parte e título) e "Ver no painel". Enquanto
  roda: "Buscando nos autos: …". Erro e interrupção têm linha própria.
  A linha cabe SEMPRE numa linha (0.2.2): rótulo, contagem e botões ficam
  inteiros, os filtros cedem primeiro (cortados, ou fora da linha em tela
  estreita) e a pergunta leva o que sobra, cortada no fim (`wrap:
  'truncate-end'`). Antes, uma linha mais larga que a tela encolhia cada
  pedaço e o quebrava na própria coluna (pesquisas do STJ com filtros viravam
  uma tabela de duas linhas).
- Nome de arquivo dos autos sem `.json` (a extensão do OCR) no filtro
  `documento`, nos grupos de "Detalhes" e no painel (0.2.2).
- **Bloco de resultado** (`ToolResult`): nunca desenha o JSON. A lista vive
  na linha, porque dentro de um grupo de tools o motor não desenha esse site.
- **Painel** (`Pane`, id `aidv-autos`, título fixo "Pesquisas da sessão"
  desde a 0.2.2, porque a lista mistura as três fontes): "Recentes" no topo
  (com o glifo da fonte; alternam a selecionada),
  itens da pesquisa selecionada com preview limpo e os botões de leitura
  ("Peça inteira"/"Contexto" nos autos, "Inteiro teor" no STJ, "Dispositivo
  inteiro" na legislação), que chamam as tools `document`/`contexto` do
  server da fonte pelo próprio mod (`$.mcp.call`) e mostram o texto no
  painel, SEM o modelo no loop e sem gastar contexto. Julgado sai por seção
  (acórdão, ementa, relatório, voto, ementa citada); dispositivo sai sem o
  caminho hierárquico ("Código Civil, PARTE GERAL, ...") que precede o texto. A leitura usa as mesmas
  regras de exibição do app (`lib/leituraContent.ts` do extractor-lab:
  `parseContent`, `reflow`, `splitList`, portadas sem alteração): título em
  negrito, lista em itens, tabela como bloco, nota de rodapé discreta, timbre
  de página omitido. "Continuar leitura" traz a próxima fatia (`from_chunk`).
  "Pedir ao Claude que leia" submete um prompt (único botão que gasta turno).

O JSON que o modelo recebe NÃO muda: o mod lê uma cópia do `text` em
`tool.call` e guarda em `$.state` (`buscas`, `aberto`, `selecionada`,
`leitura`).

## Gotchas medidos no Desktop (05/10/2026)

- Os hooks são registrados em laço sobre a tabela `FONTES`, então o
  `claude plugin validate` mostra `tool=?` nos matchers (não lê valores
  dinâmicos). Em runtime o matcher é por valor e funciona; se o
  empacotamento exigir nomes estáticos no validate, desenrolar o laço.
- Fontes da base de legislação com nome cru no `doc_id` (`marco_seguros`)
  são traduzidas em `CODIGOS`; prefixo desconhecido usa o nome do código que
  vem no próprio texto.

- Desenvolver pela VM com o mod JÁ instalado na máquina do Desktop: a sessão
  hospedada na VM recebe a cópia instalada SEM `hooks/`, com o mesmo nome, e
  ela vence a cópia do dev-mods (medido 09/10/2026: nada desenha, nenhum aviso).
  Contorno: no dev-mods, renomear o plugin para `<mod>-dev` (`name` do
  plugin.json, `plugin:` dos atoms, chave do `PluginState` em `types/` e
  `PLUGIN` dos testes) e desfazer a troca ao devolver o código ao dev clone.
- Em grupo de tools ("Used N tools") só a linha `ToolUse` existe; o site
  `ToolResult` não é desenhado. Qualquer detalhe tem de estar na linha.
- O painel SOLTA o teclado a cada redesenho: o clique seguinte vira foco em
  vez de pressão (duplo clique). Contorno: `refocar()` repede o foco com
  `$.ui.open({ id, focus: true })` 250 ms depois de cada ação (o pedido
  precisa vir DEPOIS do redesenho; imediato não pega). Defeito da
  superfície, a reportar no repositório do Claude Code.
- `$.ui.log` polui o transcript (uma linha cinza por chamada); `$.ui.status`
  não aparece no Desktop. Diagnóstico só temporário.
- `$.mcp.call` aceita o server na grafia do nome da tool
  (`plugin_case-knowledge_case-knowledge`), sem prompt de permissão.
- Cores: hex dos sete tons do preset claro do app (`PECA_META`); o neutro foi
  clareado para o tema escuro. Chave de tema fica para o item 3.

## Como carregar

Dev: skill `plugin-authoring` + copiar para `~/.claude/dev-mods/<sessão>/`
(hot reload). Ou `claude --plugin-dir ~/opc-plugins/plugins/aidv-autos`.
Validação: `claude plugin validate <dir>`; tipos: `tsc` com o `.d.ts` que a
skill grava (`tsconfig` sugerido no cabeçalho do arquivo); testes:
`claude plugin test <dir>` (`tests/autos.test.ts`, terminal + desktop).
Fora do engine (sem os tipos das tools MCP que ele grava ao carregar), o
`tsc` acusa o matcher `{ tool: TOOL }` do `tool.call`: é do ambiente, não do
código. No `marketplace.json` e na `SETUP_PLUGINS` desde 06/10/2026.
