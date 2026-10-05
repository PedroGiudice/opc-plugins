# aidv-contexto (mod, protótipo)

Mod do Claude Code (function hooks, CC >= 2.1.287) que desenha, na faixa acima do
prompt (`AbovePrompt`), o estado do contexto da sessão em português: barra
segmentada por categoria (instruções, ferramentas, memória do caso, autos do
caso, jurisprudência, legislação, conversa), percentual e tokens, pasta da
sessão, conselho a partir de 75%, e os limites de uso de 5 h e da semana.

Primeiro item do roteiro "AiDV dentro do Claude Code" (ver
`case-docs/docs/contexto/05102026-mods-claude-code-aidv-contexto.md`).

**Ainda NÃO está no marketplace** (`.claude-plugin/marketplace.json`): é
protótipo em desenvolvimento, carregado por hot reload na sessão do CTO.
Para carregar em sessão própria: `claude --plugin-dir plugins/aidv-contexto`.

Validar: `claude plugin validate plugins/aidv-contexto`.

Como funciona a separação "autos / jurisprudência / legislação": o motor só
conhece a categoria "Messages" (conversa + resultados de tool). O hook
`tool.call` mede o texto que cada tool jurídica (case-knowledge, stj-vec,
legal-vec) devolve (estimativa chars/4, só no laço principal) e desconta da
conversa; `session.compact` zera a medição.
