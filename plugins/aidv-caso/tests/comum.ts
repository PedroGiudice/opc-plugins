// Helpers compartilhados pelos testes do aidv-caso (não é arquivo de teste).
import type { Mounted, TestBody } from 'claude-code/testing'

export const PLUGIN = 'aidv-caso'
export const origem = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 200 } }
export const PANE = 'aidv-caso'
export const SURFACES = ['terminal', 'desktop'] as const

export const paneProps = (bodyColumns = 64) => ({
  title: 'Caso', isFocused: true, bodyColumns, placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 60 }, view: {},
})

export async function textos(ui: Pick<Mounted, 'findAll'>): Promise<string> {
  const ts = await ui.findAll({ type: 'Text' })
  return ts.map(t => t.text).join(' | ')
}

export const fichaJudicial = JSON.stringify({
  caso: 'acme-fornecedor', natureza: 'judicial', tipo: 'processo', cliente: 'Acme', polo: 'reu',
  subfamilia: null, output_style: null, autos_ate: '2026-10-12T14:03:00Z',
  briefing: { tipo_acao: 'Ação de cobrança', vara: '1ª Vara Cível' }, valores_envolvidos: [],
  fontes: { briefing: true, case_yaml: true },
})


// O que o motor responde abaixo do mod (o kit não tem fundo próprio para estes).
export type On = Parameters<TestBody>[1]
export type $T = Parameters<TestBody>[0]
export type Surface = (typeof SURFACES)[number]
export const aberturas: boolean[] = []
export function motor(on: On, opts: { toasts?: string[]; cwd?: string } = {}): void {
  const toasts = opts.toasts ?? []
  on('session.cwd', () => ({ value: opts.cwd ?? '/home/pedro/cases/acme' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'caso' } }))
  on('ui.open', (_$, e) => { aberturas.push(e.focus === true); return { value: { isPlaced: true } } })
  on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } })
}

