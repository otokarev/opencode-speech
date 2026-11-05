// TTS (text-to-speech) for the opencode-speech plugin.
//
// Speaks the last assistant reply aloud on session completion, in pure
// TypeScript on top of native binaries (piper / rhvoice) — no Python in the chain.
//
// Configuration comes from the plugin's own `options` in cli.json, NOT from the
// Claude Code python voice config (~/.claude/voice.json):
//
//   "plugins": [
//     {
//       "package": "/path/to/opencode-speech/plugin",
//       "options": {
//         "tts": {
//           "voice": "piper:irina",   // "<provider>:<name>" — provider selects the engine
//           "speed": 1.0,            // playback speed (>= 0.1)
//           "sentences": 2,          // how many sentences of the reply to read
//           "enabled": true          // turn TTS off without removing the config
//         }
//       }
//     }
//   ]
//
// `voice` is strictly "<provider>:<name>". A bare name with no colon does NOT
// resolve (and so does not speak). Providers live in the PROVIDERS registry —
// each knows how to turn (voice name, speed) into a full spawn command, so
// adding an engine is one entry in PROVIDERS and nothing else changes.
//
// Streamed pipeline (nothing from the reply reaches the shell as argv):
//   piper   --model <m> --output_raw --length_scale <1/speed> -q  ← text via stdin → raw → aplay
//   rhvoice -p <name> -r <speed%> -o /dev/stdout                 ← text via stdin → wav  → aplay
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

// ---------------------------------------------------------------------------
// Paths (env-overridable for portability)
// ---------------------------------------------------------------------------

function piperDir(): string {
  return process.env.OPENCODE_TTS_PIPER_DIR
    ?? path.join(os.homedir(), ".local", "share", "piper")
}

