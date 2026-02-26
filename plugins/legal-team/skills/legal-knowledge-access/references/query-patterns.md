# Padroes de Query por Area do Direito

## Direito Civil

| Tema | Queries Recomendadas |
|------|---------------------|
| Responsabilidade civil | "responsabilidade civil objetiva", "dano moral", "nexo causal" |
| Contratos | "inadimplemento contratual", "resolucao contrato", "clausula penal" |
| Propriedade | "usucapiao", "direito real", "registro imovel" |
| Familia | "alimentos", "guarda compartilhada", "divorcio litigioso" |
| Sucessoes | "heranca", "inventario", "testamento", "legitima" |

## Direito do Trabalho

| Tema | Queries Recomendadas |
|------|---------------------|
| Rescisao | "dispensa imotivada", "justa causa", "rescisao indireta" |
| Verbas | "horas extras", "adicional insalubridade", "FGTS" |
| Vinculo | "vinculo empregaticio", "subordinacao", "pejotizacao" |

## Direito Processual Civil

| Tema | Queries Recomendadas |
|------|---------------------|
| Recursos | "agravo de instrumento", "recurso especial admissibilidade", "embargos declaracao" |
| Tutela | "tutela antecipada", "tutela de urgencia", "tutela evidencia" |
| Execucao | "cumprimento sentenca", "penhora", "impenhorabilidade" |
| Prescricao | "prescricao intercorrente", "prazo prescricional", "marco interruptivo" |

## Direito Tributario

| Tema | Queries Recomendadas |
|------|---------------------|
| ICMS | "ICMS base calculo", "substituicao tributaria", "creditamento" |
| IR | "imposto renda", "fato gerador", "isencao" |
| Execucao fiscal | "CDA", "excecao pre-executividade", "redirecionamento socio" |

## Direito do Consumidor

| Tema | Queries Recomendadas |
|------|---------------------|
| Vicio | "vicio produto", "vicio servico", "prazo reclamacao" |
| Praticas abusivas | "clausula abusiva", "venda casada", "publicidade enganosa" |
| Responsabilidade | "fato produto", "responsabilidade fornecedor", "excludente" |

## Combinacao de Bases por Cenario

| Cenario | Bases Prioritarias | Ordem |
|---------|-------------------|-------|
| Fundamentar tese | legal-knowledge-base → STJ | Lei primeiro, depois jurisprudencia |
| Verificar posicao tribunal | STJ → legal-knowledge-base | Jurisprudencia primeiro |
| Analisar caso concreto | case-knowledge → STJ | Fatos primeiro, depois precedentes |
| Retomar trabalho anterior | cogmem → case-knowledge | Memoria primeiro |
| Elaborar peca | case-knowledge → legal-knowledge-base → STJ | Fatos → Lei → Jurisprudencia |
