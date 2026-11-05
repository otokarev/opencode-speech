# opencode-speech

Voice input and output for [OpenCode](https://opencode.ai) v2 — a plugin that records audio from the
microphone, transcribes it **locally** with [whisper.cpp](https://github.com/ggml-org/whisper.cpp),
sends the text straight into the current session, and can read the assistant's replies aloud with
[piper](https://github.com/rhasspy/piper).

- **Speech-to-text (STT):** `Ctrl+R` records, whisper transcribes locally, the text goes straight
  into the session.
- **Text-to-speech (TTS):** the last reply is spoken aloud via piper — pure TypeScript, no Python.
- **Local and private.** Both directions run on your machine — nothing leaves for the cloud, and
  there is no LLM normalization pass.
- **Russian out of the box** (the `small` whisper model — the speed/accuracy sweet spot;
  configurable via `options.stt.language`).

## Quick reference

| What | How |
|---|---|
| Record voice / send to session | `Ctrl+R` (or `/stt-record`) — press again to stop & send |
| Mute / unmute read-aloud | `Ctrl+T` (or `/tts-toggle`) |
| Enable read-aloud by default | `options.tts.enabled: true` in `cli.json` (see [Configuration](#configuration)) |

`Ctrl+T` is used for the mute toggle (not `Ctrl+M`, which is indistinguishable from Enter in most
terminals and never reaches the plugin).

## How it works

- **STT:** `Ctrl+R` → `parecord` records 16 kHz mono → `whisper-cli` transcribes (`-l ru`, 8 threads)
  → the text goes straight into the session. Stopping is manual (press `Ctrl+R` again): silence
  auto-stop is intentionally disabled because, in a noisy room, it chops phrases on micro-pauses.
- **TTS:** on `session.idle` (when the agent has finished and is waiting for you), the last reply is
  cleaned of markdown, cut to the first `N` sentences, and piped through `piper` into `aplay`. Only the
  final reply is spoken — intermediate steps/tool calls are not read out. Enabled via `options.tts`
  (see [Configuration](#configuration)).

## Requirements

- **Linux** with PulseAudio (Ubuntu/Debian tested; WSL2 — see below).
- **OpenCode ≥ 2.2** (the plugin targets the v2 TUI API; tested on 2.2.5).
- `sudo` to install system packages (one time only).
- **For TTS:** the `piper` binary + at least one Russian voice (see [TTS setup](#tts-setup)).

## Installation

```bash
git clone https://github.com/otokarev/opencode-speech.git
cd opencode-speech
./scripts/install.sh
```

`install.sh` does everything itself and is idempotent (safe to run again):

1. installs system packages: `pulseaudio-utils` (provides `parecord`), `cmake`,
   `build-essential`, `alsa-utils` (`aplay`);
2. builds `whisper-cli` from source into `~/.local/bin/whisper-cli`
   (it is not packaged for Ubuntu's apt — building from source is the only sensible route);
3. downloads the `ggml-small.bin` model (~466 MB) into `~/.local/share/whisper-cpp/`;
4. installs the `piper` binary and the `ru_RU-irina-medium` voice (see [TTS setup](#tts-setup));
5. registers the plugin in `~/.config/opencode/cli.json` (with an `options.tts` block, TTS off by
   default) and frees the `Ctrl+R` hotkey (by default it is taken by session rename).

After installing, **restart opencode** and press `Ctrl+R` in the TUI.

### Manual installation (without install.sh)

The same result, step by step:

```bash
# 1. system packages
sudo apt-get install -y pulseaudio-utils cmake build-essential

# 2. whisper-cli from source
git clone --depth 1 https://github.com/ggml-org/whisper.cpp
cmake -B whisper.cpp/build whisper.cpp -DGGML_CUDA=OFF -DCMAKE_BUILD_TYPE=Release
cmake --build whisper.cpp/build -j --target whisper-cli
mkdir -p ~/.local/bin && cp whisper.cpp/build/bin/whisper-cli ~/.local/bin/

# 3. model
mkdir -p ~/.local/share/whisper-cpp
curl -fL -o ~/.local/share/whisper-cpp/ggml-small.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
```

Then in `~/.config/opencode/cli.json`:

```json
{
  "keybinds": { "session.rename": "none" },
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-speech/plugin",
      "options": {
        "tts": {
          "voice": "piper:irina",
          "speed": 1.0,
          "sentences": 2,
          "enabled": true
        }
      }
    }
  ]
}
```

## Usage

| Action | How |
|---|---|
| Start recording | `Ctrl+R` (or `/stt-record`) |
| Stop and send | `Ctrl+R` again — transcribes and sends to the session |
| Toggle spoken replies | `Ctrl+T` (or `/tts-toggle`) — mute/unmute the read-aloud on the fly |

The text goes into the session immediately, with no edit dialog: opencode v2 has no API to insert
text into the input line (the composer-append API was removed). If you need editing, just fix the
transcript inline in the already-open session.

`Ctrl+T` (not `Ctrl+M`) is used for the mute toggle because `Ctrl+M` is indistinguishable from
Enter (`\r`) in most terminals and never reaches the plugin.

## Path configuration

The plugin is portable: paths come from environment variables, falling back to home-directory
defaults.

| What | Variable | Default |
|---|---|---|
| `whisper-cli` binary | `OPENCODE_STT_WHISPER_CLI` | `~/.local/bin/whisper-cli` |
| models directory | `OPENCODE_STT_MODELS_DIR` | `~/.local/share/whisper-cpp` |
| piper directory (TTS) | `OPENCODE_TTS_PIPER_DIR` | `~/.local/share/piper` |

## Configuration

Everything is configured in the plugin's `options` block in `cli.json`. Two groups, both optional (all
keys have env-backed or sensible defaults):

### STT — `options.stt`

| Key | Default | Meaning |
|---|---|---|
| `language` | `"ru"` | whisper language code passed as `-l` |
| `model` | (first of the preference list) | explicit `.bin` file name in the models dir |
| `timeoutMs` | `60000` | whisper-cli kill timeout |

### TTS — `options.tts`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | starting TTS state; `Ctrl+T`/`/tts-toggle` overrides it at runtime for the session |
| `voice` | `"piper:irina"` | `<provider>:<name>`; provider selects the engine (see [TTS voice](#tts-setup)) |
| `speed` | `1.0` | playback speed (≥ 0.1); mapped to piper's `--length_scale` as `1/speed` |
| `sentences` | `2` | how many of the first sentences of the reply to read |

## TTS setup

TTS depends on two things that must be installed per-machine (they are binaries/models, not
committed to this repo): the `piper` binary and a Russian voice. Both go under `~/.local/share/piper/`
by default (override with `OPENCODE_TTS_PIPER_DIR`).

### 1. piper binary (no package manager — a release tarball)

piper ships as a prebuilt tarball from GitHub Releases, not an apt/rpm package. Download and unpack
it — the archive already contains a `piper/` directory, so extract straight into the target:

```bash
mkdir -p ~/.local/share/piper
curl -fL https://github.com/rhasspy/piper/releases/download/v1.2.0/piper_amd64.tar.gz \
  | tar xz -C ~/.local/share/piper
```

This yields `~/.local/share/piper/piper/piper` (the executable) alongside its bundled libraries
(`libonnxruntime.so`, `libespeak-ng.so`, `espeak-ng-data/`) and `piper_phonemize`. The plugin launches
`~/.local/share/piper/piper/piper` and relies on those sibling libraries — do not move the binary out of
that folder.

> The tarball retains the `piper/` directory when extracted, so extract into `~/.local/share/piper`
> (one level up), **not** into `~/.local/share/piper/piper`. For other architectures pick
> `piper_arm64.tar.gz` or `piper_armv7.tar.gz` from the same release. Note: v1.2.0's `espeak-ng` data
> lives inside the tarball; `piper_phonemize` is a bundled helper, not a system package.

### 2. Russian voice

```bash
curl -fL -o ~/.local/share/piper/ru_RU-irina-medium.onnx \
  https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/ru/ru_RU/irina/medium/ru_RU-irina-medium.onnx
curl -fL -o ~/.local/share/piper/ru_RU-irina-medium.onnx.json \
  https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/ru/ru_RU/irina/medium/ru_RU-irina-medium.onnx.json
```

Both files are required: the `.onnx` is the model, the `.onnx.json` carries the sample rate that the
plugin reads to feed `aplay`. Configure the matching voice with `"voice": "piper:irina"`.

### 3. aplay (player)

TTS plays through `aplay` from the `alsa-utils` package:

```bash
sudo apt-get install -y alsa-utils
```

The TTS pipeline is pure TypeScript — the plugin spawns the native `piper` binary and `aplay`, with no
Python anywhere in the TTS path.

## Model selection

`tui.ts` looks for models in this order: `ggml-small.bin` → `ggml-medium-q5_0.bin` →
`ggml-large-v3-turbo-q5_0.bin`. **`small` is recommended** as the right balance:

| Model | Time for a ~7–8 s phrase (16 cores) | Russian |
|---|---|---|
| `small` (~466 MB) | **~4–8 s** | optimal; errors only on lookalike letters (Ё→Е) |
| `medium-q5_0` (~539 MB) | ~15–20 s | good, but loses the tail of long phrases |
| `large-v3-turbo-q5_0` (~574 MB) | ~42 s | best, reads the full tail |
| `base` (~148 MB) | ~3.4 s | ❌ unusable for Russian (hallucinations) |

Going below `small` is not an option — `base`/`tiny` turn Russian speech into nonsense. Speed is
bounded by **threads** (`-t 8` is already set), not by the model.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Ctrl+R` does nothing / renames the session | hotkey taken by `session.rename` | `cli.json` must have `"session.rename": "none"` |
| "No speech detected" | wrong microphone source | pick a source via PulseAudio (`pactl set-default-source`) |
| transcription clips the tail | recording not via `parecord` | make sure `tui.ts` uses `parecord`, not `sox` |
| `whisper-cli: command not found` | binary not on `PATH` | add `~/.local/bin` to `PATH` or set `OPENCODE_STT_WHISPER_CLI` |
| "Model not found" | models directory is empty | download a model or set `OPENCODE_STT_MODELS_DIR` |
| plugin did not load | TUI not restarted after editing `cli.json` | quit and run `opencode` again |
| TTS is silent | `options.tts.enabled` is `false`, or the piper voice is missing | set `enabled: true` and install the voice under `~/.local/share/piper/ru_RU-<voice>-medium.onnx` |

## WSL2

WSL2 audio goes through WSLg/PulseAudio (`/mnt/wslg/PulseServer`). The microphone appears as the
`RDPSource` source. If `parecord` finds no devices: run `wsl --shutdown` from PowerShell, then check
"Settings → Privacy & Security → Microphone" (allow desktop apps) and run `wsl --update`.

## Why it's built this way

- **`parecord`, not `sox`**: `sox` drops the PulseAudio buffer on stop (~1.2 s of the phrase tail);
  `parecord --latency-msec=100` keeps the buffer tiny — only ≤0.1 s is lost.
- **Manual stop instead of silence auto-stop**: in a noisy room a silence threshold either fails to
  catch pauses or chops words.
- **`small`, not `large-v3-turbo`**: ~8× faster (4–8 s vs 42 s) for a negligible loss of Russian
  accuracy.
- **No LLM normalization**: an extra link and extra latency; the transcript is easy to edit in the
  session anyway.
- **TTS in pure TypeScript**: only the native `piper` binary is spawned — no Python, unlike the
  Claude Code `speak-reply.py` approach this project replaced.
- **TTS is opt-in**: `options.tts.enabled` defaults to `false`, so voice input works out of the box
  without surprising anyone with sound.

## Acknowledgements

Inspired by [@renjfk](https://github.com/renjfk)'s
[opencode-voice](https://github.com/renjfk/opencode-voice) — a full STT + TTS plugin for OpenCode
that first showed me how the v2 TUI plugin API is put together. It was the working reference for the
key details that aren't in the docs: the TUI-only `context.data`, the `parecord` recorder with its
tiny latency buffer, and the `Ctrl+R` / `session.rename` conflict.
