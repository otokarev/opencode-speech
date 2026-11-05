// opencode-speech — TUI voice INPUT (speech-to-text) plugin for OpenCode v2.
//
// Ctrl+R records voice via parecord (native PulseAudio recorder with a tiny
// --latency-msec buffer, so a manual stop loses only ~0.1s of the tail), then
// whisper-cli transcribes locally (Russian) and the raw text is sent straight to
// the session. There is no LLM normalization pass and no review dialog — V2 has
// no composer-append API, so the transcript goes in directly for speed.
//
// This is STT only. There is no TTS / speak-out-loud here.
//
// Paths resolve from env vars when set, otherwise from sensible defaults under
// the user's home, so the plugin is portable across machines:
//   OPENCODE_STT_WHISPER_CLI  -> full path to the whisper-cli binary
//   OPENCODE_STT_MODELS_DIR   -> directory holding ggml-*.bin whisper models
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

import { Plugin } from "@opencode/plugin/tui"

// ---------------------------------------------------------------------------
// Location resolution
// ---------------------------------------------------------------------------

const WAV_FILE = path.join(os.tmpdir(), "opencode-speech.wav")

function whisperCliPath(): string {
  if (process.env.OPENCODE_STT_WHISPER_CLI) return process.env.OPENCODE_STT_WHISPER_CLI
  return path.join(os.homedir(), ".local", "bin", "whisper-cli")
}

function modelsDir(): string {
  if (process.env.OPENCODE_STT_MODELS_DIR) return process.env.OPENCODE_STT_MODELS_DIR
  return path.join(os.homedir(), ".local", "share", "whisper-cpp")
}

// Preferred model order: small is the speed/accuracy sweet spot for Russian.
// base (~3.4s) is only ~1s faster but corrupts Russian into gibberish, so
// base/tiny are off the table. medium and large remain as fallbacks.
const MODEL_PREFERENCE = [
  "ggml-small.bin",
  "ggml-medium-q5_0.bin",
  "ggml-large-v3-turbo-q5_0.bin",
]

function findModelFile(): string | null {
  const dir = modelsDir()
  if (!fs.existsSync(dir)) return null
  const names = fs.readdirSync(dir).filter((n) => n.endsWith(".bin"))
  for (const p of MODEL_PREFERENCE) if (names.includes(p)) return path.join(dir, p)
  return names.length ? path.join(dir, names[0]) : null
}

// ---------------------------------------------------------------------------
// Recording (parecord) and transcription (whisper-cli)
// ---------------------------------------------------------------------------

let recProc: any = null
let recording = false
let autoStopCb: (() => void) | null = null

function startRecording(onStop: () => void): void {
  if (recProc || recording) return
  try { fs.unlinkSync(WAV_FILE) } catch {}
  recording = true
  autoStopCb = onStop
  // parecord with a small --latency-msec keeps the PulseAudio buffer tiny, so
  // stopping loses only ~0.1s of tail (unlike sox, which dropped ~1.27s).
  // No `silence` auto-stop: recording runs until an explicit stop.
  recProc = spawn(
    "parecord",
    ["--record", "--rate=16000", "--channels=1", "--format=s16ne", "--latency-msec=100", WAV_FILE],
    { stdio: ["ignore", "ignore", "pipe"] },
  )
  recProc.on("error", () => { recProc = null; recording = false })
  recProc.on("exit", () => {
    const cb = autoStopCb
    recProc = null
    recording = false
    autoStopCb = null
    if (cb) cb()
  })
}

async function stopRecording(): Promise<void> {
  if (recProc) {
    const proc = recProc
    let finished = false
    const exited = new Promise<void>((resolve) => {
      const done = () => { finished = true; resolve() }
      if (proc.exitCode !== null || proc.signalCode !== null) return done()
      proc.once("exit", done)
      proc.once("close", done)
    })
    proc.kill("SIGTERM")
    // Wait for parecord to finish and flush its buffer, otherwise the wav is
    // handed to whisper before the last syllables land.
    await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 2500))])
    if (!finished) { try { proc.kill("SIGKILL") } catch {} }
    recProc = null
  }
  recording = false
}

function transcribe(): Promise<string | null> {
  if (!fs.existsSync(WAV_FILE)) return Promise.resolve(null)
  if (fs.statSync(WAV_FILE).size <= 44) return Promise.resolve(null)
  const model = findModelFile()
  if (!model) return Promise.resolve(null)
  return new Promise((resolve) => {
    let stdout = ""
    const proc = spawn(
      whisperCliPath(),
      ["-m", model, "-f", WAV_FILE, "-l", "ru", "-np", "-nt", "-t", "8"],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    proc.stdout.on("data", (c) => { stdout += c.toString() })
    const timer = setTimeout(() => { proc.kill("SIGKILL"); resolve(null) }, 60000)
    proc.on("error", () => { clearTimeout(timer); resolve(null) })
    proc.on("exit", () => {
      clearTimeout(timer)
      resolve(
        stdout
          .replace(/\[.*?\]/g, "")
          .replace(/\(.*?\)/g, "")
          .replace(/\s+/g, " ")
          .trim() || null,
      )
    })
  })
}

export default Plugin.define({
  id: "opencode-speech",
  setup(context: any) {
    const toast = (message: string, variant?: string) =>
      context.ui.toast.show({ message, variant: variant ?? "info", duration: 3000 })

    let transcribing = false

    async function transcribeAndSend(): Promise<void> {
      if (transcribing) return
      transcribing = true
      try {
        toast("Transcribing...")
        const raw = await transcribe()
        if (!raw) { toast("No speech detected", "warning"); return }

        const route = context.ui.router.current()
        const sessionID = route?.params?.sessionID ?? route?.sessionID
        if (!sessionID) {
          toast("Open a session before voice input", "warning")
          return
        }

        // No composer-append in V2: send the transcript straight to the session.
        await context.client.session.prompt({ sessionID, text: raw })
        toast("Voice prompt sent", "success")
      } finally {
        transcribing = false
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
            if (recording) {
              void (async () => { await stopRecording(); void transcribeAndSend() })()
            } else {
              startRecording(() => { void transcribeAndSend() })
              toast("Recording... press Ctrl+R again to stop")
            }
          },
        },
      ],
    }))
  },
})
