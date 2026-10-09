import { atom, read, update } from 'claude-code'
import type { Register, RenderElement } from 'claude-code'

import type { Busca, Fonte, FonteLeitura, Leitura, Trecho } from '../types'

// ---------------------------------------------------------------------------
// Fontes de pesquisa jurídica cujas tools este mod desenha. O JSON que o
// modelo recebe NÃO muda: lemos uma cópia do `text` em `tool.call`.
// ---------------------------------------------------------------------------

const PANE = 'aidv-autos'
// Um painel só, para as três fontes: o título não muda com a pesquisa aberta.
const TITULO_PAINEL = 'Pesquisas da sessão'
const MAX_BUSCAS = 15

type Meta = {
  fonte: Fonte
  server: string
  tools: string[]
  glifo: string
  cor: string
  rodando: string
  feito: string
  falhou: string
  interrompida: string
  vazio: string
}

const COR_INFO = '#1f4f86'
const COR_LAVENDER = '#5b3fa6'
const COR_OK = '#22603a'
const COR_DANGER = '#a3321f'

const FONTES: Record<Fonte, Meta> = {
  autos: {
    fonte: 'autos',
    server: 'plugin_case-knowledge_case-knowledge',
    tools: ['mcp__plugin_case-knowledge_case-knowledge__search'],
    glifo: '■',
    cor: COR_INFO,
    rodando: 'Buscando nos autos:',
    feito: 'Buscou nos autos:',
    falhou: 'Busca nos autos falhou:',
    interrompida: 'Busca nos autos interrompida:',
    vazio: 'nenhum trecho encontrado',
  },
  stj: {
    fonte: 'stj',
    server: 'plugin_stj-vec-tools_stj-vec-tools',
    tools: ['mcp__plugin_stj-vec-tools_stj-vec-tools__search', 'mcp__plugin_stj-vec-tools_stj-vec-tools__search_formula'],
    glifo: '◈',
    cor: COR_LAVENDER,
    rodando: 'Pesquisando jurisprudência do STJ:',
    feito: 'Pesquisou jurisprudência do STJ:',
    falhou: 'Pesquisa de jurisprudência falhou:',
    interrompida: 'Pesquisa de jurisprudência interrompida:',
    vazio: 'nenhum julgado encontrado',
  },
  lei: {
    fonte: 'lei',
    server: 'plugin_legal-vec-tools_legal-vec-tools',
    tools: ['mcp__plugin_legal-vec-tools_legal-vec-tools__search'],
    glifo: '§',
    cor: COR_OK,
    rodando: 'Pesquisando a legislação:',
    feito: 'Pesquisou a legislação:',
    falhou: 'Pesquisa de legislação falhou:',
    interrompida: 'Pesquisa de legislação interrompida:',
    vazio: 'nenhum dispositivo encontrado',
  },
}

const TOOL_FONTE: Record<string, Fonte> = {}
for (const m of Object.values(FONTES)) for (const t of m.tools) TOOL_FONTE[t] = m.fonte

const buscas = atom({ plugin: 'aidv-autos', key: 'buscas' } as const, [])
const aberto = atom({ plugin: 'aidv-autos', key: 'aberto' } as const, {})
const selecionada = atom({ plugin: 'aidv-autos', key: 'selecionada' } as const, null)
const leitura = atom({ plugin: 'aidv-autos', key: 'leitura' } as const, null)

// ---------------------------------------------------------------------------
// Vocabulário das peças: rótulo humano, família (forma) e tom (cor) da
// identidade AiDV. Espelho de `pecaFamilia.ts` + `PECA_META` do extractor-lab.
// ---------------------------------------------------------------------------

type Tom = 'info' | 'warn' | 'peach' | 'danger' | 'lavender' | 'ok' | 'neutral'

const COR: Record<Tom, string> = {
  info: COR_INFO,
  warn: '#8a4a0b',
  peach: '#9a4312',
  danger: COR_DANGER,
  lavender: COR_LAVENDER,
  ok: COR_OK,
  neutral: '#8a857d',
}

const PECAS: Record<string, [string, Tom]> = {
  inicial: ['Petição inicial', 'info'],
  cumprimento_sentenca: ['Cumprimento de sentença', 'info'],
  embargos_terceiro: ['Embargos de terceiro', 'info'],
  incidente_desconsideracao_pj: ['Incidente de desconsideração da PJ', 'info'],
  contestacao: ['Contestação', 'warn'],
  replica: ['Réplica', 'warn'],
  manifestacao: ['Manifestação', 'warn'],
  manifestacao_provas: ['Manifestação sobre provas', 'warn'],
  peticao_diversa: ['Petição diversa', 'warn'],
  alegacoes_finais: ['Alegações finais', 'warn'],
  impugnacao_cumprimento_sentenca: ['Impugnação ao cumprimento de sentença', 'warn'],
  embargos_execucao: ['Embargos à execução', 'warn'],
  excecao_preexecutividade: ['Exceção de pré-executividade', 'warn'],
  decisao_interlocutoria: ['Decisão interlocutória', 'peach'],
  despacho: ['Despacho', 'peach'],
  sentenca: ['Sentença', 'danger'],
  acordao: ['Acórdão', 'lavender'],
  embargos_declaracao: ['Embargos de declaração', 'ok'],
  agravo: ['Agravo de instrumento', 'ok'],
  agravo_interno: ['Agravo interno', 'ok'],
  agravo_peticao: ['Agravo de petição', 'ok'],
  apelacao: ['Apelação', 'ok'],
  recurso_ordinario: ['Recurso ordinário', 'ok'],
  recurso_revista: ['Recurso de revista', 'ok'],
  recurso_especial: ['Recurso especial', 'ok'],
  recurso_extraordinario: ['Recurso extraordinário', 'ok'],
  contrarrazoes: ['Contrarrazões', 'ok'],
  ata_audiencia: ['Ata de audiência', 'neutral'],
  acordo: ['Acordo', 'neutral'],
  certidao: ['Certidão', 'neutral'],
  mandado: ['Mandado', 'neutral'],
  ato_ordinatorio: ['Ato ordinatório', 'neutral'],
  procuracao: ['Procuração', 'neutral'],
  contrato: ['Contrato', 'neutral'],
  comprovante: ['Comprovante', 'neutral'],
  nota_fiscal: ['Nota fiscal', 'neutral'],
  guia_custas: ['Guia de custas', 'neutral'],
  documento_pessoal: ['Documento pessoal', 'neutral'],
  documento_societario: ['Documento societário', 'neutral'],
  laudo: ['Laudo', 'neutral'],
  demonstrativo_calculo: ['Demonstrativo de cálculo', 'neutral'],
  trct: ['TRCT (rescisão)', 'neutral'],
  contracheque: ['Contracheque', 'neutral'],
  cartao_ponto: ['Cartão de ponto', 'neutral'],
  ctps: ['CTPS', 'neutral'],
  norma_coletiva: ['Norma coletiva', 'neutral'],
  certidao_divida_ativa: ['Certidão de dívida ativa', 'neutral'],
  certidao_extrajudicial: ['Certidão extrajudicial', 'neutral'],
  auto_infracao: ['Auto de infração', 'neutral'],
  outros_anexos: ['Outros anexos', 'neutral'],
}

