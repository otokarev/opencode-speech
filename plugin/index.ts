// Server part of the opencode-speech plugin. Minimal: it only exists so OpenCode
// registers the plugin and hands its TUI part to the terminal client. The actual
// work lives in the TUI entry (tui.ts is the glue; stt.ts and tts.ts hold the
// recording/synthesis logic), because `context.data`, `context.ui` and the
// keymap layer are TUI-only APIs.
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "opencode-speech",
  setup() {},
})
