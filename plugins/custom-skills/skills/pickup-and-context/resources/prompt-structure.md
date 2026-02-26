# Estrutura de Prompts de Retomada

Referencia para construir prompts de retomada que o Claude Code consiga processar com maxima eficiencia.

---

## Principio: Hierarquia Clara

Um prompt de retomada nao e prosa -- e um documento estruturado. O Claude processa melhor quando a informacao esta organizada em blocos logicos com delimitacao explicita.

### Ordem recomendada (do mais estatico ao mais dinamico)

1. **Contexto do projeto** -- o que e, onde esta, stack
2. **Estado atual** -- o que ja foi feito, em que ponto estamos
3. **Arquivos relevantes** -- paths exatos para o Claude ler
4. **Instrucoes de acao** -- o que fazer agora
5. **Restricoes** -- o que NAO fazer, limites, cuidados

Essa ordem segue a logica de cache de prompt da Anthropic: conteudo estatico primeiro, conteudo dinamico depois.

## Uso de Secoes Markdown

Para prompts de retomada, usar headings Markdown (##) e bem mais pratico que XML tags. O Claude Code ja e otimizado para interpretar Markdown estruturado.

```markdown
## Contexto
<paragrafo denso>

## Estado Atual
<lista de itens com status>

## Arquivos Principais
- `path/to/file.ext` -- descricao

## Proximos Passos
### 1. Primeiro passo
<instrucoes detalhadas>

## Restricoes
- Nao substituir X, estender
- Zero dependencias novas
```

## Quando Usar XML Tags

Reservar XML para casos onde o Markdown nao e suficiente:

- Blocos de dados estruturados que precisam ser parseados
- Instrucoes que devem ser tratadas como "sistema" vs "usuario"
- Separar metadata de conteudo

```xml
<session_metadata>
branch: feature/xyz
last_commit: abc123
pending_tests: 3
</session_metadata>
```

## Referencia Cruzada

O prompt deve SEMPRE referenciar o documento de contexto correspondente:

```markdown
Leia o contexto detalhado antes de prosseguir:
`docs/contexto/08022026-sdk-reporter-pipeline-completo.md`
```

Isso permite que o prompt seja curto e acionavel enquanto o contexto fica disponivel sob demanda.