const EXPEDIENTE = new Set(['certidao', 'mandado', 'ato_ordinatorio'])
const ANEXO = new Set([
  'comprovante', 'nota_fiscal', 'contrato', 'documento_pessoal', 'documento_societario',
  'guia_custas', 'laudo', 'procuracao', 'demonstrativo_calculo', 'trct', 'contracheque',
  'cartao_ponto', 'ctps', 'norma_coletiva', 'certidao_divida_ativa', 'certidao_extrajudicial',
  'auto_infracao', 'outros_anexos',
])

function marcador(peca: string | null): string {
  if (!peca) return '◆'
  if (EXPEDIENTE.has(peca)) return '○'
  if (ANEXO.has(peca)) return '◆'
  if (peca in PECAS) return '■'
  return '◆'
}

function rotulo(peca: string | null): string {
  if (!peca) return 'Peça não classificada'
  return PECAS[peca]?.[0] ?? peca.replace(/_/g, ' ')
}

function cor(peca: string | null): string {
  if (!peca) return COR.neutral
  return COR[PECAS[peca]?.[1] ?? 'neutral']
}

const PARTE: Record<string, string> = {
  autor: 'autor', reu: 'réu', terceiro: 'terceiro', mp: 'MP', juizo: 'juízo',
}

// Seções do acórdão como o stj-vec as rotula.
const SECAO: Record<string, string> = {
  ementa: 'ementa', ementa_citada: 'ementa citada', voto: 'voto', relatorio: 'relatório',
  acordao: 'acórdão', dispositivo: 'dispositivo', decisao: 'decisão', outros: 'outros',
}

