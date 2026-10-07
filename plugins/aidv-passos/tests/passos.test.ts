import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { RenderElement, RenderPropsOf } from 'claude-code'

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
  test(`${surface}: Bash com descrição vira a frase da descrição (no passado), com Detalhes`, async $ => {
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
    expect(await textos(ui)).toContain('Gerou a contestação em .docx')
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
    expect(t).toContain('Falhou | ao gerar a contestação')
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
    expect(glifo?.props.color).toBe('#478761')
  })

  test(`${surface}: comando de bastidor leva a cor da categoria`, async $ => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      props: { ...base, tool_use_id: 'c2', tool: 'Bash', input: { command: 'ls', description: 'Listar' }, output: { stdout: '', stderr: '' } },
    })
    const glifo = await ui.find({ type: 'Text', text: '›' })
    expect(glifo?.props.color).toBe('#ab6c2f')
  })
}

// ---------------------------------------------------------------------------
// Falha no infinitivo, conjugação da description e cores por tema (0.1.3).
// ---------------------------------------------------------------------------

type PropsDaLinha = Pick<RenderPropsOf['ToolUse'], 'tool_use_id' | 'tool' | 'input'> & Partial<RenderPropsOf['ToolUse']>

async function linhaDe($: Engine, surface: (typeof SURFACES)[number], props: PropsDaLinha) {
  return $.ui.mount({ plugin: PLUGIN, surface, component: 'ToolUse', props: { ...base, ...props } })
}

