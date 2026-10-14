# aidv-contexto (mod)

Mod do Claude Code (function hooks, CC >= 2.1.287) que desenha, na faixa acima do
prompt (`AbovePrompt`), o que o Desktop não separa sobre o contexto da sessão:
barra segmentada por categoria (instruções, ferramentas, memória do caso, autos
do caso, jurisprudência, legislação, conversa) com legenda em tokens, conselho a
partir de 75% ("Contexto cheio", "Quase no limite") e os limites de uso de 5 h e
da semana. A faixa fica vazia até a primeira medida.

Desde a 0.5.0 (15/10/2026) o percentual global, o total de tokens e a pasta da
sessão NÃO estão mais na faixa: o Desktop passou a mostrá-los no trilho direito
(cartões Context e Environment), e a colega via o mesmo número duas vezes. O
cartão Context abre o detalhe por categoria do motor, mas não distingue autos,
jurisprudência, legislação e memória: essa separação continua sendo deste mod.

Primeiro item do roteiro "AiDV dentro do Claude Code" (ver
`case-docs/docs/contexto/05102026-mods-claude-code-aidv-contexto.md`).

Instalar: `/plugin install aidv-contexto --marketplace PedroGiudice/opc-plugins`
(nas máquinas do escritório o sync do case-knowledge instala e atualiza sozinho;
reiniciar a sessão do Claude para carregar a versão nova). Para desenvolver em
sessão própria: `claude --plugin-dir plugins/aidv-contexto`.

Validar: `claude plugin validate plugins/aidv-contexto`.

Como funciona a separação "autos / jurisprudência / legislação": o motor só
conhece a categoria "Messages" (conversa + resultados de tool). O hook
`tool.call` mede o texto que cada tool jurídica (case-knowledge, stj-vec,
legal-vec) devolve (estimativa chars/4, só no laço principal) e desconta da
conversa; `session.compact` zera a medição.
