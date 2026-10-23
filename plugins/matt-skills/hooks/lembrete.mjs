// Lembrete curto no início da sessão (e depois de /clear e da compactação).
// Substitui o gancho do Superpowers, que injetava a skill using-superpowers
// inteira; aqui só se aponta a regra global, que é quem diz o que invocar.
// O texto não repete a tabela da regra para não divergir dela.

const lembrete = [
  "Processo de engenharia: plugin matt-skills.",
  "Em tarefa de desenvolvimento (feature, mudança de comportamento, bug, implementação, revisão antes de commit),",
  "aplique a tabela \"Quando invocar\" de ~/.claude/rules/matt-skills.md e chame a skill pelo Skill tool ANTES de agir, sem esperar pedido.",
  "Pergunta simples, leitura ou conversa não pede skill.",
].join(" ");

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lembrete },
  }),
);
