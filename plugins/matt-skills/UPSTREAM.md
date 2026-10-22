# Origem e adaptações

Cópia de https://github.com/mattpocock/skills (MIT, ver `LICENSE`), commit base
`5beb35b` (2026-10-19, plugin 1.3.1). Substitui o Superpowers desde 22/10/2026
(decisão do CEO). A configuração que o Matt grava por repo (`/setup-matt-pocock-skills`)
vive aqui numa regra global única: `~/.claude/rules/matt-skills.md`.

## O que ficou de fora

- `setup-matt-pocock-skills`: substituído pela regra global.
- `triage`: fila de issues de terceiros com labels; não temos esse fluxo.
- `in-progress/` e `misc/`: fora do plugin dele também.
- `agents/openai.yaml` de cada skill: só serve ao Codex.

## O que mudou no texto (diff mínimo, texto segue em inglês)

- `grilling`: formato da rodada sem emoji (`**Q1**` e `Recommendation:`).
- `wizard/template.sh`: símbolos trocados por texto.
- `to-spec`, `to-tickets`, `implement-spec`, `code-review`, `wayfinder`: o "rode
  `/setup-matt-pocock-skills`" virou ponteiro para a regra global.
- `ask-matt`: sem a entrada de `/triage`; a precondição aponta a regra global.

## Como trazer atualização do Matt

```bash
git clone --depth 1 https://github.com/mattpocock/skills /tmp/mp
git -C /tmp/mp log --oneline 5beb35b..HEAD -- skills/engineering skills/productivity
diff -ru --exclude=agents /tmp/mp/skills/engineering/<skill> plugins/matt-skills/skills/<skill>
```

Aplicar o que valer, reaplicar as adaptações acima, atualizar o commit base aqui e
fazer bump de versão no `plugin.json`.
