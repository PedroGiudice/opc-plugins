# Grounding: fontes, ordem e limites

Regra: nenhum dispositivo entra no memorando ou em cláusula sem ter sido lido
na base ou em fonte oficial. O que não foi localizado vai na lista "Não
localizados na base — verificar antes de citar".

## 1. Base de legislação (`legal-vec-tools:search`)

- Buscar em lote por tema, 2 a 3 rodadas (8 a 16 queries numa revisão
  típica), não uma query por cláusula.
- **Quando o artigo é conhecido, NÃO buscar: ler direto** com
  `legal-vec-tools:document`, `doc_id` = `<fonte>_art_<número>` (ex.
  `codigo_civil_art_1078`, `lsa_art_118`, `clt_art_468`, `cpc_art_784`,
  `in_81_2020_art_9`). A busca é densa e o chunk é o artigo inteiro:
  parágrafo com conteúdo diferente do caput (CC 1.078 §3º) não sobe nem com
  o número na query (medido em 08/09/2026). Se o `document` devolver vazio,
  aí sim buscar pelo tema e listar como não localizado se nada vier.
- Filtros úteis: `fonte` (`planalto/codigo_civil`, `planalto/lsa`,
  `planalto/clt`, `planalto/cpc`, `planalto/defesa_concorrencia`,
  `planalto/representacao_comercial`, `planalto/locacoes`, `planalto/lgpd`,
  `planalto/anticorrupcao`, `planalto/simples_nacional`,
  `planalto/registro_empresas`, `drei/...`, `cade/...`, `alesp/itcmd_sp`),
  `materia` (civil, empresarial, trabalhista, tributario, processual).
- `legal-vec-tools:document` para ler o dispositivo inteiro pelo `doc_id`
  (ex. `codigo_civil_art_1078`).
- A base é **brasileira e federal** (mais normas infralegais e estaduais
  ingeridas em lote). Direito estrangeiro: web, fonte oficial, declarar.

## 2. Jurisprudência (`stj-vec-tools:search`)

Só quando a posição depende de tese (non-compete válido com limite temporal e
espacial; requalificação de corretagem; dano in re ipsa). Usar
`filters: {secao: "ementa"}`. Jurisprudência é insumo da análise; em
memorando de revisão e em cláusula não se transcreve acórdão. Se o operador
pedir citação, vale a regra do projeto: ementa integral ou só o número.

## 3. Documentos do caso e memória

- `case-knowledge:search`/`document` quando o caso tem base embedada
  (frequentemente NÃO tem: contrato consultivo vive na pasta, não na base).
- `case-knowledge:memoria_search`: o que já foi decidido neste caso em
  sessões anteriores (rodadas anteriores, posições de recuo, ordem de
  concessão).

## 4. Web, quando a base não cobre

Ordem de fontes que funcionam (testado em set/2026):

| Fonte | Para quê | Como |
|-------|----------|------|
| `https://normas.leg.br/api/public/normas?urn=<URN LexML>&tipo_documento=maior-detalhe` | texto por dispositivo, multivigente, de CF, CC, CPC, LGPD, Lei 14.133 e leis recentes (ex. 14.905/2024) | JSON; `workExample[].text` nos nós folha; muitas leis antigas voltam só metadados |
| Planalto compilado (`.../compilado.htm`) | texto vigente com tachado de revogações | WebFetch (na cmr-002 não há curl; PowerShell `Invoke-WebRequest` serve); o Planalto bloqueia a VM em alguns períodos |
| gov.br (DREI, CADE, RFB) | IN DREI 81/2020 e anexos (PDF), resoluções CADE, INs da RFB (sijut) | WebFetch; PDF nato-digital lido com PyMuPDF (cmr-002) ou `pdftotext` (VM) |
| ALESP / Fazenda-SP | lei paulista (ITCMD 10.705/2000, versão atualizada) | HTML |
| `legin` da Câmara | **só** publicação original (não é o texto vigente) | não usar para citar redação atual |

Nunca: citar número de lei "de memória"; usar resumo de site comercial como
fonte; tratar `publicacaooriginal` como vigente.

## 5. O que registrar no memorando

- Seção D: dispositivos verificados (um por linha, com o que dizem).
- Lista "Não localizados na base": verificar antes de citar.
- Direito estrangeiro ou infralegal recente verificado na web: dizer a fonte
  e a data da consulta.
