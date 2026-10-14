import { expect, mock, test } from 'claude-code/testing'
import { PANE, PLUGIN, SURFACES, motor, paneProps, textos } from './comum'
import type { $T, Surface } from './comum'

// O que o Claude gravou na pasta do caso nesta sessão (circula pelo pool de
// workdocs); rascunho da sessão e escrita com erro ficam de fora.

async function painel($: $T, surface: Surface) {
  return $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps() })
}

for (const surface of SURFACES) {
  test(`${surface}: Write na pasta do caso entra; rascunho não; o mesmo caminho duas vezes vira um item`, async ($, on) => {
    motor(on)
    mock.clock(on)
    on('tool.call', { tool: 'Write' }, () => ({ result: 'ok', text: 'ok' }))
    on('tool.call', { tool: 'Edit' }, () => ({ result: 'ok', text: 'ok' }))
    await $.tool.call({ tool: 'Write', tool_use_id: 'a1', file_path: '/home/pedro/cases/acme/minuta-contestacao.md', content: '# x' })
    await $.tool.call({ tool: 'Write', tool_use_id: 'a2', file_path: '/tmp/claude-1000/x/scratchpad/rascunho.md', content: 'x' })
    await $.tool.call({ tool: 'Edit', tool_use_id: 'a3', file_path: '/home/pedro/cases/acme/minuta-contestacao.md', old_string: 'a', new_string: 'b' })
    const t = await textos(await painel($, surface))
    expect(t).toContain('minuta-contestacao.md')
    expect(t).toContain('alterado 2x')
    expect(t).not.toContain('rascunho.md')
  })

  test(`${surface}: escrita com erro não entra; .memoria vira anotação; CLAUDE.md vira briefing`, async ($, on) => {
    motor(on)
    mock.clock(on)
    on('tool.call', { tool: 'Write' }, (_$, e) =>
      String((e as Record<string, unknown>).file_path).endsWith('falha.md')
        ? { result: 'EACCES', text: 'EACCES', isError: true }
        : { result: 'ok', text: 'ok' })
    await $.tool.call({ tool: 'Write', tool_use_id: 'a4', file_path: '/home/pedro/cases/acme/falha.md', content: 'x' })
    await $.tool.call({ tool: 'Write', tool_use_id: 'a5', file_path: '/home/pedro/cases/acme/.memoria/pedro/project_prazo.md', content: '---\ndescription: prazo da réplica\n---\nx' })
    await $.tool.call({ tool: 'Write', tool_use_id: 'a6', file_path: '/home/pedro/cases/acme/CLAUDE.md', content: '# briefing' })
    const t = await textos(await painel($, surface))
    expect(t).not.toContain('falha.md')
    expect(t).toContain('anotação na memória · project_prazo.md')
    expect(t).toContain('briefing do caso · CLAUDE.md')
  })

  test(`${surface}: Bash com "Salvo: x.docx" entra como documento montado; "Abrir" usa o opener do caminho`, async ($, on) => {
    const execs: string[][] = []
    motor(on)
    mock.clock(on)
    const saida = 'Salvo: C:\\Users\\pedro\\cases\\acme\\Contestacao.docx'
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: saida, stderr: '' }, text: saida }))
    on('process.run', (_$, e) => { execs.push([...e.argv]); return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'a7', command: 'python gerar_peca_cmr.py', description: 'Gerar a contestação em .docx' })
    const ui = await painel($, surface)
    expect(await textos(ui)).toContain('documento montado · Contestacao.docx')
    await ui.press({ key: 'abrir-0' })
    // explorer.exe, não cmd /c start: o cmd interpreta & ^ % no nome do arquivo.
    expect(execs).toEqual([['explorer.exe', 'C:\\Users\\pedro\\cases\\acme\\Contestacao.docx']])
  })

  test(`${surface}: "Abrir" que falha copia o caminho e avisa`, async ($, on) => {
    const copiados: string[] = []
    const toasts: string[] = []
    motor(on, { toasts })
    mock.clock(on)
    on('tool.call', { tool: 'Write' }, () => ({ result: 'ok', text: 'ok' }))
    on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'no opener', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('ui.copy', (_$, e) => { copiados.push(e.text); return { value: { isCopied: true } } })
    await $.tool.call({ tool: 'Write', tool_use_id: 'a8', file_path: '/home/pedro/cases/acme/nota.md', content: 'x' })
    const ui = await painel($, surface)
    await ui.press({ key: 'abrir-0' })
    expect(copiados).toEqual(['/home/pedro/cases/acme/nota.md'])
    expect(toasts.some(t => t.includes('caminho copiado'))).toBe(true)
  })

  test(`${surface}: "Abrir" falha e a cópia também falha: o toast traz o caminho`, async ($, on) => {
    const toasts: string[] = []
    motor(on, { toasts })
    mock.clock(on)
    on('tool.call', { tool: 'Write' }, () => ({ result: 'ok', text: 'ok' }))
    on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('ui.copy', () => ({ value: { isCopied: false, reason: 'no-clipboard' } }))
    await $.tool.call({ tool: 'Write', tool_use_id: 'a9', file_path: '/home/pedro/cases/acme/nota.md', content: 'x' })
    const ui = await painel($, surface)
    await ui.press({ key: 'abrir-0' })
    expect(toasts.some(t => t.includes('/home/pedro/cases/acme/nota.md'))).toBe(true)
    expect(toasts.some(t => t.includes('caminho copiado'))).toBe(false)
  })

  test(`${surface}: "Salvo:" relativo e o guard (só o nome) resolvem pela pasta da sessão`, async ($, on) => {
    const execs: string[][] = []
    motor(on, { cwd: '/home/pedro/cases/acme' })
    mock.clock(on)
    let vez = 0
    on('tool.call', { tool: 'Bash' }, () => {
      const saida = vez++ === 0 ? 'Salvo: Contestacao.docx' : "[GUARD] A versao nova foi gravada ao lado como: 'Contestacao (2).docx'."
      return { result: { stdout: saida, stderr: '' }, text: saida }
    })
    on('process.run', (_$, e) => { execs.push([...e.argv]); return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'a10', command: 'python gerar_peca_cmr.py', description: 'Gerar a contestação' })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'a11', command: 'python gerar_peca_cmr.py', description: 'Gerar a contestação' })
    const ui = await painel($, surface)
    const t = await textos(ui)
    expect(t).toContain('documento montado · Contestacao.docx')
    expect(t).toContain('documento montado · Contestacao (2).docx')
    await ui.press({ key: 'abrir-0' })
    expect(execs).toEqual([['xdg-open', '/home/pedro/cases/acme/Contestacao (2).docx']])
  })

  test(`${surface}: cada item traz verbo e hora; os objetos fixos têm nome próprio`, async ($, on) => {
    motor(on)
    mock.clock(on)
    on('tool.call', { tool: 'Write' }, () => ({ result: 'ok', text: 'ok' }))
    await $.tool.call({ tool: 'Write', tool_use_id: 'a12', file_path: '/home/pedro/cases/acme/minuta.md', content: 'x' })
    await $.tool.call({ tool: 'Write', tool_use_id: 'a13', file_path: '/home/pedro/cases/acme/case.yaml', content: 'x' })
    await $.tool.call({ tool: 'Write', tool_use_id: 'a14', file_path: '/home/pedro/cases/acme/MAPA_PROCESSUAL.md', content: 'x' })
    const t = await textos(await painel($, surface))
    expect(t).toMatch(/arquivo · minuta\.md · salvo · \d{2}:\d{2}/)
    expect(t).toContain('ficha do caso · case.yaml')
    expect(t).toContain('mapa processual · MAPA_PROCESSUAL.md')
  })

  test(`${surface}: vazio diz que nada foi gravado`, async ($, on) => {
    motor(on)
    mock.clock(on)
    expect(await textos(await painel($, surface))).toContain('Nada gravado na pasta do caso ainda.')
  })
}
