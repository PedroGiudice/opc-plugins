# Scripts da skill gerar-peca-cmr

Copias de RELEASE dos geradores CMR. A fonte de EDICAO e
`case-docs/scripts/gerar_{peca,contrato,aditamento}_cmr.py` (VM) — editar la
e re-copiar aqui a cada bump do plugin (hashes devem bater; nao editar aqui).

| Script | Classe | Uso |
|--------|--------|-----|
| gerar_peca_cmr.py | PecaCMR | Pecas processuais (numeracao automatica, padrao CMR) |
| gerar_contrato_cmr.py | ContratoCMR | Contratos no template CMR |
| gerar_aditamento_cmr.py | AditamentoCMR | Aditamentos bilingues sobre .docx-base (fidelidade byte a byte) |
| gerar_resposta_notificacao_cmr.py | RespostaNotificacaoCMR | Cartas de resposta a notificacao extrajudicial (Arial 12, 1.15, sem numeracao) |

Dependencia: python-docx (instalado nas duas maquinas).