function piperPath(): string {
  return path.join(piperDir(), "piper", "piper")
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TtsOptions {
  voice?: string
  speed?: number
  sentences?: number
  enabled?: boolean
}

type ResolvedTts = {
  voice: string
  speed: number
  sentences: number
  enabled: boolean
}

const DEFAULTS: ResolvedTts = {
  voice: "piper:irina",
  speed: 1.0,
  sentences: 2,
  enabled: false, // TTS is opt-in: enabled only when configured in options.tts.enabled
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

// Each provider knows the full way to run itself for a given (voice name, speed).
// It returns a complete spawn command producing audio on stdout, plus how to feed
// aplay. `format`: "raw" (bare PCM) or "wav" (RIFF header that speak() strips).
// `rate` is the stream's sample rate in both cases.
interface RunSpec {
  command: string
  args: string[]
  format: "raw" | "wav"
  rate: number
}

type Provider = {
  build(voiceName: string, speed: number): RunSpec | null
}

function sampleRateOf(modelJsonPath: string, fallback = 22050): number {
  try {
    const conf = JSON.parse(fs.readFileSync(modelJsonPath, "utf-8"))
    const rate = conf?.audio?.sample_rate
    return typeof rate === "number" ? rate : fallback
  } catch {
    return fallback
  }
}

// RHVoice binary (optional — only used when a rhvoice: voice is requested).
// Resolved lazily so env changes after import still apply.
function rhvoiceBinary(): string {
  return process.env.OPENCODE_TTS_RHVOICE_BIN ?? "RHVoice-test"
}

const PROVIDERS: Record<string, Provider> = {
  piper: {
    build(name, speed) {
      const model = path.join(piperDir(), `ru_RU-${name}-medium.onnx`)
      if (!fs.existsSync(model)) return null
      const rate = sampleRateOf(model + ".json")
      return {
        command: piperPath(),
        args: ["--model", model, "--output_raw", "--length_scale", (1 / speed).toFixed(3), "-q"],
        format: "raw",
        rate,
      }
    },
  },
  // RHVoice: `name` is a voice profile (anna, elena, irina, …). It reads text
  // from stdin and emits a WAV on stdout ("-o -"). -R 24000 fixes the sample
  // rate; RHVoice still writes a streaming WAV whose RIFF size is garbage, so
  // speak() strips the 44-byte header and plays the payload as raw.
  rhvoice: {
    build(name, speed) {
      return {
        command: rhvoiceBinary(),
        args: ["-p", name, "-r", String(Math.round(speed * 100)), "-R", "24000", "-o", "-"],
        format: "wav",
        rate: 24000,
      }
    },
  },
}

function resolve(voice: string, speed: number): RunSpec | null {
  const idx = voice.indexOf(":")
  if (idx <= 0) return null // bare name — no provider, does not resolve
  const provider = PROVIDERS[voice.slice(0, idx)]
  return provider ? provider.build(voice.slice(idx + 1), speed) : null
}

// ---------------------------------------------------------------------------
// Markdown cleanup
// ---------------------------------------------------------------------------

function clean(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")              // fenced code blocks
    .replace(/^\s*\|.*$/gm, " ")                    // table rows
    .replace(/`[^`]*`/g, " ")                       // inline code / paths
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")        // links -> text
    .replace(/https?:\/\/\S+/g, " ")               // bare URLs
    .replace(/^\s*(#+|[-*]|\d+\.)\s+/gm, "")        // headings / list bullets
    .replace(/[*_>#]/g, "")                         // markdown emphasis
    .replace(/\s+/g, " ")
    .trim()
}

function firstSentences(text: string, n: number): string {
  return text.split(/(?<=[.!?…])\s+/).slice(0, n).join(" ")
}

// ---------------------------------------------------------------------------
// Speaker
// ---------------------------------------------------------------------------

export interface Speaker {
  speakReply(text: string): void
  stop(): void
  dispose(): void
  /** Switch TTS on/off at runtime (starts from options.tts.enabled). */
  toggle(): boolean
  /** @returns current runtime state */
  isEnabled(): boolean
}

export function makeSpeaker(pluginOptions?: { tts?: TtsOptions }): Speaker {
  const raw = pluginOptions?.tts ?? {}
  const settings: ResolvedTts = {
    voice: typeof raw.voice === "string" && raw.voice ? raw.voice : DEFAULTS.voice,
    speed: Number.isFinite(raw.speed) && (raw.speed as number) >= 0.1 ? (raw.speed as number) : DEFAULTS.speed,
    sentences: Number.isFinite(raw.sentences) && (raw.sentences as number) > 0 ? (raw.sentences as number) : DEFAULTS.sentences,
    enabled: raw.enabled === true,
  }

  // Runtime switch; seeded from the config flag, toggled via toggle()/hotkey.
  let runtimeEnabled = settings.enabled

  let currentSource: ChildProcess | null = null
  let currentPlayer: ChildProcess | null = null

  function stop(): void {
    try { currentPlayer?.kill("SIGTERM") } catch {}
    try { currentSource?.kill("SIGTERM") } catch {}
    currentPlayer = null
    currentSource = null
  }
  const dispose = stop

  function speak(phrase: string, speed: number, voice: string): void {
    const safeSpeed = Number.isFinite(speed) && speed >= 0.1 ? speed : 1.0
    const run = resolve(voice, safeSpeed)
    if (!run) return

    stop()

    const source = spawn(run.command, run.args, { stdio: ["pipe", "pipe", "ignore"] })
    const player = spawn("aplay", ["-q", "-r", String(run.rate), "-f", "S16_LE", "-c", "1", "-t", "raw", "-"], {
      stdio: ["pipe", "ignore", "ignore"],
    })
    currentSource = source
    currentPlayer = player

    // Close over the local processes, not the shared fields, so a late error
    // from an already-replaced process cannot kill the new one.
    const s = source
    const p = player
    if (run.format === "wav") {
      // RHVoice streams a WAV whose RIFF size is garbage; strip the 44-byte
      // header and hand the raw PCM payload to aplay (rate is already explicit).
      let header = Buffer.alloc(0)
      let skipped = false
      s.stdout.on("data", (d: Buffer) => {
        if (skipped) { p.stdin.write(d); return }
        header = Buffer.concat([header, d])
        if (header.length > 44) {
          skipped = true
          p.stdin.write(header.subarray(44))
          header = Buffer.alloc(0)
        }
      })
    } else {
      s.stdout.pipe(p.stdin)
    }
    s.on("error", () => { try { p.kill("SIGTERM") } catch {} })
    s.stdin.on("error", () => {}) // source gone before write: swallow EPIPE
    p.on("error", () => { try { s.kill("SIGTERM") } catch {} })
    p.on("close", () => {
      if (currentPlayer === p) currentPlayer = null
      if (currentSource === s) currentSource = null
    })

    try {
      s.stdin.write(phrase)
      s.stdin.end()
    } catch {
      try { p.kill("SIGTERM") } catch {}
    }
  }

  function speakReply(text: string): void {
    if (!runtimeEnabled) return
    const phrase = firstSentences(clean(text), settings.sentences)
    if (!phrase) return
    speak(phrase, settings.speed, settings.voice)
  }

  function toggle(): boolean {
    runtimeEnabled = !runtimeEnabled
    if (!runtimeEnabled) stop() // cut any in-progress speech when muting
    return runtimeEnabled
  }

  function isEnabled(): boolean {
    return runtimeEnabled
  }

  return { speakReply, stop, dispose, toggle, isEnabled }
}
