// Minimal type stub for the opencode v2 TUI plugin API.
// The real package is resolved from the opencode runtime (bun), not node_modules.
// `any` here is intentional: it is a bridge so downstream plugin code keeps its
// own precise types (TuiContext, events, messages).
export const Plugin: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  define(input: { id: string; setup(ctx?: any): any | (() => void) }): any
}
