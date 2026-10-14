import { expect, mock, test } from 'claude-code/testing'
import { PANE, PLUGIN, SURFACES, aberturas, fichaJudicial, motor, origem, paneProps, textos } from './comum'
import type { $T, On, Surface } from './comum'

test('fora de pasta de caso: /caso responde e nada é sondado', async ($, on) => {
  const chamadas: string[] = []
  motor(on, { cwd: '/home/opc/case-docs' })
  on('mcp.call', (_$, e) => { chamadas.push(e.tool); return { value: { content: [], isError: false } } })
  await $.session.start({ cwd: '/home/opc/case-docs', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'caso', args: '', ...origem })
  expect(r.text).toBe('Esta sessão não está numa pasta de caso.')
  expect(chamadas).toEqual([])
})

test('em pasta de caso: session.start lê a ficha e /caso abre o painel', async ($, on) => {
  motor(on, { cwd: '/home/pedro/cases/acme-fornecedor' })
  on('mcp.call', { tool: 'metadata' }, () => ({ value: { content: [{ type: 'text', text: fichaJudicial }], isError: false } }))
  on('mcp.call', { tool: 'info' }, () => ({ value: { content: [{ type: 'text', text: 'ok' }], isError: false } }))
  on('mcp.call', { tool: 'filters' }, () => ({ value: { content: [{ type: 'text', text: '{}' }], isError: false } }))
  on('mcp.call', { tool: 'sources' }, () => ({ value: { content: [{ type: 'text', text: '{}' }], isError: false } }))
  mock.clock(on)
  aberturas.length = 0
  await $.session.start({ cwd: '/home/pedro/cases/acme-fornecedor', surface: 'terminal', isInteractive: true })
  expect(aberturas).toEqual([false]) // abre sozinho, sem pedir o teclado
  const r = await $.command.run({ command: 'caso', args: '', ...origem })
  expect(r.text).toBe('Painel do caso aberto.')
  expect(aberturas).toEqual([false, true]) // /caso abre com foco
})

// --- Cartão Caso ---

const fichaConsultiva = JSON.stringify({
  caso: 'acme-revisao', natureza: 'nao_judicial', tipo: 'material', cliente: 'Acme', polo: 'autor',
  subfamilia: 'revisao-contrato', output_style: null, autos_ate: null, briefing: null,
  valores_envolvidos: [], fontes: { briefing: false, case_yaml: true },
})
const fichaIndeterminada = JSON.stringify({
  caso: 'novo-caso', natureza: 'indeterminada', tipo: null, cliente: null, polo: null, subfamilia: null,
  output_style: null, autos_ate: null, briefing: null, valores_envolvidos: [], fontes: { briefing: false, case_yaml: false },
})
const fichaJudicialSemBase = fichaJudicial.replace('"autos_ate":"2026-10-12T14:03:00Z"', '"autos_ate":null')
const fichaComAviso =
  '[aviso: ficha do caso maior que o limite de output — listas entregues em parte (os primeiros itens, inteiros); ' +
  'o resto de cada uma se lê com a chamada indicada: briefing.dispositivos 3 de 50, metadata(lista: "briefing.dispositivos", a_partir: 4).]\n\n' +
  fichaJudicial


// Sessão numa pasta de caso cuja `metadata` responde `ficha` (ou um erro);
// as sondagens das outras bases respondem vazio.
async function painelDoCaso($: $T, on: On, surface: Surface, ficha: string | { erro: string }) {
  motor(on, { cwd: '/home/pedro/cases/x' })
  mock.clock(on)
  const resposta = () =>
    typeof ficha === 'string'
      ? { value: { content: [{ type: 'text', text: ficha }], isError: false } }
      : { value: { content: [{ type: 'text', text: ficha.erro }], isError: true } }
  on('mcp.call', { tool: 'metadata' }, resposta)
  on('mcp.call', { tool: 'list_cases' }, resposta)
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: '{}' }], isError: false } }))
  await $.session.start({ cwd: '/home/pedro/cases/x', surface: 'terminal', isInteractive: true })
  return $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps() })
}

for (const surface of SURFACES) {
  test(`${surface}: caso judicial mostra cliente, polo, tipo de ação e autos até`, async ($, on) => {
    const ui = await painelDoCaso($, on, surface, fichaJudicial)
    const t = await textos(ui)
    expect(t).toContain('acme-fornecedor')
    expect(t).toContain('Acme · réu')
    expect(t).toContain('Processo · Ação de cobrança')
    expect(t).toContain('Autos até 12/10/2026')
    expect(await ui.find({ key: 'atualizar' })).toBeDefined()
  })

  test(`${surface}: caso consultivo não mostra polo nem autos até; mostra a subfamília`, async ($, on) => {
    const t = await textos(await painelDoCaso($, on, surface, fichaConsultiva))
    expect(t).toContain('Consultivo · Revisão de contrato ou minuta recebida')
    expect(t).not.toContain('autor')
    expect(t).not.toContain('Autos até')
    expect(t).not.toContain('Sem autos')
  })

  test(`${surface}: natureza indeterminada e cliente ausente`, async ($, on) => {
    const t = await textos(await painelDoCaso($, on, surface, fichaIndeterminada))
    expect(t).toContain('cliente não informado')
    expect(t).toContain('Natureza não definida')
  })

  test(`${surface}: judicial sem base diz "Sem autos na base"; "Atualizar" relê a ficha, mesmo com aviso no topo`, async ($, on) => {
    mock.clock(on)
    let vez = 0
    motor(on, { cwd: '/home/pedro/cases/x' })
    on('mcp.call', { tool: 'metadata' }, () => ({ value: { content: [{ type: 'text', text: vez++ === 0 ? fichaJudicialSemBase : fichaComAviso }], isError: false } }))
    on('mcp.call', () => ({ value: { content: [{ type: 'text', text: '{}' }], isError: false } }))
    await $.session.start({ cwd: '/home/pedro/cases/x', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps() })
    expect(await textos(ui)).toContain('Sem autos na base')
    await ui.press({ key: 'atualizar' })
    expect(await textos(ui)).toContain('Autos até 12/10/2026')
  })

  test(`${surface}: erro da tool metadata aparece no cartão, sem derrubar o painel`, async ($, on) => {
    const ui = await painelDoCaso($, on, surface, { erro: 'Erro ao obter metadata: Sem conexão com app.aidvlabs.com para renovar o acesso. Tente de novo em instantes.' })
    const t = await textos(ui)
    expect(t).toContain('Não li a ficha do caso: Sem conexão com app.aidvlabs.com')
    expect(await ui.find({ key: 'atualizar' })).toBeDefined()
    // Sem ficha, nada é inventado...
    expect(t).not.toContain('cliente não informado')
    expect(t).not.toContain('Natureza não definida')
    // ...e o cartão Bases diz o mesmo que a ficha (a sondagem não pode sobrescrever com "conectada").
    expect(t).toMatch(/Autos · \| sem conexão com o escritório/)
  })
}
