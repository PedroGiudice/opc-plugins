import { expect, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

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

  test(`${surface}: grupo dobrado conta por categoria e abre a pedido`, async $ => {
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
    expect(t).toContain('3 passos de bastidor')
    expect(t).toContain('2 leituras, 1 documento')
    await ui.press({ key: 'grupo-g1' })
  })
}
