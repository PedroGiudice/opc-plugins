import { expect, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'
import type { RenderElement } from 'claude-code'

declare const h: (type: unknown, props: unknown, ...children: unknown[]) => RenderElement

const PLUGIN = 'aidv-passos'
const SURFACES = ['terminal', 'desktop'] as const

async function textos(ui: Pick<Mounted, 'findAll'>): Promise<string> {
  const ts = await ui.findAll({ type: 'Text' })
  return ts.map(t => t.text).join(' | ')
}

const base = {
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
}

for (const surface of SURFACES) {
  test(`${surface}: Bash com descrição vira a frase da descrição, com Detalhes`, async $ => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      props: {
        ...base,
        tool_use_id: 't1',
        tool: 'Bash',
        input: { command: 'python3 gerar_peca_cmr.py contestacao.md', description: 'Gerar a contestação em .docx' },
        output: { stdout: 'ok', stderr: '' },
      },
    })
    expect(await textos(ui)).toContain('Gerar a contestação em .docx')
    expect(await ui.find({ key: 'det-t1' })).toBeDefined()
    await ui.press({ key: 'det-t1' })
    expect(await textos(ui)).toContain('$ python3 gerar_peca_cmr.py contestacao.md')
  })

  test(`${surface}: Bash sem descrição fica genérico, nunca adivinha`, async $ => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      props: { ...base, tool_use_id: 't2', tool: 'Bash', input: { command: 'ls -la' }, output: { stdout: '', stderr: '' } },
    })
    expect(await textos(ui)).toContain('Rodou um comando')
  })

  test(`${surface}: .docx salvo no stdout vira evento de documento`, async $ => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      props: {
        ...base,
        tool_use_id: 't3',
        tool: 'Bash',
        input: { command: 'python3 gerar_peca_cmr.py', description: 'Gerar a contestação' },
        output: { stdout: 'Tabelas: 2\nSalvo: /home/opc/cases/x/Contestacao.docx\n', stderr: '' },
      },
    })
    const t = await textos(ui)
    expect(t).toContain('Montou o documento Contestacao.docx')
    expect(t).toContain('/home/opc/cases/x/Contestacao.docx')
  })

  test(`${surface}: guard de sobrescrita vira "gravou ao lado"`, async $ => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      props: {
        ...base,
        tool_use_id: 't4',
        tool: 'Bash',
        input: { command: 'python3 gerar_peca_cmr.py' },
        output: {
          stdout: "[GUARD] NAO sobrescrevi 'Contestacao.docx': editado no Word.\n[GUARD] A versao nova foi gravada ao lado como: 'Contestacao (2).docx'.\n",
          stderr: '',
        },
      },
    })
    expect(await textos(ui)).toContain('Gravou o documento ao lado: Contestacao (2).docx')
  })

  test(`${surface}: erro nunca escondido`, async $ => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      props: {
        ...base,
        isErrored: true,
        tool_use_id: 't5',
        tool: 'Bash',
        input: { command: 'python3 gerar_peca_cmr.py', description: 'Gerar a contestação' },
        output: 'Traceback (most recent call last):\n  File "x.py", line 3\nModuleNotFoundError: No module named docx\n',
      },
    })
    const t = await textos(ui)
    expect(t).toContain('Falhou:')
    expect(t).toContain('Gerar a contestação')
    expect(t).toContain('ModuleNotFoundError')
  })

  test(`${surface}: Read do briefing do caso`, async $ => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      props: {
        ...base,
        tool_use_id: 't6',
        tool: 'Read',
        input: { file_path: 'C:\\Users\\ana\\cases\\LaVioletera-Salesforce\\CLAUDE.md' },
        output: { type: 'text', file: { filePath: 'x', content: '# Caso' } },
      },
    })
    expect(await textos(ui)).toContain('Leu o briefing do caso')
  })

  test(`${surface}: em curso mostra o gerúndio, sem botão`, async $ => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      props: { ...base, isRunning: true, tool_use_id: 't7', tool: 'Grep', input: { pattern: 'rescisão' } },
    })
    expect(await textos(ui)).toContain('Procurando no texto: «rescisão»')
    expect(await ui.find({ key: 'det-t7' })).toBeUndefined()
  })

  test(`${surface}: grupo dobrado — cabeçalho próprio só no terminal; no desktop fica nativo`, async ($, on) => {
    // O que está abaixo do mod é o engine: no teste, este hook faz as vezes dele.
    on('ui.render', { component: 'ToolGroup' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return h(Text, null, 'cabeçalho nativo')
    })
    const call = (id: string, tool: string, input: unknown, output?: unknown) => ({
      ...base,
      tool_use_id: id,
      tool,
      input,
      output,
    })
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolGroup',
      props: {
        isActive: false,
        isExpanded: false,
        calls: [
          call('g1', 'Read', { file_path: '/cases/x/CLAUDE.md' }, {}),
          call('g2', 'Read', { file_path: '/cases/x/MAPA_PROCESSUAL.md' }, {}),
          call('g3', 'Bash', { command: 'python3 gerar_peca_cmr.py' }, { stdout: 'Salvo: /cases/x/Peca.docx', stderr: '' }),
        ],
      },
    })
    const t = await textos(ui)
    if (surface === 'terminal') {
      expect(t).toContain('3 operações')
      expect(t).toContain('2 leituras, 1 documento')
    } else {
      expect(t).toContain('cabeçalho nativo')
      expect(t).not.toContain('operações')
    }
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  })
}

