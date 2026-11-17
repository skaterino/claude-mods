export type StimmeStatus = 'still' | 'spricht' | 'pausiert'

declare module 'claude-code' {
  interface PluginState {
    stimme: { an: boolean; tempo: number; status: StimmeStatus; letzter: string; stimme: string; geraet: string }
  }
}
