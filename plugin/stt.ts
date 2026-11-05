// STT (speech-to-text) for the opencode-speech plugin: record via parecord,
// transcribe locally with whisper-cli, return the text.
//
// Mirrors tts.ts: a factory `makeRecorder` returns a `Recorder` object with a
// lifecycle (start / stop / dispose). All state lives in the closure, so multiple
// plugin instances are independent.
//
// Configuration: options.stt (from cli.json) overrides the env-var-derived
// defaults, mirroring how tts.ts reads options.tts:
//
//   "options": {
//     "stt": {
//       "language": "ru",    // whisper language code
//       "model": "ggml-small.bin",  // explicit model file (else MODEL_PREFERENCE)
//       "timeoutMs": 60000   // whisper-cli kill timeout
//     }
//   }
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

// ---------------------------------------------------------------------------
// Paths and defaults (env-overridable for portability)
// ---------------------------------------------------------------------------

function whisperCliPath(): string {
  return process.env.OPENCODE_STT_WHISPER_CLI
    ?? path.join(os.homedir(), ".local", "bin", "whisper-cli")
}

function modelsDir(): string {
  return process.env.OPENCODE_STT_MODELS_DIR
    ?? path.join(os.homedir(), ".local", "share", "whisper-cpp")
}

// Preferred model order: small is the speed/accuracy sweet spot for Russian.
// base corrupts Russian into gibberish, so it's off the table.
const MODEL_PREFERENCE = [
  "ggml-small.bin",
  "ggml-medium-q5_0.bin",
  "ggml-large-v3-turbo-q5_0.bin",
]

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SttOptions {
  language?: string
  model?: string
  timeoutMs?: number
}

type ResolvedStt = {
  language: string
  model: string | null // null → MODEL_PREFERENCE
  timeoutMs: number
}

const DEFAULTS: ResolvedStt = {
  language: "ru",
  model: null,
  timeoutMs: 60_000,
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

export interface Recorder {
  start(): boolean
  stop(): Promise<string | null>
  isRecording(): boolean
  dispose(): void
}

export function makeRecorder(pluginOptions?: { stt?: SttOptions }): Recorder {
  const opts: ResolvedStt = { ...DEFAULTS, ...(pluginOptions?.stt ?? {}) }

  const wav = path.join(os.tmpdir(), `opencode-speech-${process.pid}.wav`)

  let recProc: ChildProcess | null = null
  let stopPromise: Promise<string | null> | null = null

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  function findModelFile(): string | null {
    const dir = modelsDir()
    if (!fs.existsSync(dir)) return null
    if (opts.model) {
      const explicit = path.join(dir, opts.model)
      return fs.existsSync(explicit) ? explicit : null
    }
    const names = fs.readdirSync(dir).filter((n) => n.endsWith(".bin"))
    for (const p of MODEL_PREFERENCE) if (names.includes(p)) return path.join(dir, p)
    return names.length ? path.join(dir, names[0]) : null
  }

  function transcribe(): Promise<string | null> {
    if (!fs.existsSync(wav)) return Promise.resolve(null)
    if (fs.statSync(wav).size <= 44) return Promise.resolve(null)
    const model = findModelFile()
    if (!model) return Promise.resolve(null)

    return new Promise((resolve) => {
      let stdout = ""
      const proc = spawn(
        whisperCliPath(),
        ["-m", model, "-f", wav, "-l", opts.language, "-np", "-nt", "-t", "8"],
        { stdio: ["ignore", "pipe", "ignore"] },
      )
      proc.stdout?.on("data", (c) => { stdout += c.toString() })
      const timer = setTimeout(() => { proc.kill("SIGKILL"); resolve(null) }, opts.timeoutMs)
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

  function start(): boolean {
    if (recProc) return false
    try { fs.unlinkSync(wav) } catch {}
    recProc = spawn(
      "parecord",
      ["--record", "--rate=16000", "--channels=1", "--format=s16ne", "--latency-msec=100", wav],
      { stdio: ["ignore", "ignore", "ignore"] },
    )
    recProc.on("error", () => { recProc = null })
    recProc.on("exit", () => { recProc = null })
    return true
  }

  async function doStop(): Promise<string | null> {
    const proc = recProc
    if (!proc) return null

    const exited = new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
      proc.once("exit", () => resolve())
      proc.once("close", () => resolve())
    })

    proc.kill("SIGTERM")
    await Promise.race([exited, sleep(2500)])
    if (proc.exitCode === null && proc.signalCode === null) {
      try { proc.kill("SIGKILL") } catch {}
      await exited
    }

    try {
      return await transcribe()
    } finally {
      try { fs.unlinkSync(wav) } catch {}
    }
  }

  function stop(): Promise<string | null> {
    if (!stopPromise) stopPromise = doStop().finally(() => { stopPromise = null })
    return stopPromise
  }

  function isRecording(): boolean {
    return recProc !== null
  }

  function dispose(): void {
    if (recProc) {
      try { recProc.kill("SIGTERM") } catch {}
      recProc = null
    }
  }

  return { start, stop, isRecording, dispose }
}