for (const surface of SURFACES) {
  test(`${surface}: tool jurídica fora da busca ganha frase própria`, async $ => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      props: {
        ...base,
        tool_use_id: 'm1',
        tool: 'mcp__plugin_case-knowledge_case-knowledge__memoria_search',
        input: { query: 'notificação do Francisco' },
        output: { content: [{ type: 'text', text: '{"results":[]}' }] },
      },
    })
    expect(await textos(ui)).toContain('Consultou a memória do caso: «notificação do Francisco»')
  })

  test(`${surface}: ToolSearch vira "Carregou ferramentas"`, async $ => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      props: { ...base, tool_use_id: 'm2', tool: 'ToolSearch', input: { query: 'select:WebFetch' }, output: 'ok' },
    })
    expect(await textos(ui)).toContain('Carregou ferramentas')
  })
}

test('prompt.compose acrescenta a seção das descrições em português', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'core', text: 'base', scope: 'shared' as const }] }))
  const r = await $.prompt.compose({ model: 'claude-fable-5-1', promptModel: 'claude-fable-5-1', surfaces: ['desktop'], tools: ['Bash'], outputStyle: null, traits: [] })
  const secao = r.sections.find(s => s.id === 'aidv-passos:descricoes')
  expect(secao?.scope).toBe('session')
  expect(secao?.text).toContain('português do Brasil')
  expect(r.sections[0]?.id).toBe('core')
})

for (const surface of SURFACES) {
  test(`${surface}: tool jurídica leva o glifo e a cor da fonte (§ verde da legislação)`, async $ => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      props: { ...base, tool_use_id: 'c1', tool: 'mcp__plugin_legal-vec-tools_legal-vec-tools__sources', input: {}, output: '{}' },
    })
    const glifo = await ui.find({ type: 'Text', text: '§' })
    expect(glifo?.props.color).toBe('#22603a')
  })

  test(`${surface}: comando de bastidor leva a cor da categoria`, async $ => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      props: { ...base, tool_use_id: 'c2', tool: 'Bash', input: { command: 'ls', description: 'Listar' }, output: { stdout: '', stderr: '' } },
    })
    const glifo = await ui.find({ type: 'Text', text: '›' })
    expect(glifo?.props.color).toBe('#8a4a0b')
  })
}

// Leituras de peça e de julgado: a linha mostra o que o resultado diz (peça,
// processo, órgão, relator, data), nunca o identificador interno da base.
const CK_DOC = 'mcp__plugin_case-knowledge_case-knowledge__document'
const STJ_DOC = 'mcp__plugin_stj-vec-tools_stj-vec-tools__document'
const LEI_DOC = 'mcp__plugin_legal-vec-tools_legal-vec-tools__document'

const julgado = (doc: Record<string, string>) => ({
  content: [{ type: 'text', text: JSON.stringify({ document: doc, chunks: [{ id: 'x:0', content: 'ACÓRDÃO\nVistos...', tipo: 'NÃO É O TIPO' }] }, null, 2) }],
})

