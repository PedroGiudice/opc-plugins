# aidv-caso

Mod do Claude Code (plugin de hooks de função) que abre o painel do caso com
três cartões na gramática do trilho direito do Claude Desktop, com os
equivalentes do advogado. Item 3 do roteiro "AiDV dentro do Claude"
(`case-docs/docs/superpowers/specs/2026-10-15-aidv-caso-pane-design.md`).

| Cartão | O que mostra | De onde vem |
|---|---|---|
| Caso | nome; cliente e polo (polo só em processo); natureza ("Processo · tipo de ação" ou "Consultivo · subfamília"); "Autos até dd/mm/aaaa" (só em processo; sem base: "Sem autos na base") | tool `metadata` do case-knowledge por `$.mcp.call` (sem o modelo); `autos_ate` = quando o último documento entrou na base (campo da API desde 15/10/2026, CMR-282) |
| Bases | Autos, STJ, Legislação, Memória: "conectada", "sem conexão com o escritório", "entre de novo na conta", "falhou: …" ou "ainda não usada nesta sessão", com "há N min" | observação dos `tool.call` das bases (laço principal; `info` não conta, é local) + "Verificar agora" (`list_cases`, `filters`, `sources`, timeout 8 s = sem conexão); Memória (`memoria_search`) só por observação |
| Arquivos desta sessão | o que o Claude gravou na pasta do caso (Write/Edit/MultiEdit; `.docx` dos geradores via `Salvo:`/guard, caminho relativo resolvido pela pasta da sessão), "rótulo · nome · verbo · hora", com "Abrir" | `hooks/regras.ts` (cópia da regra do aidv-passos, com teste de paridade): rascunho e escrita com erro não entram |

Abre sozinho em `session.start` quando a pasta da sessão é de um caso
(`cases/<nome>`), e por `/caso`. Fora de caso nada abre e nada é sondado.

Queda de rede ("Sem conexão com …", `fetch failed`, DNS, timeout) NUNCA vira
"entre de novo": a credencial está íntegra (incidente de 08/10/2026 na cmr-002). "Como entrar de novo"
mostra a instrução do AiDV e copia o comando de login; o mod não abre o menu
do AiDV.

O que o modelo recebe NÃO muda: o mod lê cópias dos resultados e chama tools
por `$.mcp.call` (o resultado volta ao mod, sem contexto e sem turno).

## Gotchas

- Abertura não pedida pela pessoa fica aguardando abaixo de 144 colunas no
  terminal; `/caso` abre em qualquer largura. `$.ui.open` recusa
  `focus: false` (só `true` ou ausente).
- O painel solta o teclado a cada redesenho: `refocar()` 250 ms após cada ação.
- "Abrir" usa `explorer.exe` (caminho `X:\`; não `cmd /c start`, que
  interpreta `& ^ %` do nome), `open` (`/Users/`) ou `xdg-open`; falha copia o
  caminho e avisa por toast (sem área de transferência, o toast traz o caminho).
- O validate recusa import de fora da pasta do plugin: a regra de pasta do caso
  é cópia do aidv-passos (`tests/regras.test.ts` trava a paridade).
- Matchers de `tool.call` por RegExp (uma por base; `MultiEdit` não consta na
  união de nomes de tool do build, e `string` não é aceito pelo tipo).
- No kit de testes não há fundo para `session.start`, `command.register`,
  `ui.open`, `ui.toast` nem `clock.now`: `tests/comum.ts::motor(on)` e
  `mock.clock(on)` respondem por eles.
- Só desenha em sessão LOCAL do Desktop (mod instalado); na VM, pelo dev-mods.

## Como instalar

Nas máquinas do escritório chega pela task de sync do case-knowledge (lista
canônica `SETUP_PLUGINS`). À mão, num terminal:

```
/plugin install aidv-caso --marketplace PedroGiudice/opc-plugins
```

## Como carregar

Dev: skill `plugin-authoring` + copiar para `~/.claude/dev-mods/<sessão>/`
(hot reload), ou `CLAUDE_CODE_PLUGIN_DIRS` apontando para a pasta.
Gates: `claude plugin validate`, `tsc` contra o `.d.ts` da skill (tsconfig do
cabeçalho do arquivo), `claude plugin test` (`tests/*.test.ts`, terminal +
desktop).
