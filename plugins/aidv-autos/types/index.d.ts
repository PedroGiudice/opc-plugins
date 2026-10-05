export type Fonte = 'autos' | 'stj' | 'lei'

export type Trecho = {
  // comuns
  trecho: string
  chunkIndex: number | null
  score: number | null
  // autos do caso
  caso: string | null
  documento: string
  segmentoId: string | null
  titulo: string | null
  peca: string | null
  parte: string | null
  paginaInicio: number | null
  paginaFim: number | null
  data: string | null
  // jurisprudência (STJ) e legislação
  docId: string | null
  processo: string | null
  classe: string | null
  ministro: string | null
  orgao: string | null
  secao: string | null
  tipoDoc: string | null
  rotuloLei: string | null
}

export type Busca = {
  id: string
  fonte: Fonte
  query: string
  filtros: string[]
  lotes: { rotulo: string | null; trechos: Trecho[] }[]
  erro: string | null
  concluida: boolean
}

export type FonteLeitura = {
  kind: Fonte
  documento: string
  segmentoId: string | null
  chunkIndex: number | null
  docId: string | null
  query: string
}

export type Leitura = {
  titulo: string
  meta: string
  texto: string
  erro: string | null
  carregando: boolean
  proximo: number | null
  fonte: FonteLeitura
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
