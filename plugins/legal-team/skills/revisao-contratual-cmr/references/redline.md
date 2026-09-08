# Redline: mecânica, ferramentas e armadilhas

Biblioteca: `scripts/redline_docx.py` (Python 3, sem dependência além da
stdlib; `python-docx` só nos testes). Roda na VM e na cmr-002. Testes:
`python -m pytest scripts/tests -q`.

## Fluxo

1. **Radiografia** do original:
   `python scripts/redline_docx.py radiografia minuta.docx`
   Mostra partes do pacote, marcas por autor (ins/del), comentários,
   placeholders, cada parágrafo com índice, numeração (`numId, ilvl`) e se
   carrega marcas de terceiro. `--json` para consumo programático.
2. **Texto por parágrafo** para escolher âncoras:
   `python scripts/redline_docx.py texto minuta.docx --modo vivo|aceito|rejeitado`
   Âncora = trecho ÚNICO do texto vivo do parágrafo (a biblioteca recusa
   trecho ambíguo ou ausente).
3. **Operações** num JSON (ou via biblioteca):

```json
[
  {"op": "editar", "onde": "prazo máximo de", "de": "()", "para": "30 (trinta)"},
  {"op": "inserir", "onde": "Foro da Comarca", "ancora": "Belo Horizonte", "texto": ", Estado de Minas Gerais"},
  {"op": "substituir", "onde": "7.1. A infração", "texto": "7.1. Nova redação integral com **negrito**."},
  {"op": "excluir", "onde": "9.4.3."},
  {"op": "novo_paragrafo", "modelo": "9.5.", "texto": "9.6. Parágrafo novo, herda numeração do modelo."},
  {"op": "novo_paragrafo", "modelo": "3.1.1", "apos": "3.1.3", "texto": "\"Produto\" significa [● descrição, registro ANVISA nº ●].", "ilvl": 2},
  {"op": "novo_paragrafo", "modelo": "ANEXO I", "apos": "ÚLTIMO PARÁGRAFO", "texto": "ANEXO II", "quebra_pagina": true}
]
```

   `python scripts/redline_docx.py aplicar minuta.docx ops.json "minuta - redline CMR 08.09.2026.docx" --autor "CMR Advogados"`
   Imprime `ok` por operação, `ins=/del=/autores=` e `divergencias=` (deve
   ser 0). Falha na operação N para tudo sem gravar.
4. **Verificação** (obrigatória):
   `python scripts/redline_docx.py verificar minuta.docx "minuta - redline CMR ....docx"`
   Rejeitar todas as marcas do redline tem de devolver exatamente o original;
   qualquer divergência é alteração sem marca (invisível na visão "aceito").
   Depois ler `texto --modo aceito` e conferir remissões e numeração.
5. **Render com markup** onde houver Word (cmr-002, sem LibreOffice):
   PowerShell + COM, `ExportAsFixedFormat(<pdf>, 17)` com
   `ActiveWindow.View.RevisionsFilter.Markup = 2` e `Item = 7`, depois PyMuPDF
   (`fitz`) para PNG e leitura das páginas. Na VM não há renderizador: usar
   `pandoc --track-changes=all -t markdown` para conferir.
6. **Comentários** (respostas a comentários de terceiro, decisões que não
   cabem em texto): `comment.py` da skill `docx` (`--parent <id>` para
   responder encadeado) + marcadores `commentRangeStart/End` no
   `document.xml`. Sem os marcadores o comentário existe mas não aparece.

## Regras que a biblioteca impõe

- Reescreve **só `word/document.xml`**; estilos, numeração, cabeçalho,
  rodapé, mídia e comentários existentes são copiados byte a byte, na mesma
  ordem do pacote.
- Edita por **texto vivo**: o texto fora de qualquer `w:ins`/`w:del`. Blocos
  de terceiros são opacos: nunca se edita dentro deles e eles nunca são
  reescritos. Para "restaurar" trecho que a contraparte excluiu, inserir de
  novo logo após o `w:del` dela (âncora no texto vivo vizinho), não mexer na
  marca dela.
- Parágrafo novo herda `pPr` do modelo (numeração automática, recuo,
  espaçamento) e a fonte do primeiro run do modelo; marca de parágrafo
  inserida (`w:rPr/w:ins`) faz o Word tratar como inserção integral.
- Exclusão de parágrafo marca a marca de parágrafo (`w:rPr/w:del`) e todos os
  runs; ao aceitar, o Word funde com o seguinte.
- `**negrito**` no texto de entrada vira `w:b`; `&`, `<`, `>` escapados;
  `xml:space="preserve"` em todo `w:t` novo.
- IDs de marca começam acima do maior `w:id` existente.
- Autor e data parametrizáveis (`--autor`, `--data`).

## Limitações (v1)

- Parágrafos dentro de tabelas não são editáveis (tabelas são blocos
  opacos). Quadro de assinaturas e anexos tabulares: editar à mão no Word ou
  gerar o anexo como parágrafos.
- Runs com tabulação, quebra de linha, campos, hiperlinks e conteúdo
  controlado são opacos: o texto deles não entra no texto vivo. Se a âncora
  cai dentro de um deles, escolher outra âncora do mesmo parágrafo.
- Renumeração automática de listas não é feita por código (Word renumera ao
  aceitar porque o parágrafo herda `numPr`). Numeração DIGITADA ("9.4.3.")
  precisa de edição explícita nos parágrafos seguintes.

## Armadilhas que já custaram retrabalho

- Acento no nome do arquivo quebra pandoc, `Copy-Item` e caminho UNC: copiar
  para nome ASCII no scratchpad; `SendUserFile` não aceita caminho UNC.
- Console Windows em cp1252 estoura com `●`: `PYTHONUTF8=1
  PYTHONIOENCODING=utf-8`.
- `zip` não existe no bash do Windows: a biblioteca regrava com `zipfile`.
- Pontuação suprimida sem `w:del` é invisível na visão "aceito": só
  `verificar` pega.
- Parágrafo inserido herdando marca de exclusão do parágrafo que substituiu
  (bloco "fundido" no render): usar `novo_paragrafo` + `excluir`, nunca
  editar o `pPr` à mão.
- Rodapé com total de páginas digitado ("1/4") em template de cliente:
  trocar por campo `NUMPAGES`.
- Regex `.*?` sobre `document.xml` inteiro em Python pode explodir (10 GB de
  RAM em documento com runs muito fragmentados): usar a biblioteca, que
  tokeniza por parágrafo.
- Marcas de outro autor: preservar sempre; se a rodada sai em nome do sócio
  ("Carlos Magno"), o autor é parâmetro, não edição manual do XML.
- Comentários internos do cliente/template (nomes de RH, notas ao redator)
  não podem vazar no entregável: remover `word/comments*.xml` e as relações
  antes de enviar, ou gerar a partir de cópia limpa.
