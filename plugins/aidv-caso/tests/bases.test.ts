import { expect, mock, test } from 'claude-code/testing'
import { PANE, PLUGIN, SURFACES, motor, paneProps, textos } from './comum'
import type { $T, Surface } from './comum'

// Estado das bases: observação dos tool.call e sondagem por "Verificar agora".
// Motivação: incidente de 08/10/2026 (queda de rede rotulada como login expirado).

const CK_SEARCH = 'mcp__plugin_case-knowledge_case-knowledge__search'
const CK_MEM = 'mcp__plugin_case-knowledge_case-knowledge__memoria_search'
const STJ_SEARCH = 'mcp__plugin_stj-vec-tools_stj-vec-tools__search'
const CK_INFO = 'mcp__plugin_case-knowledge_case-knowledge__info'
const REDE = 'Erro na busca: Sem conexão com app.aidvlabs.com para renovar o acesso. Tente de novo em instantes.'
const LOGIN = "Erro na busca: Sua sessão no escritório expirou. No AiDV, abra o menu AiDV (ou o ícone na bandeja) e escolha 'Entrar de novo na conta…'. Sem o AiDV, rode: node <plugin>/server.mjs login"

async function painel($: $T, surface: Surface) {
  return $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps() })
}

for (const surface of SURFACES) {
  test(`${surface}: busca nos autos com sucesso marca Autos conectada; memoria_search conta para Memória`, async ($, on) => {
    motor(on)
    mock.clock(on)
    on('tool.call', { tool: CK_SEARCH }, () => ({ result: '[]', text: '[]' }))
    on('tool.call', { tool: CK_MEM }, () => ({ result: 'nada', text: 'nada' }))
    await $.tool.call({ tool: CK_SEARCH, tool_use_id: 'b1', query: 'x' })
    await $.tool.call({ tool: CK_MEM, tool_use_id: 'b2', query: 'x' })
    const t = await textos(await painel($, surface))
    expect(t).toContain('Autos · ')
    expect(t).toMatch(/Autos · \| conectada/)
    expect(t).toMatch(/Memória · \| conectada/)
    expect(t).toMatch(/STJ · \| ainda não usada nesta sessão/)
  })

  test(`${surface}: queda de rede diz "sem conexão" e NUNCA pede login`, async ($, on) => {
    motor(on)
    mock.clock(on)
    on('tool.call', { tool: STJ_SEARCH }, () => ({ result: REDE, text: REDE, isError: true }))
    await $.tool.call({ tool: STJ_SEARCH, tool_use_id: 'b3', query: 'x' })
    const ui = await painel($, surface)
    const t = await textos(ui)
    expect(t).toMatch(/STJ · \| sem conexão com o escritório/)
    expect(t).not.toContain('entre de novo')
    expect(await ui.find({ key: 'como-entrar' })).toBeUndefined()
  })

  test(`${surface}: sessão expirada pede login e "Como entrar de novo" mostra a instrução e copia o comando`, async ($, on) => {
    const copiados: string[] = []
    motor(on)
    mock.clock(on)
    on('tool.call', { tool: CK_SEARCH }, () => ({ result: LOGIN, text: LOGIN, isError: true }))
    on('ui.copy', (_$, e) => { copiados.push(e.text); return { value: { isCopied: true } } })
    await $.tool.call({ tool: CK_SEARCH, tool_use_id: 'b4', query: 'x' })
    const ui = await painel($, surface)
    expect(await textos(ui)).toMatch(/Autos · \| entre de novo na conta/)
    await ui.press({ key: 'como-entrar' })
    const t = await textos(ui)
    expect(t).toContain("escolha 'Entrar de novo na conta…'")
    await ui.press({ key: 'copiar-login' })
    expect(copiados).toEqual(['node <plugin>/server.mjs login'])
  })

  test(`${surface}: erro sem texto vira "falhou: sem mensagem"`, async ($, on) => {
    motor(on)
    mock.clock(on)
    on('tool.call', { tool: STJ_SEARCH }, () => ({ result: '', text: '', isError: true }))
    await $.tool.call({ tool: STJ_SEARCH, tool_use_id: 'b5', query: 'x' })
    expect(await textos(await painel($, surface))).toMatch(/STJ · \| falhou: sem mensagem/)
  })

  test(`${surface}: "Verificar agora" sonda info/filters/sources e não toca a memória; timeout vira rede`, async ($, on) => {
    const chamadas: string[] = []
    motor(on)
    const clock = mock.clock(on)
    on('mcp.call', { tool: 'list_cases' }, (_$, e) => { chamadas.push(e.tool); return { value: { content: [{ type: 'text', text: 'ok' }], isError: false } } })
    on('mcp.call', { tool: 'filters' }, (_$, e) => { chamadas.push(e.tool); return new Promise(() => {}) })
    on('mcp.call', { tool: 'sources' }, (_$, e) => { chamadas.push(e.tool); return { value: { content: [{ type: 'text', text: '{}' }], isError: false } } })
    const ui = await painel($, surface)
    const pressao = ui.press({ key: 'verificar' })
    await clock.advance(8000)
    await pressao
    const t = await textos(ui)
    expect([...chamadas].sort()).toEqual(['filters', 'list_cases', 'sources'])
    expect(t).toMatch(/Autos · \| conectada/)
    expect(t).toMatch(/Legislação · \| conectada/)
    expect(t).toMatch(/STJ · \| sem conexão com o escritório/)
    expect(t).toMatch(/Memória · \| ainda não usada nesta sessão/)
  })

  test(`${surface}: a tool info (local, sem rede) não conta como sinal dos Autos`, async ($, on) => {
    motor(on)
    mock.clock(on)
    on('tool.call', { tool: CK_INFO }, () => ({ result: 'Caso ativo: x', text: 'Caso ativo: x' }))
    await $.tool.call({ tool: CK_INFO, tool_use_id: 'b6' })
    expect(await textos(await painel($, surface))).toMatch(/Autos · \| ainda não usada nesta sessão/)
  })

  test(`${surface}: "fetch failed" e timeout de rede também são "sem conexão", não "falhou"`, async ($, on) => {
    motor(on)
    mock.clock(on)
    const FETCH = 'Erro na busca: fetch failed'
    on('tool.call', { tool: STJ_SEARCH }, () => ({ result: FETCH, text: FETCH, isError: true }))
    await $.tool.call({ tool: STJ_SEARCH, tool_use_id: 'b7', query: 'x' })
    const t = await textos(await painel($, surface))
    expect(t).toMatch(/STJ · \| sem conexão com o escritório/)
    expect(t).not.toContain('fetch failed')
  })
}
