export type Trecho = {
  caso: string | null
  documento: string
  segmentoId: string | null
  titulo: string | null
  peca: string | null
  parte: string | null
  paginaInicio: number | null
  paginaFim: number | null
  data: string | null
  chunkIndex: number | null
  score: number | null
  trecho: string
}

export type Busca = {
  id: string
  query: string
  filtros: string[]
  lotes: { rotulo: string | null; trechos: Trecho[] }[]
  erro: string | null
  concluida: boolean
}

export type Leitura = {
  titulo: string
  meta: string
  texto: string
  erro: string | null
  carregando: boolean
  proximo: number | null
  fonte: { documento: string; segmentoId: string | null; chunkIndex: number | null; query: string }
}

declare module 'claude-code' {
  interface PluginState {
    'aidv-autos': {
      buscas: Busca[]
      aberto: Record<string, boolean>
      selecionada: string | null
      leitura: Leitura | null
    }
  }
}
