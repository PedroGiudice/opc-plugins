/** Toggles por id: "Detalhes" de um passo (tool_use_id) ou grupo aberto (id do primeiro call). */
export type Toggles = Record<string, boolean>

declare module 'claude-code' {
  interface PluginState {
    'aidv-passos': {
      aberto: Toggles
      grupos: Toggles
    }
  }
}
