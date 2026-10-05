# aidv-autos

Mod do Claude Code (plugin de hooks de função) que desenha as buscas nos
autos do caso, feitas pela tool `search` do plugin `case-knowledge`, na
linguagem do AiDV em vez do JSON cru. Item 2 do roteiro "AiDV dentro do
Claude" (ver `case-docs/docs/contexto/05102026-mods-claude-code-aidv-contexto.md`).

## O que desenha

- **Linha da busca no transcript** (`ui.render` em `ToolUse`): "Buscou nos
  autos: «query» (filtros) · N trechos em M peças", dobrada por padrão, com os
  botões "Detalhes" (lista de peças na própria linha: marcador de família
  ■ ato / ○ expediente / ◆ anexo, rótulo da peça em português na cor do tom
  AiDV, fls., data de juntada, parte e título) e "Ver no painel". Enquanto
  roda: "Buscando nos autos: …". Erro e interrupção têm linha própria.
- **Bloco de resultado** (`ToolResult`): nunca desenha o JSON. A lista vive
  na linha, porque dentro de um grupo de tools o motor não desenha esse site.
- **Painel "Autos do caso"** (`Pane`, id `aidv-autos`): buscas da sessão no
  topo (alternam a selecionada), trechos da busca selecionada com preview
  limpo e os botões "Peça inteira" e "Contexto", que chamam as tools
  `document`/`contexto` pelo próprio mod (`$.mcp.call`) e mostram a peça no
  painel, SEM o modelo no loop e sem gastar contexto. A leitura usa as mesmas
  regras de exibição do app (`lib/leituraContent.ts` do extractor-lab:
  `parseContent`, `reflow`, `splitList`, portadas sem alteração): título em
  negrito, lista em itens, tabela como bloco, nota de rodapé discreta, timbre
  de página omitido. "Continuar leitura" traz a próxima fatia (`from_chunk`).
  "Pedir ao Claude que leia" submete um prompt (único botão que gasta turno).

O JSON que o modelo recebe NÃO muda: o mod lê uma cópia do `text` em
`tool.call` e guarda em `$.state` (`buscas`, `aberto`, `selecionada`,
`leitura`).

## Gotchas medidos no Desktop (05/10/2026)

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
skill grava (`tsconfig` sugerido no cabeçalho do arquivo). Ainda FORA do
`marketplace.json`.
