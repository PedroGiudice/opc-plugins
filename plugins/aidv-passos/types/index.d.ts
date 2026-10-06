/** "Detalhes" aberto por tool_use_id. */
export type Toggles = Record<string, boolean>

declare module 'claude-code' {
  interface PluginState {
    'aidv-passos': {
      aberto: Toggles
    }
  }
}
