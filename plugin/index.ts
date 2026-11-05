// Server part of the STT voice plugin. Minimal: it only exists so OpenCode
// registers the plugin and hands its TUI part to the terminal client. The actual
// work lives in tui.ts (keybind, recording, transcription), because `context.data`,
// `context.ui` and the keymap layer are TUI-only APIs.
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "opencode-speech",
  setup() {},
})
