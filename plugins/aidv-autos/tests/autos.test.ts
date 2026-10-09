import { expect, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

const PLUGIN = 'aidv-autos'
const PANE = 'aidv-autos'
const SURFACES = ['terminal', 'desktop'] as const
const STJ = 'mcp__plugin_stj-vec-tools_stj-vec-tools__search'
const CK = 'mcp__plugin_case-knowledge_case-knowledge__search'

const base = { isRunning: false, isErrored: false, isInterrupted: false }

const PERGUNTA_LONGA =
  'pessoa jurídica aquisição de software para atividade empresarial inaplicabilidade CDC finalismo mitigado vulnerabilidade técnica jurídica ou econômica não demonstrada'

const stjResposta = JSON.stringify({
  results: [
    { doc_id: '1', processo: 'REsp 1', ministro: 'NANCY ANDRIGHI', orgao_julgador: 'TERCEIRA TURMA', content: 'EMENTA\nx' },
    { doc_id: '2', processo: 'AREsp 2', ministro: 'MOURA RIBEIRO', orgao_julgador: 'TERCEIRA TURMA', content: 'EMENTA\ny' },
  ],
})

const autosResposta = [
  '=== documento: RedeBrasil x Salesforce - parte 2.json ===',
  JSON.stringify({ documento: 'RedeBrasil x Salesforce - parte 2.json', peca: 'contestacao', page_start: 113, page_end: 115, chunk_index: 3, content: 'B. INAPLICABILIDADE DO CDC' }),
  '=== documento: Salesforce x Redebrasil - evento 107.json ===',
  JSON.stringify({ documento: 'Salesforce x Redebrasil - evento 107.json', peca: 'sentenca', page_start: 9, page_end: 12, chunk_index: 2, content: 'D E C I D O' }),
].join('\n')

async function textos(ui: Pick<Mounted, 'findAll'>): Promise<string> {
  const ts = await ui.findAll({ type: 'Text' })
  return ts.map(t => t.text).join(' | ')
}

// Largura que a linha ocupa no terminal: textos, rótulos `[ x ]` dos botões e
// um espaço entre irmãos (columnGap 1).
async function larguraDaLinha(ui: Pick<Mounted, 'findAll'>): Promise<number> {
  const ts = await ui.findAll({ type: 'Text' })
  const bs = await ui.findAll({ type: 'Button' })
  const pecas = [...ts.map(t => t.text.length), ...bs.map(b => b.text.length + 4)]
  return pecas.reduce((a, n) => a + n, 0) + Math.max(0, pecas.length - 1)
}

for (const surface of SURFACES) {
  test(`${surface}: pesquisa longa no STJ cabe numa linha — pergunta cortada, contagem e botões inteiros`, async ($, on) => {
    on('tool.call', { tool: STJ }, () => ({ result: stjResposta, text: stjResposta }))
    const input = { query: PERGUNTA_LONGA, filters: { secao: 'ementa', ano_min: 2018 } }
    await $.tool.call({ tool: STJ, tool_use_id: 's1', ...input })
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      viewport: { columns: 177, rows: 40 },
      props: { ...base, tool_use_id: 's1', tool: STJ, input, output: stjResposta },
    })
    const t = await textos(ui)
    expect(t).toContain('Pesquisou jurisprudência do STJ:')
    expect(t).toContain('2 trechos em 2 julgados')
    expect(t).toContain('(seção: ementa, anos 2018–…)')
    expect(await ui.find({ key: 'det-s1' })).toBeDefined()
    expect(await ui.find({ key: 'pane-s1' })).toBeDefined()

    const pergunta = (await ui.findAll({ type: 'Text' })).find(x => x.text.startsWith('pessoa jurídica'))
    expect(pergunta?.props.wrap).toBe('truncate-end')
    expect(pergunta?.text.endsWith('…')).toBe(true)
    expect(await larguraDaLinha(ui)).toBeLessThanOrEqual(177)

    // Tela estreita: os filtros cedem antes da pergunta, contagem e botões ficam.
    const estreita = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      viewport: { columns: 120, rows: 40 },
      props: { ...base, tool_use_id: 's1', tool: STJ, input, output: stjResposta },
    })
    expect(await textos(estreita)).toContain('2 trechos em 2 julgados')
    expect(await estreita.find({ key: 'pane-s1' })).toBeDefined()
    expect(await larguraDaLinha(estreita)).toBeLessThanOrEqual(120)
  })

  test(`${surface}: pesquisa em curso também cabe numa linha`, async $ => {
    const input = { query: PERGUNTA_LONGA, filters: { secao: 'ementa' } }
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      viewport: { columns: 100, rows: 40 },
      props: { ...base, isRunning: true, tool_use_id: 's2', tool: STJ, input },
    })
    expect(await textos(ui)).toContain('Pesquisando jurisprudência do STJ:')
    expect(await larguraDaLinha(ui)).toBeLessThanOrEqual(100)
  })

  test(`${surface}: nome de arquivo dos autos sem .json no filtro e nos grupos`, async ($, on) => {
    on('tool.call', { tool: CK }, () => ({ result: autosResposta, text: autosResposta }))
    const input = { query: 'inaplicabilidade do CDC', documento: 'RedeBrasil x Salesforce - parte 2.json' }
    await $.tool.call({ tool: CK, tool_use_id: 'a1', ...input })
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      viewport: { columns: 160, rows: 40 },
      props: { ...base, tool_use_id: 'a1', tool: CK, input, output: autosResposta },
    })
    expect(await textos(ui)).toContain('documento: RedeBrasil x Salesforce - parte 2')
    await ui.press({ key: 'det-a1' })
    const t = await textos(ui)
    expect(t).toContain('Salesforce x Redebrasil - evento 107')
    expect(t).not.toContain('.json')
  })

  test(`${surface}: painel com título único das pesquisas, lista "Recentes" e filtro sem .json`, async ($, on) => {
    on('tool.call', { tool: CK }, () => ({ result: autosResposta, text: autosResposta }))
    on('tool.call', { tool: STJ }, () => ({ result: stjResposta, text: stjResposta }))
    await $.tool.call({ tool: STJ, tool_use_id: 'p1', query: 'software empresarial CDC' })
    await $.tool.call({ tool: CK, tool_use_id: 'p2', query: 'inaplicabilidade do CDC', documento: 'RedeBrasil x Salesforce - parte 2.json' })
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      requestId: PANE,
      props: { title: 'Pesquisas da sessão', isFocused: true, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    })
    const t = await textos(ui)
    expect(t).toContain('Recentes')
    expect(t).toContain('documento: RedeBrasil x Salesforce - parte 2')
    expect(t).not.toContain('.json')
  })
}
