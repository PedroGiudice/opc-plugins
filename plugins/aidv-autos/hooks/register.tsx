import { atom, read, update } from 'claude-code'
import type { Register, RenderElement } from 'claude-code'

import type { Busca, Leitura, Trecho } from '../types'

// A tool de busca nos autos do caso ativo (plugin case-knowledge).
const SEARCH = 'mcp__plugin_case-knowledge_case-knowledge__search'
const PANE = 'aidv-autos'
const MAX_BUSCAS = 15

const buscas = atom({ plugin: 'aidv-autos', key: 'buscas' } as const, [])
const aberto = atom({ plugin: 'aidv-autos', key: 'aberto' } as const, {})
const selecionada = atom({ plugin: 'aidv-autos', key: 'selecionada' } as const, null)
const leitura = atom({ plugin: 'aidv-autos', key: 'leitura' } as const, null)

// O server MCP do case-knowledge, na grafia do nome da tool.
const SERVER = 'plugin_case-knowledge_case-knowledge'


// ---------------------------------------------------------------------------
// Vocabulário das peças: rótulo humano, família (forma) e tom (cor) da
// identidade AiDV. Espelho de `pecaFamilia.ts` + `PECA_META` do extractor-lab.
// Cor = fg dos sete tons do preset claro; chave de tema fica para depois.
// ---------------------------------------------------------------------------

type Tom = 'info' | 'warn' | 'peach' | 'danger' | 'lavender' | 'ok' | 'neutral'