for (const surface of SURFACES) {
  test(`${surface}: falha de Read sai no infinitivo, com × e "Falhou" na cor de erro do tema`, async $ => {
    const ui = await linhaDe($, surface, {
      isErrored: true,
      tool_use_id: 'f1',
      tool: 'Read',
      input: { file_path: '/home/opc/cases/x/nao-existe.md' },
      output: 'File does not exist.',
    })
    const t = await textos(ui)
    expect(t).toContain('Falhou | ao ler o arquivo nao-existe.md')
    expect(t).not.toContain('Leu')
    expect((await ui.find({ type: 'Text', text: '×' }))?.props.color).toBe('error')
    expect((await ui.find({ type: 'Text', text: 'Falhou' }))?.props.color).toBe('error')
    // O resto da frase fica na cor do tema.
    expect((await ui.find({ type: 'Text', text: 'ao ler o arquivo nao-existe.md' }))?.props.color).toBeUndefined()
  })

  test(`${surface}: falha de tool jurídica sai no infinitivo`, async $ => {
    const manifesto = await linhaDe($, surface, {
      isErrored: true,
      tool_use_id: 'f2',
      tool: 'mcp__plugin_case-knowledge_case-knowledge__manifesto',
      input: {},
      output: { content: [{ type: 'text', text: 'Error: collection not found' }] },
    })
    expect(await textos(manifesto)).toContain('Falhou | ao ler o índice dos autos')
    const fontes = await linhaDe($, surface, {
      isErrored: true,
      tool_use_id: 'f3',
      tool: 'mcp__plugin_legal-vec-tools_legal-vec-tools__sources',
      input: {},
      output: 'Error: 401',
    })
    expect(await textos(fontes)).toContain('Falhou | ao listar as fontes da legislação')
  })

  test(`${surface}: Bash com erro: sem description, no infinitivo e fora do infinitivo`, async $ => {
    const sem = await linhaDe($, surface, {
      isErrored: true,
      tool_use_id: 'f4',
      tool: 'Bash',
      input: { command: 'ls /nada' },
      output: { stdout: '', stderr: 'ls: cannot access /nada: No such file or directory' },
    })
    expect(await textos(sem)).toContain('Falhou | ao rodar um comando')
    const infinitivo = await linhaDe($, surface, {
      isErrored: true,
      tool_use_id: 'f5',
      tool: 'Bash',
      input: { command: 'ls /nada', description: 'Listar os arquivos da pasta do caso' },
      output: { stdout: '', stderr: 'ls: cannot access /nada: No such file or directory' },
    })
    const ti = await textos(infinitivo)
    expect(ti).toContain('Falhou | ao listar os arquivos da pasta do caso')
    expect(ti).toContain('No such file or directory')
    const outra = await linhaDe($, surface, {
      isErrored: true,
      tool_use_id: 'f6',
      tool: 'Bash',
      input: { command: 'ls /nada', description: 'Arquivos da pasta do caso' },
      output: { stdout: '', stderr: 'erro' },
    })
    expect(await textos(outra)).toContain('Falhou: | Arquivos da pasta do caso')
  })

  test(`${surface}: description do Bash conjugada no passado e no gerúndio`, async $ => {
    // [description, linha concluída, linha em curso]
    const casos: [string, string, string][] = [
      ['Listar os arquivos', 'Listou os arquivos', 'Listando os arquivos…'],
      ['Gerar a peça', 'Gerou a peça', 'Gerando a peça…'],
      ['Extrair o texto', 'Extraiu o texto', 'Extraindo o texto…'],
      ['Fazer o backup', 'Fez o backup', 'Fazendo o backup…'],
      ['Ver o log', 'Viu o log', 'Vendo o log…'],
      ['Ler o arquivo', 'Leu o arquivo', 'Lendo o arquivo…'],
      ['Pôr a data', 'Pôs a data', 'Pondo a data…'],
      ['Compor a tabela', 'Compôs a tabela', 'Compondo a tabela…'],
      ['Obter a lista', 'Obteve a lista', 'Obtendo a lista…'],
      ['Construir o índice', 'Construiu o índice', 'Construindo o índice…'],
      // Fora do infinitivo: sai como veio.
      ['Documentos do caso', 'Documentos do caso', 'Documentos do caso…'],
      ['Qualquer arquivo novo', 'Qualquer arquivo novo', 'Qualquer arquivo novo…'],
      ['Por fim, gerar o .docx', 'Por fim, gerar o .docx', 'Por fim, gerar o .docx…'],
      ['Clear the cache', 'Clear the cache', 'Clear the cache…'],
    ]
    for (const [i, [descricao, feito, rodando]] of casos.entries()) {
      const input = { command: 'true', description: descricao }
      const pronto = await linhaDe($, surface, { tool_use_id: `k${i}`, tool: 'Bash', input, output: { stdout: '', stderr: '' } })
      expect(await textos(pronto)).toContain(feito)
      const curso = await linhaDe($, surface, { isRunning: true, tool_use_id: `r${i}`, tool: 'Bash', input })
      expect(await textos(curso)).toContain(rodando)
    }
  })

  test(`${surface}: glifos levam os tons novos (claro e escuro)`, async $ => {
    const cores: [string, string, unknown, string, string][] = [
      ['g1', 'mcp__plugin_case-knowledge_case-knowledge__manifesto', {}, '■', '#517db0'],
      ['g2', 'mcp__plugin_stj-vec-tools_stj-vec-tools__document', { doc_id: 'x' }, '◈', '#836cc3'],
      ['g3', 'Write', { file_path: '/cases/x/nota.md', content: 'a' }, '›', '#b66536'],
      ['g4', 'Read', { file_path: '/cases/x/nota.md' }, '›', '#8a857d'],
    ]
    for (const [id, tool, input, glifo, cor] of cores) {
      const ui = await linhaDe($, surface, { tool_use_id: id, tool, input, output: '' })
      expect((await ui.find({ type: 'Text', text: glifo }))?.props.color).toBe(cor)
    }
  })
}

test('terminal: contagem de falhas no cabeçalho do grupo usa a cor de erro do tema', async $ => {
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolGroup',
    props: {
      isActive: false,
      isExpanded: false,
      calls: [
        { ...base, tool_use_id: 'e1', tool: 'Read', input: { file_path: '/cases/x/CLAUDE.md' }, output: {} },
        { ...base, isErrored: true, tool_use_id: 'e2', tool: 'Bash', input: { command: 'x' }, output: 'erro' },
      ],
    },
  })
  expect((await ui.find({ type: 'Text', text: '1 falha' }))?.props.color).toBe('error')
})

test('prompt.compose pede a description começando pelo verbo no infinitivo', async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))
  const r = await $.prompt.compose({ model: 'claude-fable-5-1', promptModel: 'claude-fable-5-1', surfaces: ['desktop'], tools: ['Bash'], outputStyle: null, traits: [] })
  expect(r.sections.find(s => s.id === 'aidv-passos:descricoes')?.text).toContain('Comece pelo verbo no infinitivo')
})
