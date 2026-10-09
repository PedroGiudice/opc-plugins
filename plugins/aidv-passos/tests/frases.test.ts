import { expect, test } from 'claude-code/testing'
import type { Mounted, TestBody } from 'claude-code/testing'

// Frases decididas pelo CEO em 09/10/2026 a partir do inventário de comandos
// das sessões de caso (docs/contexto/09102026-inventario-comandos-sessoes-caso-mods.md).

const PLUGIN = 'aidv-passos'
const SURFACES = ['terminal', 'desktop'] as const

type Surface = (typeof SURFACES)[number]
type $T = Parameters<TestBody>[0]

const base = { isRunning: false, isErrored: false, isInterrupted: false }

let seq = 0

async function textos(ui: Pick<Mounted, 'findAll'>): Promise<string> {
  const ts = await ui.findAll({ type: 'Text' })
  return ts.map(t => t.text).join(' | ')
}

async function montar($: $T, surface: Surface, tool: string, input: unknown, output?: unknown, extra: Record<string, unknown> = {}) {
  const id = `f${++seq}`
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'ToolUse',
    viewport: { columns: 220, rows: 40 },
    props: { ...base, tool_use_id: id, tool, input, output, ...extra },
  })
  return { ui, id }
}

async function linha($: $T, surface: Surface, tool: string, input: unknown, output?: unknown, extra: Record<string, unknown> = {}) {
  const { ui } = await montar($, surface, tool, input, output, extra)
  return textos(ui)
}

const MEM = 'C:\\Users\\pedro\\cases\\salesforce-luiz-victor\\.memoria\\pedro-giudice\\'

