---
name: gerar-peca-cmr
description: Gerar documentos .docx no padrao CMR Advogados usando python-docx. Use quando precisar gerar peca processual (contestacao, replica, peticao inicial, recurso), contrato ou aditamento em .docx. Template com numeracao automatica, paragrafos vazios, Century Gothic 12pt, espacamento 1.5x. Os scripts geradores ACOMPANHAM esta skill (scripts/), funcionam na VM e na cmr-002.
---

# Gerador de Documentos — Padrao CMR Advogados

## Biblioteca (acompanha a skill)

Os geradores estao no subdiretorio `scripts/` DESTA skill — o mesmo diretorio
deste SKILL.md, em qualquer maquina. Resolva o path a partir da localizacao da
skill (voce a conhece por ter carregado este arquivo) e importe a classe:

```python
import sys
sys.path.insert(0, r"<dir-desta-skill>/scripts")
from gerar_peca_cmr import PecaCMR          # pecas processuais
# from gerar_contrato_cmr import ContratoCMR      # contratos
# from gerar_aditamento_cmr import AditamentoCMR  # aditamentos sobre .docx-base
```

**NAO crie outro gerador. NAO copie o codigo. NAO use copias soltas antigas
(ex: C:\Users\pedro\cases\gerar_peca_cmr.py) — a versao canonica e a da skill.**
Dependencia: python-docx (ja instalado nas duas maquinas).

## Qual gerador usar

| Documento | Classe | Observacao |
|-----------|--------|------------|
| Peca processual | `PecaCMR` | API completa abaixo |
| Contrato | `ContratoCMR` | Recria formatacao CMR |
| Aditamento (bilingue, sobre template) | `AditamentoCMR` | Usa um .docx de referencia como DOCUMENTO-BASE (formatacao herdada byte a byte); modos FILL (placeholders) e BUILD (clona paragrafos-modelo). Requer `template_path` |

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

Documento completo com todas as especificacoes de formatacao:
`case-docs/docs/template-formatacao-cmr.md` (path da VM; na cmr-002 as regras
criticas acima bastam — em duvida de formatacao, siga-as e pergunte ao operador).

## Manutencao (para sessoes de dev)

Fonte de EDICAO dos geradores: `case-docs/scripts/` na VM. As copias em
`scripts/` desta skill sao de release — re-copiar e bumpar o plugin a cada
mudanca (ver `scripts/README.md`).
