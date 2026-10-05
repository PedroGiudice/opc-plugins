export type Categoria = { rotulo: string; tokens: number; cor: string }

export type Juridico = { autos: number; jurisprudencia: number; legislacao: number }

export type Medida = {
  percent: number | null
  tokens: number | null
  window: number
  categorias: Categoria[]
  limites: { kind: string; percentUsed: number; resetsAt?: string }[]
}

declare module 'claude-code' {
  interface PluginState {
    'aidv-contexto': { medida: Medida | null; juridico: Juridico }
  }
}
