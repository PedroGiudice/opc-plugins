# Scripts da skill revisao-contratual-cmr

Copia de RELEASE. A fonte de EDICAO e `case-docs/scripts/redline_docx.py`
(VM), com testes em `case-docs/scripts/tests/test_redline_docx.py` — editar
la e re-copiar aqui (lib + teste) a cada bump do plugin; hashes devem bater.

| Script | Uso |
|--------|-----|
| redline_docx.py | Biblioteca + CLI: `radiografia`, `texto`, `aplicar` (JSON de operacoes), `verificar`. Marcas de revisao (w:ins/w:del) sobre o document.xml ORIGINAL, formatacao intocada, marcas de terceiro preservadas |
| tests/test_redline_docx.py | Suite (pytest + python-docx para fixtures). `python -m pytest tests -q` |

Dependencias: stdlib para a biblioteca; `pytest` e `python-docx` para os testes.
