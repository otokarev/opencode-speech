// opencode-speech — TUI voice plugin for OpenCode v2: STT input + TTS output.
//
// This file is thin glue only: it wires the STT recorder and the TTS speaker to
// the opencode TUI (keybind, session events, toasts). All recording, transcription
// and synthesis logic lives in stt.ts and tts.ts.
//
// STT: Ctrl+R records via parecord, whisper-cli transcribes locally (Russian),
// the raw text is sent straight to the session. No LLM normalization, no review
// dialog — V2 has no composer-append API, so the transcript goes in directly.
// TTS: on `session.execution.succeeded` the last assistant reply is spoken aloud
// via piper (pure TypeScript, no Python) — see tts.ts.
import { Plugin } from "@opencode/plugin/tui"
import { makeSpeaker, type TtsOptions } from "./tts"
import { makeRecorder, type SttOptions } from "./stt"

// Minimal typed view of the opencode v2 TUI context (instead of `any`).
interface SessionMessage {
  type: string
  content?: { type: string; text?: string }[]
}

interface SessionEvent {
  data?: { sessionID?: string }
}

interface TuiContext {
  ui: {
    toast: { show(opts: { message: string; variant?: string; duration?: number }): void }
    router: { current(): { params?: Record<string, string>; sessionID?: string } | null }
  }
  client: { session: { prompt(opts: { sessionID: string; text: string }): Promise<unknown> } }
  keymap: { layer(fn: () => unknown): unknown }
  data: {
    on(event: "session.execution.succeeded", cb: (e: SessionEvent) => void): () => void
    session: { message: { list(sessionID: string): SessionMessage[] } }
  }
  options: { tts?: TtsOptions; stt?: SttOptions }
}

export default Plugin.define({
  id: "opencode-speech",
  setup(context: TuiContext) {
    const toast = (message: string, variant?: string) =>
      context.ui.toast.show({ message, variant: variant ?? "info", duration: 3000 })

    const recorder = makeRecorder(context.options)
    const speaker = makeSpeaker(context.options)

    // ---- glue: STT transcript -> session ----
    async function sendTranscript(text: string | null): Promise<void> {
      if (!text) {
        toast("No speech detected", "warning")
        return
      }
      const sessionID = currentSessionId(context)
      if (!sessionID) {
        toast("Open a session before voice input", "warning")
        return
      }
      try {
        await context.client.session.prompt({ sessionID, text })
        toast("Voice prompt sent", "success")
      } catch {
        toast("Failed to send voice prompt", "error")
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "opencode-speech.record",
          title: "Voice: record / send",
          bind: "ctrl+r",
          slash: { name: "stt-record" },
          run: () => {
            if (recorder.isRecording()) {
              void (async () => {
                try {
                  toast("Transcribing...")
                  const text = await recorder.stop()
                  await sendTranscript(text)
                } catch {
                  toast("Voice input failed", "error")
                }
              })()
            } else {
              if (recorder.start()) toast("Recording... press Ctrl+R again to stop")
            }
          },
        },
        {
          id: "opencode-speech.toggle-tts",
          title: "Voice: toggle spoken replies",
          bind: "ctrl+t",
          slash: { name: "tts-toggle" },
          run: () => {
            speaker.toggle()
            toast(speaker.isEnabled() ? "Voice replies on" : "Voice replies off", "info")
          },
        },
      ],
    }))

    // ---- glue: session completion -> TTS ----
    // `session.execution.succeeded` is the only reliable "done" signal in the TUI
    // context (session.idle never fires here). lastAssistantText takes just the
    // final assistant message; a last-spoken guard avoids re-reading the same
    // reply if `succeeded` fires more than once for one turn.
    let lastSpoken = ""
    const offTts = context.data.on("session.execution.succeeded", (event: SessionEvent) => {
      const sessionID = event?.data?.sessionID ?? currentSessionId(context)
      if (!sessionID) return
      const messages = context.data.session.message.list(sessionID) ?? []
      const text = lastAssistantText(messages)
      if (text && text !== lastSpoken) {
        lastSpoken = text
        speaker.speakReply(text)
      }
    })

    return () => {
      offTts()
      recorder.dispose()
      speaker.dispose()
    }
  },
})

// The current session id from the router (used when an event carries no sessionID).
function currentSessionId(context: TuiContext): string | undefined {
  const route = context.ui.router.current()
  return route?.params?.sessionID ?? route?.sessionID
}

// Return text of the LAST assistant message only (skip reasoning/tool parts).
// Walk from the end: the first assistant message before the user turn is the
// final reply — do NOT concatenate earlier intermediate assistant turns.
function lastAssistantText(messages: SessionMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === "user") break
    if (message?.type !== "assistant") continue
    const content = Array.isArray(message.content) ? message.content : []
    const text = content
      .filter((part) => part?.type === "text")
      .map((part) => (part.text ?? "").trim())
      .filter(Boolean)
      .join("\n")
    if (text) return text
  }
  return ""
}
