---
name: gerar-peca-cmr
description: Gerar pecas processuais formatadas no padrao CMR Advogados usando python-docx. Use quando precisar gerar .docx de contestacao, replica, peticao inicial ou qualquer peca processual. Template com numeracao automatica, paragrafos vazios, Century Gothic 12pt, espacamento 1.5x.
---

# Gerador de Pecas Processuais — Template CMR Advogados

## Biblioteca

O script esta em `case-docs/scripts/gerar_peca_cmr.py`. Importe a classe `PecaCMR`:

```python
import sys
sys.path.insert(0, "/home/opc/case-docs/scripts")
from gerar_peca_cmr import PecaCMR
```

**NAO crie outro script. NAO copie o codigo. Importe e use a classe.**

## API

```python
peca = PecaCMR()

# Estrutura do documento
peca.enderecamento("EXCELENTÍSSIMO SENHOR DOUTOR JUIZ...")  # Bold, sem recuo
peca.espacos(5)                                              # N paragrafos vazios
peca.processo("1234567-89.2025.8.26.0100")                  # Bold
peca.espacos(3)
peca.qualificacao("EMPRESA LTDA., pessoa jurídica...")       # Recuo 4cm
peca.qualificacao_complexa(                                   # Com bold/italic inline
    ("EMPRESA LTDA.", True),                                  # (texto, bold)
    (", pessoa jurídica...", False),                          # (texto, bold, italic)
)
peca.espaco()                                                # 1 paragrafo vazio (Enter)
peca.titulo_peca("CONTESTAÇÃO")                              # Centralizado, 14pt, bold

# Capitulos e subcapitulos (numeracao automatica)
peca.capitulo("TEMPESTIVIDADE")                              # I. II. III. (romano, 13pt, bold)
peca.subcapitulo("ILEGITIMIDADE PASSIVA",                    # A. B. C. (letra, bold)
    num_id=PecaCMR.NUM_SUBCAP_PRELIM)                        # ou NUM_SUBCAP_MERITO

# Corpo (numeracao decimal sequencial por toda a peca)
peca.corpo("Texto do paragrafo...")                          # 1. 2. 3. (decimal, recuo 4cm)
peca.corpo_complexo(                                          # Com formatacao mista
    ("Texto normal ", False),
    ("software", False, True),                               # italic
    (" mais texto ", False),
    ("Ré", True),                                            # bold
)
peca.corpo_sem_numero("Texto sem numeracao")                 # Recuo 4cm, sem numero

# Citacoes em bloco
peca.citacao_bloco(                                           # 11pt, italic, recuo 4cm
    "Texto da ementa...",
    "(STJ, REsp 1.234.567/SP, Rel. Min. Fulano, j. 01/01/2025)"  # Ref sem italic
)
peca.citacao_bloco_multi(                                     # Ementa com multiplos paragrafos
    "Paragrafo 1 da ementa...",
    "Paragrafo 2 da ementa...",
    referencia="(STJ, REsp...)"
)

# Itens numerados
peca.item_pedido("texto do item")                            # i. ii. iii. (romano minusculo)
peca.item_requerimento("texto do item")                      # a. b. c. (letra minuscula)
peca.sub_item("texto do sub-item")                           # Nivel 1 da lista de corpo

# Tabela
peca.tabela(
    ["Coluna 1", "Coluna 2"],
    [["valor", "valor"], ["valor", "valor"]]
)

# Fecho
peca.fecho("São Paulo", "09 de dezembro de 2025")
peca.assinatura("Nome", "OAB/SP nº 123.456")
peca.assinatura_dupla("Nome1", "OAB1", "Nome2", "OAB2")

# Salvar
peca.salvar("caminho/arquivo.docx")
```

## Regras criticas

1. **Paragrafo vazio entre cada paragrafo de conteudo** — use `peca.espaco()` entre cada chamada. Excecoes: capitulo seguido de subcapitulo (sem espaco), paragrafos consecutivos do mesmo fluxo.

2. **Numeracao automatica** — NUNCA digite numeros manualmente ("1.", "I.", "a."). A numeracao e gerada pelo Word via `numId`. Use os metodos corretos.

3. **Italico para termos estrangeiros** — use `corpo_complexo()` com `(texto, False, True)` para *software*, *SaaS*, *ad causam*, *compliance*, etc.

4. **Bold para nomes de partes** — use `corpo_complexo()` com `(texto, True)` para **Ré**, **Autora**, **SALESFORCE LTDA.**, etc.

5. **Citacao de jurisprudencia** — ementa integral em `citacao_bloco()` (italic 11pt) + referencia (sem italic). Nunca trecho solto.

## Constantes uteis

```python
PecaCMR.NUM_CORPO          # 10 — paragrafos de corpo (1. 2. 3.)
PecaCMR.NUM_CAPITULO       # 11 — capitulos (I. II. III.)
PecaCMR.NUM_SUBCAP_PRELIM  # 12 — subcapitulos preliminares (A. B.)
PecaCMR.NUM_SUBCAP_MERITO  # 13 — subcapitulos merito (A. B. C.)
PecaCMR.NUM_ITEM_ROMANO    # 14 — itens romano minusculo (i. ii.)
PecaCMR.NUM_ITEM_LETRA     # 15 — itens letra minuscula (a. b.)
```

## Template de referencia

Documento completo com todas as especificacoes de formatacao: `case-docs/docs/template-formatacao-cmr.md`