const COR: Record<Tom, string> = {
  info: '#1f4f86',
  warn: '#8a4a0b',
  peach: '#9a4312',
  danger: '#a3321f',
  lavender: '#5b3fa6',
  ok: '#22603a',
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

// Marcador de família: quadrado cheio (ato), círculo vazado (expediente), losango (anexo).
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

// ---------------------------------------------------------------------------
// Leitura do que a tool devolveu: o texto é JSON por linha, com cabeçalhos
// `=== query: ... ===` (lote) ou `=== documento: ... ===` (agrupado). O que
// o modelo recebe NÃO muda: só lemos uma cópia para desenhar.
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

function limpaTrecho(content: unknown, max = 160): string {
  if (typeof content !== 'string') return ''
  const t = content
    .replace(/\[(Page-Header|Page-Footer|Image|Text|Section-Header|List-Group|Footnote|Caption|Table)\]/g, ' ')
    .replace(/Página \d+/g, ' ')
    .replace(/PROJUDI - [^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function trechoDe(o: Record<string, unknown>): Trecho {
  return {
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
    trecho: limpaTrecho(o.content),
  }
}

function lerLotes(texto: string): Busca['lotes'] {
  const lotes: Busca['lotes'] = []
  let atual: Busca['lotes'][number] = { rotulo: null, trechos: [] }
  for (const linhaCrua of texto.split('\n')) {
    const linha = linhaCrua.trim()
    const cab = /^=== (query|documento): (.*) ===$/.exec(linha)
    if (cab) {
      if (atual.trechos.length || atual.rotulo !== null) lotes.push(atual)
      atual = { rotulo: cab[2] ?? '', trechos: [] }
      continue
    }
    if (!linha.startsWith('{')) continue
    try {
      const o = JSON.parse(linha.replace(/,$/, '')) as Record<string, unknown>
      if (o && typeof o === 'object' && 'documento' in o) atual.trechos.push(trechoDe(o))
    } catch {
      // linha que não é um resultado (aviso, degrade): ignorada
    }
  }
  if (atual.trechos.length || atual.rotulo !== null) lotes.push(atual)
  return lotes
}

function queryDe(input: unknown): string {
  const q = (input as { query?: unknown })?.query
  if (typeof q === 'string') return q
  if (Array.isArray(q)) return q.map(String).join(' | ')
  return ''
}

function filtrosDe(input: unknown): string[] {
  const i = (input ?? {}) as Record<string, unknown>
  const out: string[] = []
  for (const k of ['peca', 'fase', 'documento', 'categoria', 'subtipo', 'parte_peticionante']) {
    const v = i[k]
    if (typeof v === 'string' && v) out.push(k === 'peca' ? rotulo(v) : `${k}: ${v}`)
  }
  if (Array.isArray(i.casos) && i.casos.length) out.push(`casos: ${i.casos.join(', ')}`)
  return out
}

function textoDoOutput(output: unknown): string | null {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output.map(b => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n')
  }
  if (output && typeof output === 'object') {
    const o = output as { text?: unknown; content?: unknown }
    if (typeof o.text === 'string') return o.text
    if (Array.isArray(o.content)) return textoDoOutput(o.content)
  }
  return null
}

function totais(b: Busca): { trechos: number; pecas: number } {
  const chaves = new Set<string>()
  let n = 0
  for (const l of b.lotes) {
    for (const t of l.trechos) {
      n++
      chaves.add(t.segmentoId ?? t.documento)
    }
  }
  return { trechos: n, pecas: chaves.size }
}

function plural(n: number, um: string, muitos: string): string {
  return `${n} ${n === 1 ? um : muitos}`
}

function corta(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s
}


// Lista de peças de uma busca, uma linha por trecho (dobra de "Detalhes").
function listaDePecas(b: Busca, largura: number, ui: { Box: any; Text: any }): RenderElement[] {
  const { Box, Text } = ui
  const linhas: RenderElement[] = []
  for (const [li, l] of b.lotes.entries()) {
    if (l.rotulo !== null && b.lotes.length > 1) {
      linhas.push(<Text key={`lote-${li}`} dimColor italic>{corta(l.rotulo, largura)}</Text>)
    }
    for (const [ti, t] of l.trechos.entries()) {
      const meta = [fls(t.paginaInicio, t.paginaFim), dataCurta(t.data), t.parte ? PARTE[t.parte] ?? t.parte : ''].filter(Boolean).join(' · ')
      const nome = t.titulo ?? t.documento.replace(/\.json$/i, '')
      linhas.push(
        <Box key={`t-${li}-${ti}`} columnGap={1}>
          <Text color={cor(t.peca)}>{marcador(t.peca)}</Text>
          <Text color={cor(t.peca)} bold>{rotulo(t.peca)}</Text>
          {meta ? <Text dimColor>{meta}</Text> : null}
          <Text dimColor wrap="truncate-end">{corta(nome, Math.max(16, largura - 48))}</Text>
        </Box>,
      )
    }
  }
  return linhas
}

// Leitura humana dos chunks: porte de `lib/leituraContent.ts` do extractor-lab
// (parseContent, reflow, splitList), sem alteração de regra. O content carrega
// rótulos do Chandra (`[Section-Header]`, `[Text]`, `[List-Group]`...) que aqui
// viram tipografia; colchetes de texto jurídico real ([sic], [g.n.]) ficam.
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

// O texto de `document`/`contexto` sem os separadores de chunk e o aviso de
// continuação (que o botão "Continuar" representa).
function textoLegivel(bruto: string): string {
  return bruto
    .replace(/^--- chunk \d+ ---$/gm, '')
    .replace(/^\[\.\.\..*from_chunk=\d+.*\]$/gm, '')
    .replace(/^\[.*Continue com from_chunk=\d+\.?\]\s*$/gm, '')
    .trim()
}

// Desenho dos parágrafos tipados, espelho de `LeituraPanel.tsx::Paragraph`
// (timbre de página omitido, como o default do app).
function paragrafos(texto: string, ui: { Box: any; Text: any }): RenderElement[] {
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

function proximoDe(bruto: string): number | null {
  const m = /from_chunk=(\d+)/.exec(bruto)
  return m ? Number(m[1]) : null
}

function textoMcp(r: { content: { type: string; text?: string }[] }): string {
  return r.content.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n')
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

export const register: Register = on => {
  // Guarda cada busca nos autos (só do laço principal) para desenhar depois.
  on('tool.call', { tool: SEARCH }, async ($, e, next) => {
    if (e.agentId) return next(e)
    const nova: Busca = {
      id: e.tool_use_id,
      query: queryDe(e),
      filtros: filtrosDe(e),
      lotes: [],
      erro: null,
      concluida: false,
    }
    await update($, buscas, lista => [...lista.filter(b => b.id !== nova.id), nova].slice(-MAX_BUSCAS))

    const r = await next(e)

    const texto = 'text' in r && typeof r.text === 'string' ? r.text : ''
    const erro = 'isError' in r && r.isError ? (texto || 'A busca falhou.') : null
    await update($, buscas, lista =>
      lista.map(b => (b.id === nova.id ? { ...b, lotes: erro ? [] : lerLotes(texto), erro, concluida: true } : b)),
    )
    await update($, selecionada, () => nova.id)
    return r
  })

  // Após compactar, os resultados saem do contexto do modelo: a lista do
  // painel continua (é do leitor), mas nada mais a alimenta até a próxima busca.

  // Linha da tool no transcript: humanizada, dobrada por padrão.
  on('ui.render', { component: 'ToolUse', props: { tool: SEARCH } }, async ($, e, next) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const lista = await read($, buscas)
    const b = lista.find(x => x.id === e.props.tool_use_id)
    const abertos = await read($, aberto)

    const query = b?.query ?? queryDe(e.props.input)
    const filtros = b?.filtros ?? filtrosDe(e.props.input)
    const q = corta(query, Math.max(24, e.viewport?.columns ? e.viewport.columns - 60 : 80))

    if (e.props.isRunning || !b || !b.concluida) {
      return (
        <Box columnGap={1}>
          <Text color={COR.info}>■</Text>
          <Text bold>Buscando nos autos:</Text>
          <Text>{q}</Text>
          {filtros.length ? <Text dimColor>({filtros.join(', ')})</Text> : null}
        </Box>
      )
    }

    if (e.props.isInterrupted) {
      return (
        <Box columnGap={1}>
          <Text dimColor>■</Text>
          <Text bold dimColor>Busca nos autos interrompida:</Text>
          <Text dimColor>{q}</Text>
        </Box>
      )
    }

    if (b.erro || e.props.isErrored) {
      return (
        <Box columnGap={1}>
          <Text color={COR.danger}>■</Text>
          <Text bold>Busca nos autos falhou:</Text>
          <Text>{q}</Text>
          <Text dimColor>{corta(b.erro ?? '', 80)}</Text>
        </Box>
      )
    }

    const t = totais(b)
    const estaAberto = abertos[b.id] === true
    const id = b.id
    const largura = Math.max(40, (e.viewport?.columns ?? 100) - 8)

    const linha = (
      <Box columnGap={1}>
        <Text color={COR.info}>■</Text>
        <Text bold>Buscou nos autos:</Text>
        <Text>{q}</Text>
        {filtros.length ? <Text dimColor>({filtros.join(', ')})</Text> : null}
        <Text dimColor>·</Text>
        {t.trechos === 0 ? (
          <Text dimColor>nenhum trecho encontrado</Text>
        ) : (
          <Text dimColor>{plural(t.trechos, 'trecho', 'trechos')} em {plural(t.pecas, 'peça', 'peças')}</Text>
        )}
        {t.trechos > 0 ? (
          <Button
            key={`det-${id}`}
            plain
            dimColor
            onPress={() => update($, aberto, a => ({ ...a, [id]: !a[id] }))}
          >
            {estaAberto ? 'Ocultar' : 'Detalhes'}
          </Button>
        ) : null}
        {t.trechos > 0 ? (
          <Button
            key={`pane-${id}`}
            plain
            dimColor
            onPress={async () => {
              await update($, selecionada, () => id)
              const r = await $.ui.open({ id: PANE, title: 'Autos do caso', columns: 64, focus: true })
              if (!r.isPlaced) $.ui.toast('Autos do caso: alargue a janela para ver o painel.')
            }}
          >
            Ver no painel
          </Button>
        ) : null}
      </Box>
    )

    if (!estaAberto) return linha

    // Em grupo de tools o motor não desenha o site ToolResult: a lista vive aqui.
    return (
      <Box flexDirection="column">
        {linha}
        <Box flexDirection="column" paddingLeft={2}>{listaDePecas(b, largura, { Box, Text })}</Box>
      </Box>
    )
  })

  // Bloco do resultado (só existe fora de grupo): nunca desenha o JSON.
  on('ui.render', { component: 'ToolResult', props: { tool: SEARCH } }, async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // Painel: buscas recentes no topo, a selecionada trecho a trecho, e a
  // leitura de uma peça (pela tool, sem o modelo) no lugar da lista.
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
        void $.ui.open({ id: PANE, title: 'Autos do caso', focus: true })
      })
    }

    const abrirLeitura = async (fonte: Leitura['fonte'], titulo: string, meta: string, fromChunk: number | null) => {
      const continuando = fromChunk !== null && lendo !== null && lendo.texto.length > 0
      await update($, leitura, antes => ({
        titulo,
        meta,
        texto: continuando && antes ? antes.texto : '',
        erro: null,
        carregando: true,
        proximo: null,
        fonte,
      }))
      try {
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
        const r = await $.mcp.call(SERVER, tool, args)
        const bruto = textoMcp(r)
        if (r.isError) {
          await update($, leitura, antes => (antes ? { ...antes, carregando: false, erro: bruto || 'A leitura falhou.' } : antes))
          return
        }
        const novo = textoLegivel(bruto)
        await update($, leitura, antes =>
          antes
            ? { ...antes, carregando: false, texto: continuando ? `${antes.texto}\n\n${novo}` : novo, proximo: proximoDe(bruto) }
            : antes,
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await update($, leitura, antes => (antes ? { ...antes, carregando: false, erro: msg } : antes))
      } finally {
        refocar()
      }
    }

    // --- Leitura de uma peça ---
    if (lendo) {
      const f = lendo.fonte
      return (
        <Box flexDirection="column" paddingX={1}>
          <Box columnGap={2} marginBottom={1}>
            <Button key="voltar" plain dimColor onPress={async () => { await update($, leitura, () => null); refocar() }}>
              ‹ Voltar
            </Button>
            {!lendo.carregando && !lendo.erro ? (
              <Button
                key="pedir"
                plain
                dimColor
                onPress={() =>
                  $.prompt.submit({
                    text: f.segmentoId
                      ? `Leia na íntegra o documento ${f.segmentoId} com a tool document (segmento: "${f.segmentoId}") e me diga o que ele traz sobre: ${f.query}`
                      : f.chunkIndex !== null
                        ? `Leia o contexto ao redor do trecho ${f.chunkIndex} de "${f.documento}" com a tool contexto (documento: "${f.documento}", chunk_index: ${f.chunkIndex}) e me diga o que ele traz sobre: ${f.query}`
                        : `Leia na íntegra o documento "${f.documento}" com a tool document e me diga o que ele traz sobre: ${f.query}`,
                  })
                }
              >
                Pedir ao Claude que leia
              </Button>
            ) : null}
          </Box>
          <Text bold>{corta(lendo.titulo, largura)}</Text>
          {lendo.meta ? <Text dimColor>{lendo.meta}</Text> : null}
          <Box marginTop={1} flexDirection="column">
            {lendo.carregando && !lendo.texto ? <Text dimColor>Lendo a peça…</Text> : null}
            {lendo.erro ? <Text color={COR.danger}>{lendo.erro}</Text> : null}
            {lendo.texto ? paragrafos(lendo.texto, { Box, Text }) : null}
          </Box>
          {lendo.proximo !== null && !lendo.carregando ? (
            <Box marginTop={1} columnGap={2}>
              <Text dimColor>A peça continua.</Text>
              <Button
                key="continuar"
                plain
                dimColor
                onPress={() => abrirLeitura(f, lendo.titulo, lendo.meta, lendo.proximo)}
              >
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
          <Text dimColor>Nenhuma busca nos autos ainda nesta sessão.</Text>
        </Box>
      )
    }

    const t = totais(b)
    const recentes = prontas.slice(-8)
    const cards: RenderElement[] = []
    let n = 0
    for (const [li, l] of b.lotes.entries()) {
      if (l.rotulo !== null && b.lotes.length > 1) {
        cards.push(<Text key={`pl-${li}`} italic dimColor>{corta(l.rotulo, largura)}</Text>)
      }
      for (const [ti, tr] of l.trechos.entries()) {
        n++
        const meta = [fls(tr.paginaInicio, tr.paginaFim), dataCurta(tr.data), tr.parte ? PARTE[tr.parte] ?? tr.parte : ''].filter(Boolean).join(' · ')
        const nome = tr.titulo ?? tr.documento.replace(/\.json$/i, '')
        const titulo = `${rotulo(tr.peca)} · ${nome}`
        const fontePeca: Leitura['fonte'] = { documento: tr.documento, segmentoId: tr.segmentoId, chunkIndex: null, query: b.query }
        const fonteCtx: Leitura['fonte'] = { documento: tr.documento, segmentoId: null, chunkIndex: tr.chunkIndex, query: b.query }
        cards.push(
          <Box key={`c-${li}-${ti}`} flexDirection="column" marginBottom={1}>
            <Box columnGap={1}>
              <Text dimColor>{String(n).padStart(2, ' ')}</Text>
              <Text color={cor(tr.peca)}>{marcador(tr.peca)}</Text>
              <Text color={cor(tr.peca)} bold>{rotulo(tr.peca)}</Text>
            </Box>
            {meta ? (
              <Box paddingLeft={5}>
                <Text dimColor>{meta}</Text>
              </Box>
            ) : null}
            <Box paddingLeft={5}>
              <Text wrap="truncate-end">{corta(nome, largura - 6)}</Text>
            </Box>
            {tr.trecho ? (
              <Box paddingLeft={5}>
                <Text dimColor wrap="wrap">{corta(tr.trecho, Math.max(80, (largura - 6) * 2))}</Text>
              </Box>
            ) : null}
            <Box paddingLeft={5} columnGap={2}>
              <Button
                key={`ler-${b.id}-${li}-${ti}`}
                plain
                dimColor
                onPress={() => abrirLeitura(fontePeca, titulo, meta, null)}
              >
                Peça inteira
              </Button>
              {tr.chunkIndex !== null ? (
                <Button
                  key={`ctx-${b.id}-${li}-${ti}`}
                  plain
                  dimColor
                  onPress={() => abrirLeitura(fonteCtx, `Contexto · ${nome}`, meta, null)}
                >
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
            <Text dimColor>Buscas desta sessão</Text>
            {recentes.map(r => (
              <Button
                key={`sel-${r.id}`}
                plain
                dimColor={r.id !== b.id}
                onPress={async () => { await update($, selecionada, () => r.id); refocar() }}
              >
                {corta(r.query, largura - 4)}
              </Button>
            ))}
          </Box>
        ) : null}
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>{corta(b.query, largura)}</Text>
          <Text dimColor>
            {t.trechos === 0 ? 'nenhum trecho encontrado' : `${plural(t.trechos, 'trecho', 'trechos')} em ${plural(t.pecas, 'peça', 'peças')}`}
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