for (const surface of SURFACES) {
  test(`${surface}: inteiro teor do STJ mostra processo, órgão, relator e julgamento`, async $ => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      viewport: { columns: 160, rows: 40 },
      props: {
        ...base,
        tool_use_id: 'j1',
        tool: STJ_DOC,
        input: { doc_id: '173423225' },
        output: julgado({
          id: '173423225', processo: 'AREsp 2132923', classe: 'ARESP', ministro: 'MOURA RIBEIRO',
          orgao_julgador: 'TERCEIRA TURMA', data_julgamento: '2022-12-12', data_publicacao: '2022-12-14', tipo: 'ACÓRDÃO',
        }),
      },
    })
    const t = await textos(ui)
    expect(t).toContain('Leu o inteiro teor: AREsp 2132923 · acórdão, Terceira Turma, Min. Moura Ribeiro, julgamento em 12/12/2022')
    expect(t).not.toContain('173423225')
    await ui.press({ key: 'det-j1' })
    expect(await textos(ui)).toContain('doc_id: 173423225')
  })

  test(`${surface}: decisão monocrática sem órgão nem julgamento usa a publicação`, async $ => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      viewport: { columns: 160, rows: 40 },
      props: {
        ...base,
        tool_use_id: 'j2',
        tool: STJ_DOC,
        input: { doc_id: '132591956' },
        output: julgado({
          id: '132591956', processo: 'REsp 1925971', classe: 'RESP', ministro: 'LUIS FELIPE SALOMÃO',
          orgao_julgador: '', data_julgamento: '', data_publicacao: '2021-09-01', tipo: 'DECISAO',
        }),
      },
    })
    expect(await textos(ui)).toContain('Leu o inteiro teor: REsp 1925971 · decisão, Min. Luis Felipe Salomão, publicação em 01/09/2021')
  })

  test(`${surface}: inteiro teor em curso ou ilegível não mostra o número interno`, async $ => {
    const rodando = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      props: { ...base, isRunning: true, tool_use_id: 'j3', tool: STJ_DOC, input: { doc_id: '346123902' } },
    })
    expect(await textos(rodando)).toContain('Lendo o inteiro teor de um julgado')
    expect(await textos(rodando)).not.toContain('346123902')
    const ilegivel = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      props: { ...base, tool_use_id: 'j4', tool: STJ_DOC, input: { doc_id: '346123902' }, output: 'documento não encontrado' },
    })
    expect(await textos(ilegivel)).toContain('Leu o inteiro teor de um julgado')
    expect(await textos(ilegivel)).not.toContain('346123902')
  })

  test(`${surface}: peça inteira mostra a classe e o arquivo, sem .json nem #p`, async $ => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      props: {
        ...base,
        tool_use_id: 'p1',
        tool: CK_DOC,
        input: { segmento: 'Salesforce x Redebrasil - evento 107 ao 117.json#p0009' },
        output: {
          content: [{
            type: 'text',
            text: 'Segmento: Salesforce x Redebrasil - evento 107 ao 117.json#p0009\nArquivo: Salesforce x Redebrasil - evento 107 ao 117.json\nPeca: sentenca\nTitulo: SENTENÇA\nChunks 2-4 de 3 (ordem sequencial)\n\n--- chunk 2 ---\nPeca: não é o cabeçalho',
          }],
        },
      },
    })
    const t = await textos(ui)
    expect(t).toContain('Leu a peça inteira: Sentença · Salesforce x Redebrasil - evento 107 ao 117 (pág. 9)')
    expect(t).not.toContain('.json')
    expect(t).not.toContain('#p0009')
  })

  test(`${surface}: peça com aviso de corte e subtipo, e leitura em curso`, async $ => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      props: {
        ...base,
        tool_use_id: 'p2',
        tool: CK_DOC,
        input: { segmento: 'autos parte 2.json#p0107' },
        output: {
          content: [{
            type: 'text',
            text: '[aviso: documento maior que o limite de output — entregue ate o chunk 33 de 40. Continue com from_chunk=34.]\nSegmento: autos parte 2.json#p0107\nArquivo: autos parte 2.json\nPeca: contestacao/merito\nChunks 28-33 de 6 (ordem sequencial)\n\n',
          }],
        },
      },
    })
    expect(await textos(ui)).toContain('Leu a peça inteira: Contestação · autos parte 2 (pág. 107)')
    const rodando = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      props: { ...base, isRunning: true, tool_use_id: 'p3', tool: CK_DOC, input: { segmento: 'autos parte 2.json#p0107' } },
    })
    expect(await textos(rodando)).toContain('Lendo a peça inteira: autos parte 2 (pág. 107)')
  })

  test(`${surface}: documento inteiro (sem segmento) tira o .json do nome`, async $ => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      props: {
        ...base,
        tool_use_id: 'p4',
        tool: CK_DOC,
        input: { documento: 'Procuração.json' },
        output: { content: [{ type: 'text', text: 'Documento: Procuração.json\nChunks 0-0 de 1 (ordem sequencial)\n\n' }] },
      },
    })
    const t = await textos(ui)
    expect(t).toContain('Leu a peça inteira: Procuração')
    expect(t).not.toContain('.json')
  })

  test(`${surface}: dispositivo da legislação pelo rótulo legível`, async $ => {
    for (const [id, esperado] of [
      ['cpc_art_1012', 'Leu o dispositivo: CPC, art. 1012'],
      ['processo_administrativo_art_61', 'Leu o dispositivo: processo administrativo, art. 61'],
      ['sumula_stj_547', 'Leu o dispositivo: Súmula 547 do STJ'],
      ['xpto-9', 'Leu um dispositivo'],
    ] as const) {
      const ui = await $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: 'ToolUse',
        props: { ...base, tool_use_id: `l-${id}`, tool: LEI_DOC, input: { doc_id: id }, output: '{"chunks":[]}' },
      })
      expect(await textos(ui)).toContain(esperado)
    }
  })
}
