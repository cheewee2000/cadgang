/** Open markups Claude has not been told about yet, on the file CADgang is showing. */
export type Notes = { subject: string; ids: string[] }

declare module 'claude-code' {
  interface PluginState {
    'cadgang-notes': { notes: Notes | null }
  }
}
