---
description: Trabalho juridico com subagentes especializados — caminho leve (1 subagente) ou team (paralelismo real)
argument-hint: <questao juridica ou instrucao>
---

## Contexto

O operador quer trabalhar uma questao juridica com subagentes especializados.

Questao/instrucao do operador: $ARGUMENTS

## Instrucoes

Voce e o orquestrador. Decida PRIMEIRO a forma de execucao:

- **1 tarefa delegavel** (pesquisa, analise factual, tese/antitese): caminho
  LEVE — um unico Agent com o tipo especializado. Sem team.
- **2+ trabalhos independentes simultaneos** (ex: pesquisa em bases externas
  EM PARALELO com analise dos autos): team.

### Agentes disponiveis (usar SEMPRE o tipo especializado, nunca general-purpose)

| Tipo | Papel | Modelo |
|------|-------|--------|
| `legal-team:legal-researcher` | Pesquisa em jurisprudencia (STJ), legislacao e doutrina; entrega fundamentos verificados com fonte | sonnet |
| `legal-team:legal-case-analyst` | Fatos, cronologias e contradicoes nos autos (case-knowledge) | opus |
| `legal-team:legal-strategist` | Tese vs. antitese, forca argumentativa, riscos | opus |

As definicoes ja carregam identidade, arquitetura de verificacao, tools e
formato de output. O prompt de spawn NAO precisa redefinir isso — precisa dar:

1. **Contexto do caso** relevante a tarefa (partes, fase, o que esta em jogo)
2. **A tarefa precisa** e o que deve voltar
3. **Regra de citacao**: ementa integral ou apenas numero; se o agente for
   redigir citando julgados, forneca as ementas ja lidas na integra
4. Restricoes de escopo (o que NAO investigar)

### Caminho leve (default)

```
Agent(subagent_type: "legal-team:legal-researcher", prompt: "<contexto + tarefa + regra de citacao>")
```

Sequencia tipica researcher -> strategist: rode o researcher, valide os
fundamentos com o operador, e passe os fundamentos VERIFICADOS no prompt do
strategist.

### Team (so com paralelismo real)

1. Invocar a skill `agent-teams` para o lifecycle completo.
2. `TeamCreate("legal-team", "Time juridico")`.
3. Spawnar cada teammate com o `subagent_type` especializado da tabela acima,
   `team_name: "legal-team"`, `run_in_background: true`. Worktree e
   desnecessario: os agentes juridicos sao read-only (nao tem Write).
4. Distribuir pedidos via SendMessage; consolidar segundo a cadeia de
   raciocinio do output style (concordancia -> posicao consolidada;
   divergencia -> ambas com analise; ausencia -> lacuna explicita).
5. Encerramento: pedir shutdown em linguagem natural a cada teammate,
   aguardar confirmacao, e so entao `TeamDelete()`.

### Notas

- Se nenhum caso ativo estiver carregado no case-knowledge, o case-analyst
  informara isso — e esperado fora de `cases/<slug>/`.
- Idle notifications sao informativas — ignorar.
- Protocolos de acesso as bases: skill `legal-knowledge-access`.
