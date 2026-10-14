export type Natureza = 'judicial' | 'nao_judicial' | 'indeterminada'

/** Cartão Caso: o que a ficha (`metadata`) diz, já reduzido ao que o painel mostra. */
export type Caso = {
  nome: string
  cliente: string | null
  polo: string | null
  natureza: Natureza
  tipoAcao: string | null
  subfamilia: string | null
  autosAte: string | null
  carregando: boolean
  erro: string | null
}

export type BaseId = 'autos' | 'stj' | 'lei' | 'memoria'
export type EstadoBase = 'sem-uso' | 'conectada' | 'rede' | 'login' | 'erro'

/** Cartão Bases: uma linha por base. `quando` = epoch ms do último sinal. */
export type Base = {
  id: BaseId
  estado: EstadoBase
  detalhe: string | null
  quando: number | null
}

export type TipoArquivo = 'docx' | 'memoria' | 'briefing' | 'outro'

/** Cartão Arquivos: um item por caminho gravado na pasta do caso nesta sessão. */
export type Arquivo = {
  caminho: string
  nome: string
  tipo: TipoArquivo
  verbo: string
  vezes: number
  quando: number
}

declare module 'claude-code' {
  interface PluginState {
    'aidv-caso': {
      caso: Caso | null
      bases: Base[]
      arquivos: Arquivo[]
      instrucaoLogin: boolean
    }
  }
}
