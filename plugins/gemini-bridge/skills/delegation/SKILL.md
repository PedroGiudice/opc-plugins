---
name: delegation-protocol
description: Quando e como delegar exploracao ao Gemini CLI via subagente gemini-bridge-explorer. Use antes de explorar codebases desconhecidos ou fazer context gathering extensivo.
---

# Delegation Protocol — Context Offloading

## Quando Delegar

Delegue ao subagente `gemini-bridge-explorer` quando:

| Situacao | Mode |
|----------|------|
| Projeto novo ou desconhecido | `onboarding` |
| Precisa entender area antes de editar | `targeted` |
| Verificar funcionamento ou consistencia | `verify` |
| Pesquisar padroes transversais no codebase | `research` |
| Voce usaria Task(Explore) | Qualquer mode adequado |

## Como Delegar

```
Task(gemini-bridge-explorer, prompt="
  Explore /caminho/absoluto/do/projeto
  Mode: onboarding
  Focus: [opcional para onboarding, obrigatorio para outros]
")
```

## Quando NAO Delegar

- Busca pontual especifica → Grep/Glob resolve
- Leitura de arquivo ja conhecido → Read com offset
- Edicao direta → Ja entende o codigo, so editar
- Confirmacao rapida de 1 linha → Read direto

## Principio

**Se a tarefa justificaria um Task(Explore), justifica delegar ao gemini-bridge-explorer.**

O beneficio e triplo:
1. Sua janela de contexto e preservada
2. O resultado vem denso e formatado
3. O Gemini tem 1M tokens de contexto para trabalho pesado