for (const surface of SURFACES) {
  // ---------------------------------------------------------------- PowerShell
  test(`${surface}: PowerShell segue a regra do Bash`, async $ => {
    expect(await linha($, surface, 'PowerShell', { command: 'python -c "import docx"', description: 'Verifica se python-docx está instalado' }, { stdout: 'ok', stderr: '' })).toContain(
      'Verifica se python-docx está instalado',
    )
    expect(await linha($, surface, 'PowerShell', { command: 'Get-ChildItem' }, { stdout: '', stderr: '' })).toContain('Rodou um comando')
    expect(
      await linha($, surface, 'PowerShell', { command: 'python gerar_roteiro_tais.py', description: 'Gerar o roteiro' }, 'Salvo: C:\\Users\\pedro\\cases\\x\\Roteiro Testemunha.docx\ndocx gerado'),
    ).toContain('Montou o documento Roteiro Testemunha.docx')
  })

  // ---------------------------------------------------------------- Memória
  test(`${surface}: anotação na memória usa a descrição do frontmatter`, async $ => {
    const content = '---\nname: ed-gratuidade\ndescription: "Embargos de declaração contra a gratuidade deferida na sentença de 14.09.2026"\nmetadata:\n  type: project\n---\n\nTexto.'
    const t = await linha($, surface, 'Write', { file_path: `${MEM}project-ed-gratuidade-adc80-modulacao.md`, content }, {})
    expect(t).toContain('Anotou na memória do caso: Embargos de declaração contra a gratuidade deferida na sentença de 14.09.2026')
    expect(t).not.toContain('"')
  })

  test(`${surface}: orientação de feedback vale para todos os casos (mesma regra do sync)`, async $ => {
    const fm = (tipo: string) => `---\nname: x\ndescription: Limite de páginas se confere no Word\nmetadata:\n  type: ${tipo}\n---\n`
    expect(await linha($, surface, 'Write', { file_path: `${MEM}feedback-paginacao-medir-no-word.md`, content: fm('feedback') }, {})).toContain(
      'Anotou uma orientação para todos os casos: Limite de páginas se confere no Word',
    )
    // type conhecido não-feedback vence o nome
    expect(await linha($, surface, 'Write', { file_path: `${MEM}feedback_x.md`, content: fm('project') }, {})).toContain('Anotou na memória do caso: Limite de páginas')
    // sem frontmatter: fallback pelo prefixo feedback_
    expect(await linha($, surface, 'Write', { file_path: `${MEM}feedback_cartas_enxutas.md`, content: 'Cartas enxutas.' }, {})).toContain(
      'Anotou uma orientação para todos os casos: cartas enxutas',
    )
  })

  test(`${surface}: memória sem descrição, edição e índice`, async $ => {
    expect(await linha($, surface, 'Write', { file_path: `${MEM}project-ed-gratuidade-adc80-modulacao.md`, content: 'sem frontmatter' }, {})).toContain(
      'Anotou na memória do caso: ed gratuidade adc80 modulacao',
    )
    expect(
      await linha($, surface, 'Edit', { file_path: `${MEM}project-ed-gratuidade-adc80-modulacao.md`, old_string: 'a', new_string: 'b' }, {}),
    ).toContain('Atualizou a anotação da memória: ed gratuidade adc80 modulacao')
    expect(await linha($, surface, 'Write', { file_path: `${MEM}MEMORY.md`, content: '- [x](x.md)' }, {})).toContain('Atualizou o índice da memória do caso')
    expect(await linha($, surface, 'Edit', { file_path: `${MEM}MEMORY.md`, old_string: 'a', new_string: 'b' }, {})).toContain('Atualizou o índice da memória do caso')
    expect(await linha($, surface, 'Read', { file_path: `${MEM}MEMORY.md` }, {})).toContain('Leu o índice da memória do caso')
    expect(await linha($, surface, 'Read', { file_path: `${MEM}project-roteiro-leitura.md` }, {})).toContain('Leu a anotação da memória: roteiro leitura')
  })

  test(`${surface}: pool de feedback do escritório`, async $ => {
    const p = 'C:\\Users\\pedro\\cases\\.feedback\\pedro-giudice\\feedback_cartas.md'
    expect(await linha($, surface, 'Write', { file_path: p, content: '---\ndescription: Cartas em segunda pessoa\ntype: feedback\n---\n' }, {})).toContain(
      'Anotou uma orientação para todos os casos: Cartas em segunda pessoa',
    )
  })

  // ---------------------------------------------------------------- Read
  test(`${surface}: imagem, PDF com páginas, resultado grande e material de roteiro`, async $ => {
    const sp = 'C:\\Users\\pedro\\AppData\\Local\\Temp\\claude\\C--Users-pedro-cases-x\\abc\\scratchpad\\'
    expect(await linha($, surface, 'Read', { file_path: `${sp}pg3.png` }, {})).toContain('Viu a imagem pg3.png')
    expect(await linha($, surface, 'Read', { file_path: 'C:\\Users\\pedro\\cases\\x\\Inicial.pdf', pages: '1-6' }, {})).toContain('Leu o PDF Inicial.pdf, págs. 1 a 6')
    expect(await linha($, surface, 'Read', { file_path: 'C:\\Users\\pedro\\cases\\x\\Inicial.pdf', pages: '3' }, {})).toContain('Leu o PDF Inicial.pdf, pág. 3')
    const tr = 'C:\\Users\\pedro\\.claude\\projects\\C--Users-pedro-cases-x\\abc\\tool-results\\'
    const doc = await linha($, surface, 'Read', { file_path: `${tr}mcp-plugin_case-knowledge_case-knowledge-document-1791562038356.txt`, offset: 1, limit: 200 }, {})
    expect(doc).toContain('Leu o restante de um resultado grande: peça inteira')
    expect(doc).not.toContain('1791562038356')
    expect(await linha($, surface, 'Read', { file_path: `${tr}mcp-plugin_stj-vec-tools_stj-vec-tools-document-1.txt` }, {})).toContain(
      'Leu o restante de um resultado grande: inteiro teor',
    )
    const gen = await linha($, surface, 'Read', { file_path: `${tr}bkt20zpek.txt` }, {})
    expect(gen).toContain('Leu o restante de um resultado grande')
    expect(gen).not.toContain('bkt20zpek')
    expect(
      await linha($, surface, 'Read', { file_path: 'C:\\Users\\pedro\\.claude\\plugins\\cache\\opc-plugins\\legal-team\\0.9.1\\skills\\revisao-contratual-cmr\\references\\matriz.md' }, {}),
    ).toContain('Leu o material de apoio do roteiro de revisão contratual')
  })

  // ---------------------------------------------------------------- Write/Edit fora da memória
  test(`${surface}: pasta do caso circula, rascunho é temporário`, async $ => {
    expect(await linha($, surface, 'Write', { file_path: 'C:\\Users\\pedro\\cases\\x\\pesquisa-prescricao.md', content: 'x' }, {})).toContain(
      'Salvou na pasta do caso: pesquisa-prescricao.md',
    )
    expect(await linha($, surface, 'Edit', { file_path: 'C:\\Users\\pedro\\cases\\x\\gerar_ed.py', old_string: 'a', new_string: 'b' }, {})).toContain(
      'Alterou na pasta do caso: gerar_ed.py',
    )
    expect(await linha($, surface, 'Write', { file_path: 'C:\\Users\\pedro\\AppData\\Local\\Temp\\claude\\x\\abc\\scratchpad\\build_ed.py', content: 'x' }, {})).toContain(
      'Escreveu um arquivo de trabalho temporário: build_ed.py',
    )
    expect(await linha($, surface, 'Edit', { file_path: '/tmp/claude-1000/x/abc/scratchpad/build_ed.py', old_string: 'a', new_string: 'b' }, {})).toContain(
      'Alterou um arquivo de trabalho temporário: build_ed.py',
    )
    expect(await linha($, surface, 'Write', { file_path: 'C:\\Users\\pedro\\cases\\x\\CLAUDE.md', content: 'x' }, {})).toContain('Escreveu o briefing do caso')
  })

  // ---------------------------------------------------------------- Skill, ToolSearch, Agent, WebFetch
  test(`${surface}: roteiros conhecidos pelo nome do escritório`, async $ => {
    expect(await linha($, surface, 'Skill', { skill: 'legal-team:gerar-peca-cmr' }, 'ok')).toContain('Abriu o roteiro de geração de peças do CMR')
    expect(await linha($, surface, 'Skill', { skill: 'anthropic-skills:docx' }, 'ok')).toContain('Abriu as ferramentas de documento Word')
    expect(await linha($, surface, 'Skill', { skill: 'foo:bar-baz' }, 'ok')).toContain('Carregou o roteiro: bar baz')
  })

  test(`${surface}: ToolSearch fica discreto`, async $ => {
    const { ui } = await montar($, surface, 'ToolSearch', { query: 'select:WebFetch' }, 'ok')
    const frase = await ui.find({ type: 'Text', text: 'Carregou ferramentas' })
    expect(frase?.props.dimColor).toBe(true)
  })

  test(`${surface}: tarefa delegada pelo tipo do agente`, async $ => {
    expect(await linha($, surface, 'Agent', { subagent_type: 'legal-team:tradutor', description: 'Traduzir carta CMR para inglês' }, 'ok')).toContain(
      'Pediu uma tradução: Traduzir carta CMR para inglês',
    )
    expect(await linha($, surface, 'Agent', { subagent_type: 'legal-team:legal-researcher', description: 'CDC em SaaS B2B' }, 'ok')).toContain(
      'Pediu uma pesquisa jurídica: CDC em SaaS B2B',
    )
    expect(await linha($, surface, 'Agent', { subagent_type: 'legal-team:legal-case-analyst', description: 'Varredura nos autos' }, 'ok')).toContain(
      'Pediu uma análise dos autos: Varredura nos autos',
    )
    expect(await linha($, surface, 'Agent', { subagent_type: 'web-fetch', description: 'Ler ADC 80 STF' }, 'ok')).toContain(
      'Pediu a leitura de páginas da internet: Ler ADC 80 STF',
    )
    expect(await linha($, surface, 'Agent', { subagent_type: 'general-purpose', description: 'Conferir X' }, 'ok')).toContain('Delegou uma tarefa: Conferir X')
  })

  test(`${surface}: sites oficiais pelo nome`, async $ => {
    expect(await linha($, surface, 'WebFetch', { url: 'https://www.planalto.gov.br/ccivil_03/decreto/d3048.htm', prompt: 'x' }, 'ok')).toContain(
      'Consultou o site do Planalto (legislação federal)',
    )
    expect(await linha($, surface, 'WebFetch', { url: 'https://portal.stf.jus.br/x', prompt: 'x' }, 'ok')).toContain('Consultou o site do STF')
    expect(await linha($, surface, 'WebFetch', { url: 'https://esaj.tjsp.jus.br/cpopg/x', prompt: 'x' }, 'ok')).toContain('Consultou o e-SAJ do TJSP')
    expect(await linha($, surface, 'WebFetch', { url: 'https://legisweb.com.br/x', prompt: 'x' }, 'ok')).toContain('Consultou a página: legisweb.com.br')
  })

  // ---------------------------------------------------------------- SendUserFile, Artifact e cauda
  test(`${surface}: arquivo entregue vira "Elaborou", com a legenda em Detalhes`, async $ => {
    const docx = 'C:\\Users\\pedro\\cases\\x\\Embargos de Declaracao - Justica Gratuita.docx'
    const { ui, id } = await montar($, surface, 'SendUserFile', { files: [docx], caption: 'Versão revista — 1.820 palavras', status: 'normal' }, 'ok')
    const t = await textos(ui)
    expect(t).toContain('Elaborou o documento Embargos de Declaracao - Justica Gratuita.docx')
    expect(t).not.toContain('1.820 palavras')
    await ui.press({ key: `det-${id}` })
    expect(await textos(ui)).toContain('Versão revista — 1.820 palavras')
    expect(await linha($, surface, 'SendUserFile', { files: ['C:\\x\\triagem.xlsx'] }, 'ok')).toContain('Elaborou a planilha triagem.xlsx')
    expect(await linha($, surface, 'SendUserFile', { files: [docx, 'C:\\x\\embargos.md'] }, 'ok')).toContain(
      'Elaborou 2 arquivos: Embargos de Declaracao - Justica Gratuita.docx e embargos.md',
    )
  })

  test(`${surface}: página publicada, capítulo, sessões anteriores e tarefa interrompida`, async $ => {
    expect(await linha($, surface, 'Artifact', { file_path: 'C:\\x\\estimativa.html', description: 'Estimativa preliminar de liquidação' }, 'ok')).toContain(
      'Publicou a página: Estimativa preliminar de liquidação',
    )
    expect(await linha($, surface, 'mcp__ccd_session__mark_chapter', { title: 'Redação dos embargos', summary: 'x' }, 'ok')).toContain(
      'Marcou um novo capítulo: Redação dos embargos',
    )
    expect(await linha($, surface, 'mcp__ccd_session_mgmt__list_events', {}, 'ok')).toContain('Consultou sessões anteriores')
    expect(await linha($, surface, 'TaskStop', { task_id: 'buf61n60r' }, 'ok')).toContain('Interrompeu uma tarefa em segundo plano')
  })

  // ---------------------------------------------------------------- Navegador
  test(`${surface}: navegador usa o resumo que o modelo escreveu na ação`, async $ => {
    const t = await linha(
      $,
      surface,
      'mcp__claude-in-chrome__computer',
      { action: 'left_click', tabId: 1, coordinate: [621, 31], action_summary: 'Clica no botão que baixa o zip dos nativos B' },
      'ok',
    )
    expect(t).toContain('No navegador: clica no botão que baixa o zip dos nativos B')
    expect(await linha($, surface, 'mcp__claude-in-chrome__computer', { action: 'left_click', coordinate: [1, 1], action_summary: 'PJe-Calc: abre a aba de verbas' }, 'ok')).toContain(
      'No navegador: PJe-Calc: abre a aba de verbas',
    )
    expect(await linha($, surface, 'mcp__claude-in-chrome__computer', { action: 'screenshot', tabId: 1 }, 'ok')).toContain('No navegador: olhou a tela')
    expect(await linha($, surface, 'mcp__Claude_Browser__computer', { action: 'left_click', coordinate: [113, 284] }, 'ok')).toContain('No navegador: clicou na página')
    expect(await linha($, surface, 'mcp__Claude_Browser__computer', { action: 'wait', duration: 2 }, 'ok')).toContain('No navegador: esperou a página')
  })

  test(`${surface}: lote de ações no navegador`, async $ => {
    const actions = [
      { name: 'computer', input: { action: 'left_click', coordinate: [208, 138], action_summary: 'Abre o seletor de nova condição de busca' } },
      { name: 'computer', input: { action: 'wait', duration: 2 } },
      { name: 'computer', input: { action: 'screenshot' } },
    ]
    const { ui, id } = await montar($, surface, 'mcp__claude-in-chrome__browser_batch', { actions }, 'ok')
    expect(await textos(ui)).toContain('No navegador: 3 ações · abre o seletor de nova condição de busca')
    await ui.press({ key: `det-${id}` })
    const det = await textos(ui)
    expect(det).toContain('esperou a página')
    expect(det).toContain('olhou a tela')
    const um = await linha($, surface, 'mcp__Claude_Browser__browser_batch', { actions: [{ name: 'form_input', input: { ref: 'ref_277', value: '2244640-75.2020.8.26.0000' } }] }, 'ok')
    expect(um).toContain('No navegador: preencheu um campo')
  })

  test(`${surface}: abrir endereço, procurar, ler e script`, async $ => {
    expect(await linha($, surface, 'mcp__claude-in-chrome__navigate', { url: 'https://www.crecisp.gov.br/cidadao/buscarporimobiliaria' }, 'ok')).toContain(
      'No navegador: abriu crecisp.gov.br',
    )
    expect(await linha($, surface, 'mcp__Claude_Browser__navigate', { url: 'file:///C:/Users/pedro/cases/x/roteiro-leitura-autos.pdf' }, 'ok')).toContain(
      'No navegador: abriu o arquivo roteiro-leitura-autos.pdf',
    )
    expect(await linha($, surface, 'mcp__Claude_Browser__find', { query: 'Número do recurso' }, 'ok')).toContain('No navegador: procurou «Número do recurso» na página')
    expect(await linha($, surface, 'mcp__claude-in-chrome__get_page_text', { tabId: 1 }, 'ok')).toContain('No navegador: leu o texto da página')
    expect(await linha($, surface, 'mcp__claude-in-chrome__javascript_tool', { action: 'javascript_exec', tabId: 1, text: 'document.title' }, 'ok')).toContain(
      'No navegador: rodou um script na página',
    )
    expect(await linha($, surface, 'mcp__claude-in-chrome__file_upload', { paths: ['C:\\x\\Procuração.pdf'], ref: 'r1' }, 'ok')).toContain(
      'No navegador: anexou o arquivo Procuração.pdf',
    )
  })
}

test('prompt.compose pede a descrição em português também no PowerShell', async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))
  const r = await $.prompt.compose({ model: 'claude-fable-5-1', promptModel: 'claude-fable-5-1', surfaces: ['desktop'], tools: ['Bash'], outputStyle: null, traits: [] })
  const secao = r.sections.find(s => s.id === 'aidv-passos:descricoes')
  expect(secao?.text).toContain('Bash, PowerShell e Agent')
})