// "TERCEIRA TURMA" -> "Terceira Turma"; "NANCY ANDRIGHI" -> "Nancy Andrighi".
const MINUSCULAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e'])
function nomeProprio(s: string | null): string {
  if (!s) return ''
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => (MINUSCULAS.has(w) && i > 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

// ---------------------------------------------------------------------------
// Utilidades de texto
// ---------------------------------------------------------------------------

function fls(ps: number | null, pe: number | null): string {
  if (ps === null) return ''
  return pe !== null && pe !== ps ? `fls. ${ps}-${pe}` : `fls. ${ps}`
}

function dataCurta(iso: string | null): string {
  if (!iso) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso
}

// O arquivo dos autos é o JSON do OCR: a extensão não diz nada ao advogado.
function semJson(nome: string): string {
  return nome.replace(/\.json$/i, '')
}

function corta(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s
}

function compacta(s: string, max = 160): string {
  return corta(s.replace(/\s+/g, ' ').trim(), max)
}

function limpaTrechoAutos(content: unknown, max = 160): string {
  if (typeof content !== 'string') return ''
  const t = content
    .replace(/\[(Page-Header|Page-Footer|Image|Text|Section-Header|List-Group|Footnote|Caption|Table)\]/g, ' ')
    .replace(/Página \d+/g, ' ')
    .replace(/PROJUDI - [^\n]*/g, ' ')
  return compacta(t, max)
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function plural(n: number, um: string, muitos: string): string {
  return `${n} ${n === 1 ? um : muitos}`
}

const VAZIO: Omit<Trecho, 'trecho' | 'documento'> = {
  chunkIndex: null, score: null, caso: null, segmentoId: null, titulo: null, peca: null,
  parte: null, paginaInicio: null, paginaFim: null, data: null, docId: null, processo: null,
  classe: null, ministro: null, orgao: null, secao: null, tipoDoc: null, rotuloLei: null,
}

// ---------------------------------------------------------------------------
// Leitura do que cada tool devolveu
// ---------------------------------------------------------------------------

// Autos: JSON por linha, com cabeçalhos `=== query: ... ===` (lote) ou
// `=== documento: ... ===` (agrupado).
function trechoAutos(o: Record<string, unknown>): Trecho {
  return {
    ...VAZIO,
    caso: str(o.caso),
    documento: str(o.documento) ?? '(documento sem nome)',
    segmentoId: str(o.segmento_id),
    titulo: str(o.segmento_titulo),
    peca: str(o.peca),
    parte: str(o.parte_peticionante),
    paginaInicio: num(o.page_start),
    paginaFim: num(o.page_end),
    data: str(o.data_juntada),
    chunkIndex: num(o.chunk_index),
    score: num(o.score),
    trecho: limpaTrechoAutos(o.content),
  }
}

function lerLotesAutos(texto: string): Busca['lotes'] {
  const lotes: Busca['lotes'] = []
  let atual: Busca['lotes'][number] = { rotulo: null, trechos: [] }
  for (const linhaCrua of texto.split('\n')) {
    const linha = linhaCrua.trim()
    const cab = /^=== (query|documento): (.*) ===$/.exec(linha)
    if (cab) {
      if (atual.trechos.length || atual.rotulo !== null) lotes.push(atual)
      atual = { rotulo: cab[1] === 'documento' ? semJson(cab[2] ?? '') : cab[2] ?? '', trechos: [] }
      continue
    }
    if (!linha.startsWith('{')) continue
    try {
      const o = JSON.parse(linha.replace(/,$/, '')) as Record<string, unknown>
      if (o && typeof o === 'object' && 'documento' in o) atual.trechos.push(trechoAutos(o))
    } catch {
      // linha que não é um resultado (aviso, degrade): ignorada
    }
  }
  if (atual.trechos.length || atual.rotulo !== null) lotes.push(atual)
  return lotes
}

// STJ e legislação: um único objeto JSON `{ results: [...] }`.
function resultadosDe(texto: string): Record<string, unknown>[] {
  const ini = texto.indexOf('{')
  if (ini < 0) return []
  try {
    const o = JSON.parse(texto.slice(ini)) as { results?: unknown }
    return Array.isArray(o.results) ? (o.results as Record<string, unknown>[]) : []
  } catch {
    return []
  }
}

function trechoStj(o: Record<string, unknown>): Trecho {
  const conteudo = typeof o.content === 'string' ? o.content.replace(/^(EMENTA|VOTO|RELATÓRIO|ACÓRDÃO)\s*\n/, '') : ''
  const processo = str(o.processo)
  return {
    ...VAZIO,
    documento: processo ?? str(o.doc_id) ?? '(julgado)',
    docId: str(o.doc_id),
    processo,
    classe: str(o.classe),
    ministro: str(o.ministro),
    orgao: str(o.orgao_julgador),
    secao: str(o.secao),
    tipoDoc: str(o.tipo),
    data: str(o.data_julgamento) ?? str(o.data_publicacao),
    chunkIndex: num(o.chunk_index),
    score: num((o.scores as Record<string, unknown> | undefined)?.dense) ?? num(o.score),
    trecho: compacta(conteudo, 200),
  }
}

const CODIGOS: Record<string, string> = {
  cf: 'CF', cc: 'CC', cpc: 'CPC', cdc: 'CDC', clt: 'CLT', cp: 'CP', cpp: 'CPP', eca: 'ECA', ctn: 'CTN',
  codigo_civil: 'Código Civil', codigo_penal: 'Código Penal', marco_seguros: 'Marco Legal dos Seguros',
}

// Rótulo curto do dispositivo: "CTN, art. 174", "Súmula 547 do STJ", "Súmula 156 do TST".
function rotuloLeiDe(docId: string | null, content: string): string {
  const cabeca = content.split(/\n/)[0] ?? ''
  const sum = /^(S[úu]mula(?: Vinculante)?\s+\d+\s+d[oa]\s+[A-Z]+)/i.exec(cabeca)
  if (sum && sum[1]) return sum[1]
  const art = /Art\.\s*([\d.]+(?:-[A-Z])?[ºo]?)/i.exec(cabeca)
  const numArt = art?.[1] ?? null
  const codigo = (cabeca.split(',')[0] ?? '').trim()
  if (docId) {
    const m = /^([a-z][a-z_]*?)_art_([\w-]+)$/i.exec(docId)
    const prefixo = m?.[1]
    const sufixo = m?.[2]
    if (prefixo && sufixo) {
      const sigla = CODIGOS[prefixo.toLowerCase()] ?? (codigo && !codigo.includes('_') ? codigo : prefixo.replace(/_/g, ' '))
      return `${sigla}, art. ${numArt ?? sufixo.replace(/_/g, '-')}`
    }
    const sm = /^sumula_([a-z]+)_(\d+)$/i.exec(docId)
    if (sm && sm[1] && sm[2]) return `Súmula ${sm[2]} do ${sm[1].toUpperCase()}`
  }
  if (numArt && codigo) return `${corta(codigo, 40)}, art. ${numArt}`
  return docId ?? corta(cabeca, 60)
}

// O texto do dispositivo sem o caminho hierárquico que o precede ("Código ..., Art. 174: ").
function corpoLei(content: string): string {
  const i = content.indexOf(': ')
  const cabeca = i > 0 ? content.slice(0, i) : ''
  if (i > 0 && i < 220 && /Art\.|S[úu]mula/i.test(cabeca)) return content.slice(i + 2)
  return content
}

function trechoLei(o: Record<string, unknown>): Trecho {
  const content = typeof o.content === 'string' ? o.content : ''
  const docId = str(o.doc_id)
  const r = rotuloLeiDe(docId, content)
  return {
    ...VAZIO,
    documento: r,
    docId,
    rotuloLei: r,
    score: num(o.dense_score) ?? num(o.score),
    trecho: compacta(corpoLei(content), 200),
  }
}

function lerLotes(fonte: Fonte, texto: string): Busca['lotes'] {
  if (fonte === 'autos') return lerLotesAutos(texto)
  const trechos = resultadosDe(texto).map(o => (fonte === 'stj' ? trechoStj(o) : trechoLei(o)))
  return trechos.length ? [{ rotulo: null, trechos }] : []
}

function queryDe(input: unknown): string {
  const q = (input as { query?: unknown })?.query
  if (typeof q === 'string') return q
  if (Array.isArray(q)) return q.map(String).join(' | ')
  return ''
}

function filtrosDe(fonte: Fonte, input: unknown): string[] {
  const i = (input ?? {}) as Record<string, unknown>
  const out: string[] = []
  if (fonte === 'autos') {
    for (const k of ['peca', 'fase', 'documento', 'categoria', 'subtipo', 'parte_peticionante']) {
      const v = i[k]
      if (typeof v === 'string' && v) out.push(k === 'peca' ? rotulo(v) : `${k}: ${k === 'documento' ? semJson(v) : v}`)
    }
    if (Array.isArray(i.casos) && i.casos.length) out.push(`casos: ${i.casos.join(', ')}`)
    return out
  }
  if (fonte === 'stj') {
    const f = (i.filters ?? {}) as Record<string, unknown>
    const nomes: Record<string, string> = {
      ministro: 'Min.', classe: 'classe', orgao_julgador: 'órgão', tipo: 'tipo', processo: 'processo',
    }
    for (const k of Object.keys(nomes)) {
      const v = f[k]
      if (typeof v === 'string' && v) out.push(`${nomes[k]} ${k === 'ministro' || k === 'orgao_julgador' ? nomeProprio(v) : v}`)
    }
    const sec = f.secao
    if (typeof sec === 'string' && sec) out.push(`seção: ${SECAO[sec] ?? sec}`)
    else if (Array.isArray(sec) && sec.length) out.push(`seções: ${sec.map(s => SECAO[String(s)] ?? String(s)).join(', ')}`)
    if (f.ano_min || f.ano_max) out.push(`anos ${f.ano_min ?? '…'}–${f.ano_max ?? '…'}`)
    if (f.data_from || f.data_to) out.push(`de ${dataCurta(str(f.data_from)) || '…'} a ${dataCurta(str(f.data_to)) || '…'}`)
    return out
  }
  for (const k of ['fonte', 'materia', 'tipo']) {
    const v = i[k]
    if (typeof v === 'string' && v) out.push(`${k === 'materia' ? 'matéria' : k}: ${v}`)
  }
  return out
}

function totais(b: Busca): { trechos: number; docs: number } {
  const chaves = new Set<string>()
  let n = 0
  for (const l of b.lotes) {
    for (const t of l.trechos) {
      n++
      chaves.add(t.docId ?? t.segmentoId ?? t.documento)
    }
  }
  return { trechos: n, docs: chaves.size }
}

function resumo(b: Busca): string {
  const t = totais(b)
  const m = FONTES[b.fonte]
  if (t.trechos === 0) return m.vazio
  if (b.fonte === 'autos') return `${plural(t.trechos, 'trecho', 'trechos')} em ${plural(t.docs, 'peça', 'peças')}`
  if (b.fonte === 'stj') return `${plural(t.trechos, 'trecho', 'trechos')} em ${plural(t.docs, 'julgado', 'julgados')}`
  return plural(t.docs, 'dispositivo', 'dispositivos')
}

// Cabeçalho (rótulo em cor + metadados) de um trecho, por fonte.
function cabecalho(t: Trecho): { marca: string; cor: string; titulo: string; meta: string; nome: string } {
  if (t.docId && t.processo !== null) {
    const meta = [nomeProprio(t.orgao), t.ministro ? `Min. ${nomeProprio(t.ministro)}` : '', dataCurta(t.data), t.secao ? SECAO[t.secao] ?? t.secao : '']
      .filter(Boolean)
      .join(' · ')
    return { marca: '◈', cor: COR_LAVENDER, titulo: t.processo, meta, nome: t.tipoDoc ? nomeProprio(t.tipoDoc) : '' }
  }
  if (t.rotuloLei) {
    return { marca: '§', cor: COR_OK, titulo: t.rotuloLei, meta: '', nome: '' }
  }
  const meta = [fls(t.paginaInicio, t.paginaFim), dataCurta(t.data), t.parte ? PARTE[t.parte] ?? t.parte : ''].filter(Boolean).join(' · ')
  const nome = t.titulo ?? semJson(t.documento)
  return { marca: marcador(t.peca), cor: cor(t.peca), titulo: rotulo(t.peca), meta, nome }
}

// Lista de resultados de uma busca, uma linha por trecho (dobra de "Detalhes").
function listaDeResultados(b: Busca, largura: number, ui: { Box: any; Text: any }): RenderElement[] {
  const { Box, Text } = ui
  const linhas: RenderElement[] = []
  for (const [li, l] of b.lotes.entries()) {
    if (l.rotulo !== null && b.lotes.length > 1) {
      linhas.push(<Text key={`lote-${li}`} dimColor italic>{corta(l.rotulo, largura)}</Text>)
    }
    for (const [ti, t] of l.trechos.entries()) {
      const c = cabecalho(t)
      const cauda = b.fonte === 'lei' ? t.trecho : c.nome
      linhas.push(
        <Box key={`t-${li}-${ti}`} columnGap={1}>
          <Text color={c.cor}>{c.marca}</Text>
          <Text color={c.cor} bold>{c.titulo}</Text>
          {c.meta ? <Text dimColor>{c.meta}</Text> : null}
          {cauda ? <Text dimColor wrap="truncate-end">{corta(cauda, Math.max(16, largura - 48))}</Text> : null}
        </Box>,
      )
    }
  }
  return linhas
}

// ---------------------------------------------------------------------------
// Leitura humana dos autos: porte de `lib/leituraContent.ts` do extractor-lab
// (parseContent, reflow, splitList), sem alteração de regra.
// ---------------------------------------------------------------------------

const CHANDRA_LABELS = [
  'Text', 'Section-Header', 'Image', 'Table', 'Page-Header', 'List-Group', 'Figure',
  'Complex-Block', 'Form', 'Footnote', 'Caption', 'Page-Footer', 'TableCell', 'Diagram',
  'Table-Of-Contents', 'Equation-Block',
] as const
type ChandraLabel = (typeof CHANDRA_LABELS)[number]
type Paragrafo = { type: ChandraLabel; text: string }
const LABEL_RE = new RegExp(`\\[(${CHANDRA_LABELS.join('|')})\\]`, 'g')

function parseContent(content: string): Paragrafo[] {
  if (!content) return []
  const out: Paragrafo[] = []
  let last = 0
  let label: ChandraLabel = 'Text'
  LABEL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LABEL_RE.exec(content)) !== null) {
    if (m.index > last) {
      const t = content.slice(last, m.index)
      if (t.trim()) out.push({ type: label, text: t })
    }
    label = m[1] as ChandraLabel
    last = LABEL_RE.lastIndex
  }
  if (last < content.length) {
    const t = content.slice(last)
    if (t.trim()) out.push({ type: label, text: t })
  }
  return out
}

function reflow(t: string): string {
  return t
    .replace(/[ \t]+\n/g, '\n')
    .replace(/([^\n])\n(?!\n)/g, '$1 ')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function splitList(t: string): string[] {
  const clean = t.replace(/[ \t]+\n/g, '\n').trim()
  let items = clean.split('\n').map(s => s.trim()).filter(Boolean)
  if (items.length <= 1) {
    items = clean
      .split(/(?=(?:^|\s)(?:[a-z]|[ivx]{1,4}|\d{1,2})[).]\s)/i)
      .map(s => s.trim())
      .filter(Boolean)
  }
  return items.length ? items : [clean]
}

function textoLegivel(bruto: string): string {
  return bruto
    .replace(/^--- chunk \d+ ---$/gm, '')
    .replace(/^\[\.\.\..*from_chunk=\d+.*\]$/gm, '')
    .replace(/^\[.*Continue com from_chunk=\d+\.?\]\s*$/gm, '')
    .trim()
}

function paragrafosAutos(texto: string, ui: { Box: any; Text: any }): RenderElement[] {
  const { Box, Text } = ui
  const out: RenderElement[] = []
  parseContent(texto).forEach((p, i) => {
    const k = `p-${i}`
    switch (p.type) {
      case 'Section-Header':
        out.push(<Box key={k} marginTop={1}><Text bold wrap="wrap">{reflow(p.text)}</Text></Box>)
        break
      case 'List-Group':
        out.push(
          <Box key={k} flexDirection="column" marginTop={1}>
            {splitList(p.text).map((it, j) => (
              <Box key={`${k}-${j}`} columnGap={1}>
                <Text dimColor>•</Text>
                <Text wrap="wrap">{it}</Text>
              </Box>
            ))}
          </Box>,
        )
        break
      case 'Table':
      case 'TableCell':
      case 'Form':
      case 'Complex-Block':
      case 'Equation-Block':
        out.push(
          <Box key={k} flexDirection="column" marginTop={1}>
            <Text dimColor italic>{p.type === 'Table' || p.type === 'TableCell' ? 'tabela' : p.type === 'Equation-Block' ? 'equação' : p.type === 'Form' ? 'formulário' : 'bloco'}</Text>
            <Text wrap="wrap">{p.text.replace(/^\n+|\n+$/g, '')}</Text>
          </Box>,
        )
        break
      case 'Footnote':
        out.push(<Box key={k} marginTop={1}><Text dimColor italic wrap="wrap">{reflow(p.text)}</Text></Box>)
        break
      case 'Caption':
      case 'Figure':
      case 'Image':
      case 'Diagram': {
        const alt = (p.text.match(/alt=["']([^"']+)["']/i) || [])[1]
        out.push(<Box key={k} marginTop={1}><Text dimColor italic>figura — {alt ?? 'imagem não incluída na leitura'}</Text></Box>)
        break
      }
      case 'Page-Header':
      case 'Page-Footer':
        break
      default:
        out.push(<Box key={k} marginTop={1}><Text wrap="wrap">{reflow(p.text)}</Text></Box>)
    }
  })
  return out
}

// Leitura de julgado e de dispositivo: o texto já vem limpo (sem rótulos do
// Chandra). Cada linha é um parágrafo; `§§ seção` vira rótulo discreto; linha
// curta toda em maiúsculas (EMENTA, VOTO, títulos numerados) sai em negrito.
function paragrafosSimples(texto: string, ui: { Box: any; Text: any }): RenderElement[] {
  const { Box, Text } = ui
  const out: RenderElement[] = []
  texto.split('\n').forEach((linhaCrua, i) => {
    const linha = linhaCrua.trim()
    if (!linha) return
    const k = `s-${i}`
    const sec = /^§§ (.*)$/.exec(linha)
    if (sec) {
      out.push(<Box key={k} marginTop={1}><Text color={COR_LAVENDER} italic>{sec[1]}</Text></Box>)
      return
    }
    const titulo = linha.length <= 80 && linha === linha.toUpperCase() && /[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/.test(linha)
    out.push(
      <Box key={k} marginTop={titulo ? 1 : 0}>
        <Text bold={titulo} wrap="wrap">{linha}</Text>
      </Box>,
    )
  })
  return out
}

function proximoDe(bruto: string): number | null {
  const m = /from_chunk=(\d+)/.exec(bruto)
  return m ? Number(m[1]) : null
}

function textoMcp(r: { content: { type: string; text?: string }[] }): string {
  return r.content.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n')
}

// Inteiro teor do STJ (`document`): `{ document, chunks[{content, section}] }`.
function textoJulgado(bruto: string): string {
  try {
    const o = JSON.parse(bruto.slice(bruto.indexOf('{'))) as { chunks?: { content?: string; section?: string }[] }
    const partes: string[] = []
    let ultima = ''
    for (const c of o.chunks ?? []) {
      const sec = c.section ? SECAO[c.section] ?? c.section : ''
      if (sec && sec !== ultima) {
        partes.push(`§§ ${sec}`)
        ultima = sec
      }
      if (c.content) {
        partes.push(
          c.content
            .replace(/^\[(VOTO|EMENTA CITADA)[^\]]*\]\s*\.?\s*/i, '')
            .replace(/^(ACÓRDÃO|EMENTA|RELATÓRIO|VOTO|DISPOSITIVO)\s*\n/, ''),
        )
      }
    }
    return partes.join('\n')
  } catch {
    return bruto
  }
}

// Dispositivo inteiro (`document` do legal-vec): `{ chunks[{content}] }`.
function textoDispositivo(bruto: string): string {
  try {
    const o = JSON.parse(bruto.slice(bruto.indexOf('{'))) as { chunks?: { content?: string }[] }
    return (o.chunks ?? []).map(c => corpoLei(c.content ?? '')).join('\n')
  } catch {
    return bruto
  }
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

export const register: Register = on => {
  for (const meta of Object.values(FONTES)) {
    for (const TOOL of meta.tools) {
      // Guarda cada pesquisa (só do laço principal) para desenhar depois.
      on('tool.call', { tool: TOOL }, async ($, e, next) => {
        if (e.agentId) return next(e)
        const nova: Busca = {
          id: e.tool_use_id,
          fonte: meta.fonte,
          query: queryDe(e),
          filtros: filtrosDe(meta.fonte, e),
          lotes: [],
          erro: null,
          concluida: false,
        }
        await update($, buscas, lista => [...lista.filter(b => b.id !== nova.id), nova].slice(-MAX_BUSCAS))

        const r = await next(e)

        const texto = 'text' in r && typeof r.text === 'string' ? r.text : ''
        const erro = 'isError' in r && r.isError ? (compacta(texto, 200) || 'A pesquisa falhou.') : null
        await update($, buscas, lista =>
          lista.map(b => (b.id === nova.id ? { ...b, lotes: erro ? [] : lerLotes(meta.fonte, texto), erro, concluida: true } : b)),
        )
        await update($, selecionada, () => nova.id)
        return r
      })

      // Linha da tool no transcript: humanizada, dobrada por padrão.
      on('ui.render', { component: 'ToolUse', props: { tool: TOOL } }, async ($, e, next) => {
        const { Box, Text, Button } = $.ui.resolve(e)
        const lista = await read($, buscas)
        const b = lista.find(x => x.id === e.props.tool_use_id)
        const abertos = await read($, aberto)

        const query = b?.query ?? queryDe(e.props.input)
        const filtros = b?.filtros ?? filtrosDe(meta.fonte, e.props.input)
        const colunas = e.viewport?.columns ?? 100

        // Uma linha só: rótulo, contagem e botões ficam inteiros; os filtros
        // cedem primeiro (cortados, ou fora da linha quando a tela é estreita:
        // seguem no painel); a pergunta leva o que sobra e é cortada no fim
        // (inteira no painel). Sem isto, uma linha mais larga que a tela
        // encolhia cada pedaço e o quebrava na própria coluna.
        const MIN_PERGUNTA = 16
        const ajusta = (fixos: string[], botoes: string[]): { q: string; f: string } => {
          const ocupado =
            fixos.filter(Boolean).reduce((n, x) => n + x.length + 1, 0) + botoes.reduce((n, x) => n + x.length + 5, 0)
          const livre = colunas - 4 - ocupado
          let f = ''
          if (filtros.length) {
            const inteiro = `(${corta(filtros.join(', '), 48)})`
            const cabe = livre - MIN_PERGUNTA - 1
            if (inteiro.length <= cabe) f = inteiro
            else if (cabe >= 14) f = `(${corta(filtros.join(', '), cabe - 2)})`
          }
          return { q: corta(query, Math.max(MIN_PERGUNTA, livre - (f ? f.length + 1 : 0))), f }
        }
        const linhaDeBusca = (glifo: RenderElement, rotulo: RenderElement, q: string, cauda: RenderElement[], dim = false) => (
          <Box columnGap={1}>
            {glifo}
            <Box flexShrink={0}>{rotulo}</Box>
            <Box flexShrink={1} minWidth={0}>
              <Text wrap="truncate-end" dimColor={dim}>{q}</Text>
            </Box>
            {cauda.length ? (
              <Box flexShrink={0} columnGap={1}>
                {cauda}
              </Box>
            ) : null}
          </Box>
        )
        const filtrosEl = (f: string): RenderElement[] => (f ? [<Text key="filtros" dimColor>{f}</Text>] : [])

        if (e.props.isRunning || !b || !b.concluida) {
          const { q, f } = ajusta([meta.glifo, meta.rodando], [])
          return linhaDeBusca(<Text color={meta.cor}>{meta.glifo}</Text>, <Text bold>{meta.rodando}</Text>, q, filtrosEl(f))
        }

        if (e.props.isInterrupted) {
          return linhaDeBusca(
            <Text dimColor>{meta.glifo}</Text>,
            <Text bold dimColor>{meta.interrompida}</Text>,
            ajusta([meta.glifo, meta.interrompida], []).q,
            [],
            true,
          )
        }

        if (b.erro || e.props.isErrored) {
          const motivo = corta(b.erro ?? '', 80)
          return linhaDeBusca(
            <Text color={COR_DANGER}>{meta.glifo}</Text>,
            <Text bold>{meta.falhou}</Text>,
            ajusta([meta.glifo, meta.falhou, motivo], []).q,
            motivo ? [<Text key="motivo" dimColor>{motivo}</Text>] : [],
          )
        }

        const t = totais(b)
        const estaAberto = abertos[b.id] === true
        const id = b.id
        const largura = Math.max(40, colunas - 8)
        const rotuloDetalhes = estaAberto ? 'Ocultar' : 'Detalhes'
        const contagem = resumo(b)

        const botoes = t.trechos > 0 ? [rotuloDetalhes, 'Ver no painel'] : []
        const { q, f } = ajusta([meta.glifo, meta.feito, '·', contagem], botoes)
        const cauda: RenderElement[] = [
          ...filtrosEl(f),
          <Text key="ponto" dimColor>·</Text>,
          <Text key="contagem" dimColor>{contagem}</Text>,
        ]
        if (t.trechos > 0) {
          cauda.push(
            <Button key={`det-${id}`} plain dimColor onPress={() => update($, aberto, a => ({ ...a, [id]: !a[id] }))}>
              {rotuloDetalhes}
            </Button>,
            <Button
              key={`pane-${id}`}
              plain
              dimColor
              onPress={async () => {
                await update($, selecionada, () => id)
                const r = await $.ui.open({ id: PANE, title: TITULO_PAINEL, columns: 64, focus: true })
                if (!r.isPlaced) $.ui.toast('Alargue a janela para ver o painel de pesquisas.')
              }}
            >
              Ver no painel
            </Button>,
          )
        }

        const linha = linhaDeBusca(
          <Text color={meta.cor}>{meta.glifo}</Text>,
          <Text bold>{meta.feito}</Text>,
          q,
          cauda,
        )

        if (!estaAberto) return linha

        // Em grupo de tools o motor não desenha o site ToolResult: a lista vive aqui.
        return (
          <Box flexDirection="column">
            {linha}
            <Box flexDirection="column" paddingLeft={2}>{listaDeResultados(b, largura, { Box, Text })}</Box>
          </Box>
        )
      })

      // Bloco do resultado (só existe fora de grupo): nunca desenha o JSON.
      on('ui.render', { component: 'ToolResult', props: { tool: TOOL } }, async ($, e) => {
        const { Box } = $.ui.resolve(e)
        return <Box />
      })
    }
  }

  // Painel: pesquisas recentes no topo, a selecionada item a item, e a
  // leitura (peça, inteiro teor ou dispositivo) pela tool, sem o modelo.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const lista = await read($, buscas)
    const sel = await read($, selecionada)
    const lendo: Leitura | null = await read($, leitura)
    const prontas = lista.filter(b => b.concluida && !b.erro)
    const b = prontas.find(x => x.id === sel) ?? prontas[prontas.length - 1]
    const largura = Math.max(30, e.props.bodyColumns - 2)

    // Pede o foco de volta ao painel: no Desktop, cada redesenho solta o
    // teclado e o clique seguinte viraria foco em vez de pressão.
    const refocar = () => {
      $.clock.after(250, () => {
        void $.ui.open({ id: PANE, title: TITULO_PAINEL, focus: true })
      })
    }

    const abrirLeitura = async (fonte: FonteLeitura, titulo: string, metaTxt: string, fromChunk: number | null) => {
      const continuando = fromChunk !== null && lendo !== null && lendo.texto.length > 0
      await update($, leitura, antes => ({
        titulo,
        meta: metaTxt,
        texto: continuando && antes ? antes.texto : '',
        erro: null,
        carregando: true,
        proximo: null,
        fonte,
      }))
      try {
        const server = FONTES[fonte.kind].server
        let bruto = ''
        let proximo: number | null = null
        let novo = ''
        if (fonte.kind === 'autos') {
          const args: Record<string, unknown> = {}
          let tool = 'document'
          if (fonte.chunkIndex !== null && fonte.segmentoId === null) {
            tool = 'contexto'
            args.documento = fonte.documento
            args.chunk_index = fonte.chunkIndex
            args.janela = 4
          } else {
            if (fonte.segmentoId) args.segmento = fonte.segmentoId
            else args.documento = fonte.documento
            if (fromChunk !== null) args.from_chunk = fromChunk
          }
          const r = await $.mcp.call(server, tool, args)
          bruto = textoMcp(r)
          if (r.isError) throw new Error(bruto || 'A leitura falhou.')
          novo = textoLegivel(bruto)
          proximo = proximoDe(bruto)
        } else {
          // Julgado e dispositivo vêm fatiados no teto de saída: o aviso no topo
          // traz o from_chunk da continuação.
          const args: Record<string, unknown> = { doc_id: fonte.docId }
          if (fromChunk !== null) args.from_chunk = fromChunk
          const r = await $.mcp.call(server, 'document', args)
          bruto = textoMcp(r)
          if (r.isError) throw new Error(bruto || 'A leitura falhou.')
          novo = fonte.kind === 'stj' ? textoJulgado(bruto) : textoDispositivo(bruto)
          proximo = proximoDe(bruto)
        }
        await update($, leitura, antes =>
          antes
            ? { ...antes, carregando: false, texto: continuando ? `${antes.texto}\n\n${novo}` : novo, proximo }
            : antes,
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await update($, leitura, antes => (antes ? { ...antes, carregando: false, erro: compacta(msg, 300) } : antes))
      } finally {
        refocar()
      }
    }

    const pedidoAoClaude = (f: FonteLeitura): string => {
      if (f.kind === 'stj') return `Leia o inteiro teor do julgado ${f.documento} (doc_id ${f.docId}) com a tool document do stj-vec e me diga o que ele traz sobre: ${f.query}`
      if (f.kind === 'lei') return `Leia o dispositivo ${f.documento} (doc_id ${f.docId}) com a tool document do legal-vec e me diga o que ele traz sobre: ${f.query}`
      if (f.segmentoId) return `Leia na íntegra o documento ${f.segmentoId} com a tool document (segmento: "${f.segmentoId}") e me diga o que ele traz sobre: ${f.query}`
      if (f.chunkIndex !== null) return `Leia o contexto ao redor do trecho ${f.chunkIndex} de "${f.documento}" com a tool contexto (documento: "${f.documento}", chunk_index: ${f.chunkIndex}) e me diga o que ele traz sobre: ${f.query}`
      return `Leia na íntegra o documento "${f.documento}" com a tool document e me diga o que ele traz sobre: ${f.query}`
    }

    // --- Leitura ---
    if (lendo) {
      const f = lendo.fonte
      const corpo = f.kind === 'autos' ? paragrafosAutos(lendo.texto, { Box, Text }) : paragrafosSimples(lendo.texto, { Box, Text })
      return (
        <Box flexDirection="column" paddingX={1}>
          <Box columnGap={2} marginBottom={1}>
            <Button key="voltar" plain dimColor onPress={async () => { await update($, leitura, () => null); refocar() }}>
              ‹ Voltar
            </Button>
            {!lendo.carregando && !lendo.erro ? (
              <Button key="pedir" plain dimColor onPress={() => $.prompt.submit({ text: pedidoAoClaude(f) })}>
                Pedir ao Claude que leia
              </Button>
            ) : null}
          </Box>
          <Text bold>{corta(lendo.titulo, largura)}</Text>
          {lendo.meta ? <Text dimColor>{lendo.meta}</Text> : null}
          <Box marginTop={1} flexDirection="column">
            {lendo.carregando && !lendo.texto ? <Text dimColor>{f.kind === 'autos' ? 'Lendo a peça…' : f.kind === 'stj' ? 'Lendo o inteiro teor…' : 'Lendo o dispositivo…'}</Text> : null}
            {lendo.erro ? <Text color={COR_DANGER}>{lendo.erro}</Text> : null}
            {lendo.texto ? corpo : null}
          </Box>
          {lendo.proximo !== null && !lendo.carregando ? (
            <Box marginTop={1} columnGap={2}>
              <Text dimColor>{f.kind === 'stj' ? 'O julgado continua.' : f.kind === 'lei' ? 'O dispositivo continua.' : 'A peça continua.'}</Text>
              <Button key="continuar" plain dimColor onPress={() => abrirLeitura(f, lendo.titulo, lendo.meta, lendo.proximo)}>
                Continuar leitura
              </Button>
            </Box>
          ) : null}
          {lendo.carregando && lendo.texto ? <Text dimColor>Carregando a continuação…</Text> : null}
        </Box>
      )
    }

    // --- Lista ---
    if (!b) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text dimColor>Nenhuma pesquisa ainda nesta sessão.</Text>
        </Box>
      )
    }

    const recentes = prontas.slice(-8)
    const cards: RenderElement[] = []
    let n = 0
    for (const [li, l] of b.lotes.entries()) {
      if (l.rotulo !== null && b.lotes.length > 1) {
        cards.push(<Text key={`pl-${li}`} italic dimColor>{corta(l.rotulo, largura)}</Text>)
      }
      for (const [ti, tr] of l.trechos.entries()) {
        n++
        const c = cabecalho(tr)
        const tituloLeitura = b.fonte === 'autos' ? `${c.titulo} · ${c.nome}` : c.titulo
        const base: FonteLeitura = { kind: b.fonte, documento: b.fonte === 'autos' ? tr.documento : c.titulo, segmentoId: null, chunkIndex: null, docId: tr.docId, query: b.query }
        const fontePeca: FonteLeitura = { ...base, segmentoId: tr.segmentoId }
        const fonteCtx: FonteLeitura = { ...base, chunkIndex: tr.chunkIndex }
        const rotuloLer = b.fonte === 'autos' ? 'Peça inteira' : b.fonte === 'stj' ? 'Inteiro teor' : 'Dispositivo inteiro'
        cards.push(
          <Box key={`c-${li}-${ti}`} flexDirection="column" marginBottom={1}>
            <Box columnGap={1}>
              <Text dimColor>{String(n).padStart(2, ' ')}</Text>
              <Text color={c.cor}>{c.marca}</Text>
              <Text color={c.cor} bold>{c.titulo}</Text>
              {c.nome && b.fonte === 'stj' ? <Text dimColor>{c.nome}</Text> : null}
            </Box>
            {c.meta ? (
              <Box paddingLeft={5}>
                <Text dimColor wrap="wrap">{c.meta}</Text>
              </Box>
            ) : null}
            {b.fonte === 'autos' && c.nome ? (
              <Box paddingLeft={5}>
                <Text wrap="truncate-end">{corta(c.nome, largura - 6)}</Text>
              </Box>
            ) : null}
            {tr.trecho ? (
              <Box paddingLeft={5}>
                <Text dimColor wrap="wrap">{corta(tr.trecho, Math.max(80, (largura - 6) * 2))}</Text>
              </Box>
            ) : null}
            <Box paddingLeft={5} columnGap={2}>
              {tr.docId || b.fonte === 'autos' ? (
                <Button key={`ler-${b.id}-${li}-${ti}`} plain dimColor onPress={() => abrirLeitura(fontePeca, tituloLeitura, c.meta, null)}>
                  {rotuloLer}
                </Button>
              ) : null}
              {b.fonte === 'autos' && tr.chunkIndex !== null ? (
                <Button key={`ctx-${b.id}-${li}-${ti}`} plain dimColor onPress={() => abrirLeitura(fonteCtx, `Contexto · ${c.nome}`, c.meta, null)}>
                  Contexto
                </Button>
              ) : null}
            </Box>
          </Box>,
        )
      }
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        {recentes.length > 1 ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text dimColor>Recentes</Text>
            {recentes.map(r => (
              <Box key={`selb-${r.id}`} columnGap={1}>
                <Text color={FONTES[r.fonte].cor} dimColor={r.id !== b.id}>{FONTES[r.fonte].glifo}</Text>
                <Button
                  key={`sel-${r.id}`}
                  plain
                  dimColor={r.id !== b.id}
                  onPress={async () => { await update($, selecionada, () => r.id); refocar() }}
                >
                  {corta(r.query, largura - 6)}
                </Button>
              </Box>
            ))}
          </Box>
        ) : null}
        <Box flexDirection="column" marginBottom={1}>
          <Box columnGap={1}>
            <Text color={FONTES[b.fonte].cor}>{FONTES[b.fonte].glifo}</Text>
            <Text bold>{corta(b.query, largura - 2)}</Text>
          </Box>
          <Text dimColor>
            {resumo(b)}
            {b.filtros.length ? ` · ${b.filtros.join(', ')}` : ''}
          </Text>
        </Box>
        {cards}
        <Box marginTop={1}>
          <Button key="fechar" plain dimColor role="dismiss" onPress={() => $.ui.close({ id: PANE })}>
            Fechar
          </Button>
        </Box>
      </Box>
    )
  })
}
