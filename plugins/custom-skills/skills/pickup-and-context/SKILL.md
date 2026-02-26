---
name: pickup-and-context
description: Workflow de encerramento de sessao que produz dois documentos - um de contextualizacao e outro de prompt de retomada para continuar o trabalho numa nova sessao. Use quando o usuario pedir para documentar a sessao, preparar retomada, criar contexto de encerramento, fazer handoff, encerrar sessao, ou salvar progresso. Trigger terms - encerrar sessao, retomada, pickup, contexto da sessao, documentar sessao, preparar proxima sessao, handoff, salvar progresso, continuar depois, proximo prompt, prompt de retomada, fechar sessao.
---

# Pickup and Context

## Proposito

Ao final de uma sessao produtiva, gerar dois documentos que permitam a continuidade do trabalho em uma nova sessao com zero perda de contexto:

1. **Documento de Contextualizacao** -- registro detalhado do que foi feito, decisoes, estado atual
2. **Prompt de Retomada** -- prompt pronto para colar numa nova sessao, com instrucoes diretas

## Quando Usar

- Usuario pede para encerrar/fechar a sessao
- Usuario pede para preparar retomada / handoff
- Usuario pede documentos de contexto para continuar depois
- Final natural de um ciclo de trabalho longo
- Antes de trocar de assunto/branch/projeto

**Anunciar ao iniciar:** "Vou usar o workflow pickup-and-context para documentar esta sessao."

---

## Workflow (4 fases)

### Fase 1: Coleta

Antes de escrever qualquer coisa, levantar:

1. **Git diff/status** -- o que mudou nesta sessao
2. **Commits realizados** -- `git log --oneline` do branch atual
3. **Arquivos editados** -- listar com contexto do que cada um faz
4. **Decisoes tomadas** -- o que foi debatido e decidido
5. **Pendencias** -- o que ficou para depois (issues abertas, TODOs)
6. **Planos existentes** -- verificar `docs/plans/` por planos em execucao
7. **Branch atual** -- nome e se ha PR aberto

### Fase 2: Triagem

Nem tudo precisa ser documentado. Filtrar pelo criterio:

- **Incluir:** decisoes arquiteturais, bugs resolvidos, mudancas de API, estado de planos, pendencias criticas, informacoes tecnicas que a proxima sessao precisa
- **Excluir:** tentativas falhas triviais, refatoracoes cosmeticas, informacoes obvias do codebase

Ver [context-density.md](resources/context-density.md) para criterios detalhados.

### Fase 3: Escrita

Produzir os dois documentos seguindo os templates abaixo.

Consultar os resources antes de escrever:
- [prompt-structure.md](resources/prompt-structure.md) -- hierarquia e formato do prompt
- [actionable-instructions.md](resources/actionable-instructions.md) -- como escrever proximos passos
- [state-continuation.md](resources/state-continuation.md) -- padroes de continuidade
- [anti-patterns.md](resources/anti-patterns.md) -- erros comuns a evitar

### Fase 4: Salvamento

- Localizar a pasta `docs/` do projeto (quase todos os repos tem uma)
- Se nao existir, criar `docs/`
- Subpastas:
  - Contexto: `docs/contexto/` (criar se necessario)
  - Prompt: `docs/prompts/` (criar se necessario)
- Nomear com data: `DDMMYYYY-<slug-descritivo>.md`

---

## Template 1: Documento de Contextualizacao

```markdown
# Contexto: <Titulo Descritivo>

**Data:** YYYY-MM-DD
**Sessao:** <nome do branch ou ID>
**Duracao:** <estimativa>

---

## O que foi feito

### 1. <Primeiro item significativo>
<Descricao tecnica concisa. Incluir codigo/configs relevantes em blocos.>

### 2. <Segundo item>
<Idem.>

## Estado dos arquivos

| Arquivo | Status |
|---------|--------|
| `path/to/file.ext` | Criado / Modificado / Deletado - breve descricao |

## Commits desta sessao

```
<hash> <mensagem>
```

## Pendencias identificadas

1. **<Pendencia>** -- descricao e prioridade
2. **<Pendencia>** -- descricao e prioridade

## Decisoes tomadas

- <Decisao X>: <justificativa>
- <Decisao Y>: <justificativa>
```

**Regras do documento de contexto:**
- Ser **denso e tecnico** -- outro agente vai consumir isso
- Incluir snippets de codigo/config quando definem interfaces entre componentes
- Tabelas para dados estruturados (arquivos, metricas)
- Nao omitir nomes de arquivos, funcoes, endpoints
- Nao copiar arquivos inteiros -- referenciar com path

---

## Template 2: Prompt de Retomada

```markdown
# Retomada: <Titulo Descritivo>

## Contexto rapido

<1-3 paragrafos resumindo o que foi feito e o estado atual. Suficiente para
uma nova sessao entender a situacao sem ler o documento de contexto.>

## Arquivos principais

- `path/to/key/file.ext` -- <o que faz>
- `docs/contexto/<doc>.md` -- contexto detalhado desta sessao
- `docs/plans/<plano>.md` -- plano em execucao (se houver)

## Proximos passos (por prioridade)

### 1. <Passo mais urgente>
**Onde:** arquivo e funcao exata
**O que:** mudanca concreta
**Por que:** motivacao em 1 frase
**Verificar:** comando de teste

### 2. <Segundo passo>
<Idem.>

## Como verificar

```bash
<Comandos para validar que tudo esta funcionando>
```
```

**Regras do prompt de retomada:**
- Ser **acionavel** -- a nova sessao deve poder comecar a trabalhar imediatamente
- Referenciar arquivos com paths relativos ao root do projeto
- Se ha um plano em `docs/plans/`, apontar para ele e indicar em que task parou
- Incluir comandos de verificacao (build, test, run)
- Cada passo com: onde, o que, por que, como verificar

---

## Convencoes de Nomenclatura

| Documento | Path | Nome |
|-----------|------|------|
| Contexto | `docs/contexto/` | `DDMMYYYY-<slug>.md` |
| Prompt | `docs/prompts/` | `DDMMYYYY-<slug>.md` |

Usar o mesmo slug para ambos, facilitando correlacao.

---

## Resources

Para aprofundamento em cada aspecto:

| Resource | Foco |
|----------|------|
| [prompt-structure.md](resources/prompt-structure.md) | Hierarquia, ordenacao, formato |
| [context-density.md](resources/context-density.md) | O que incluir/excluir, teste de densidade |
| [actionable-instructions.md](resources/actionable-instructions.md) | Proximos passos eficazes |
| [state-continuation.md](resources/state-continuation.md) | Padroes de continuidade entre sessoes |
| [anti-patterns.md](resources/anti-patterns.md) | 7 erros comuns com correcoes |
