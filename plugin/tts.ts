// piper-based TTS (text-to-speech) for the opencode-speech plugin.
//
// Speaks the last assistant reply aloud on session completion, in pure
// TypeScript on top of the native `piper` binary — no Python in the chain.
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
//   piper --model <m> --output_raw --length_scale <1/speed> -q   ← text via stdin
//     | aplay -q -r <sample_rate> -f S16_LE -t raw -
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

// ---------------------------------------------------------------------------
// Paths (env-overridable for portability)
// ---------------------------------------------------------------------------

const PIPER_DIR = process.env.OPENCODE_TTS_PIPER_DIR
  ?? path.join(os.homedir(), ".local", "share", "piper")
const PIPER = path.join(PIPER_DIR, "piper", "piper")

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
// It returns a complete spawn command producing raw 16-bit mono audio on stdout,
// plus the sample rate to feed aplay.
interface RunSpec {
  command: string
  args: string[]
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

const PROVIDERS: Record<string, Provider> = {
  piper: {
    build(name, speed) {
      const model = path.join(PIPER_DIR, `ru_RU-${name}-medium.onnx`)
      if (!fs.existsSync(model)) return null
      const rate = sampleRateOf(model + ".json")
      return {
        command: PIPER,
        args: ["--model", model, "--output_raw", "--length_scale", (1 / speed).toFixed(3), "-q"],
        rate,
      }
    },
  },
  // rhvoice: { build(name, speed) { ... } }  ← future providers go here only
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
}

export function makeSpeaker(pluginOptions?: { tts?: TtsOptions }): Speaker {
  const settings: ResolvedTts = { ...DEFAULTS, ...(pluginOptions?.tts ?? {}) }

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
    const player = spawn("aplay", ["-q", "-r", String(run.rate), "-f", "S16_LE", "-t", "raw", "-"], {
      stdio: ["pipe", "ignore", "ignore"],
    })
    currentSource = source
    currentPlayer = player

    // Close over the local processes, not the shared fields, so a late error
    // from an already-replaced process cannot kill the new one.
    const s = source
    const p = player
    s.stdout?.pipe(p.stdin)
    s.on("error", () => { try { p.kill("SIGTERM") } catch {} })
    p.on("error", () => { try { s.kill("SIGTERM") } catch {} })
    p.on("close", () => {
      if (currentPlayer === p) currentPlayer = null
      if (currentSource === s) currentSource = null
    })

    s.stdin.write(phrase)
    s.stdin.end()
  }

  function speakReply(text: string): void {
    if (!settings.enabled) return
    const phrase = firstSentences(clean(text), settings.sentences)
    if (!phrase) return
    speak(phrase, settings.speed, settings.voice)
  }

  return { speakReply, stop, dispose }
}
