# opencode-speech

Voice input and output for [OpenCode](https://opencode.ai) v2 — a plugin that records audio from the
microphone, transcribes it **locally** with [whisper.cpp](https://github.com/ggml-org/whisper.cpp),
sends the text straight into the current session, and can read the assistant's replies aloud with
[piper](https://github.com/rhasspy/piper), [RHVoice](https://github.com/RHVoice/RHVoice), or
[silero](https://github.com/snakers4/silero-models).

- **Speech-to-text (STT):** `Ctrl+R` records, whisper transcribes locally, the text goes straight
  into the session.
- **Text-to-speech (TTS):** the last reply is spoken aloud via piper, RHVoice, or silero.
- **Local and private.** Both directions run on your machine — nothing leaves for the cloud.
- **Russian out of the box** (the `small` whisper model — the speed/accuracy sweet spot;
  configurable via `options.stt.language`).

## Quick start

```bash
git clone https://github.com/otokarev/opencode-speech.git
cd opencode-speech
./scripts/install.sh
```

Then **restart opencode**. Hotkeys and commands:

| What | How |
|---|---|
| Record voice / send to session | `Ctrl+R` (or `/stt-record`) — press again to stop & send |
| Mute / unmute read-aloud | `Ctrl+T` (or `/tts-toggle`) |
| Enable read-aloud by default | `options.tts.enabled: true` in `cli.json` (see [Configuration](#configuration)) |

`Ctrl+T` is used for the mute toggle (not `Ctrl+M`, which is indistinguishable from Enter in most
terminals and never reaches the plugin).

## Contents

- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Path configuration](#path-configuration)
- [Configuration](#configuration)
- [TTS setup](#tts-setup)
- [Model selection](#model-selection)
- [Troubleshooting](#troubleshooting)
- [WSL2](#wsl2)
- [Acknowledgements](#acknowledgements)
- [License](#license)

## How it works

- **STT:** `Ctrl+R` → `parecord` records 16 kHz mono → `whisper-cli` transcribes (`-l ru`, 8 threads)
  → the text goes straight into the session. Stopping is manual (press `Ctrl+R` again): silence
  auto-stop is intentionally disabled because, in a noisy room, it chops phrases on micro-pauses.
- **TTS:** on `session.execution.succeeded`, the **last** assistant reply is cleaned of markdown, cut
  to the first `N` sentences, and piped through `piper` into `aplay`. Only the final message is read —
  intermediate turns/tool calls are not. Enabled via `options.tts` (see [Configuration](#configuration)).

## Requirements

- **Linux** with PulseAudio (Ubuntu/Debian tested; WSL2 — see below).
- **OpenCode ≥ 2.2** (the plugin targets the v2 TUI API; tested on 2.2.5).
- `sudo` to install system packages (one time only).

`./scripts/install.sh` installs everything below automatically. Here is what each piece needs:

| Engine | Install method | What it needs | Where it goes |
|---|---|---|---|
| **STT (whisper)** | build from source | `whisper-cli` binary + a `ggml-*.bin` model | `~/.local/bin/whisper-cli`, `~/.local/share/whisper-cpp/` |
| **piper** | release tarball | `piper` binary + `ru_RU-<name>-medium.onnx` (+`.json`) | `~/.local/share/piper/` |
| **RHVoice** | apt | `rhvoice` + `rhvoice-russian` | system (`RHVoice-test`) |
| **silero** | venv + pip | python venv (torch) + `v4_ru.pt` model (+ the `silero/` scripts in this repo) | `~/.local/share/silero/` |

Player (`aplay`) comes from `alsa-utils` (apt). The recognized voice is selected via
`options.tts.voice` (`piper:irina`, `rhvoice:elena`, `silero:baya`, …) — see [Configuration](#configuration).

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
5. registers the plugin in `~/.config/opencode/cli.json` (with an `options.tts` block, TTS on by
   default; mute with `Ctrl+T`) and frees the `Ctrl+R` hotkey (by default it is taken by session rename).

When it finishes, **restart opencode** — the plugin then loads, and `Ctrl+R` / `Ctrl+T` are live in the TUI.

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

The recognized text is sent straight into the session (no edit dialog); fix it inline if needed.

## Path configuration

The plugin is portable: paths come from environment variables, falling back to home-directory
defaults.

| What | Variable | Default |
|---|---|---|
| `whisper-cli` binary | `OPENCODE_STT_WHISPER_CLI` | `~/.local/bin/whisper-cli` |
| models directory | `OPENCODE_STT_MODELS_DIR` | `~/.local/share/whisper-cpp` |
| piper directory (TTS) | `OPENCODE_TTS_PIPER_DIR` | `~/.local/share/piper` |
| rhvoice binary (TTS) | `OPENCODE_TTS_RHVOICE_BIN` | `RHVoice-test` (from `$PATH`) |
| silero python (TTS) | `OPENCODE_TTS_SILERO_PYTHON` | `~/.local/share/silero/venv/bin/python` |
| silero speak.py (TTS) | `OPENCODE_TTS_SILERO_SPEAK` | `../silero/speak.py` (in this repo) |

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
| `enabled` | `true` | starting TTS state; `Ctrl+T`/`/tts-toggle` overrides it at runtime for the session |
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

This yields `~/.local/share/piper/piper/piper` (the executable) alongside its bundled libraries. The
plugin launches `~/.local/share/piper/piper/piper` and relies on those sibling files — do not move the
binary out of that folder.

> The tarball retains the `piper/` directory when extracted, so extract into `~/.local/share/piper`
> (one level up), **not** into `~/.local/share/piper/piper`. For other architectures pick
> `piper_arm64.tar.gz` or `piper_armv7.tar.gz` from the same release.

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

### 4. Adding another piper voice

No code change is needed — the `piper` provider derives the model path from the voice name
(`ru_RU-<name>-medium.onnx`). To add a voice (e.g. `ksenia`):

```bash
# download the model + its config (the .json carries the sample rate)
curl -fL -o ~/.local/share/piper/ru_RU-ksenia-medium.onnx \
  https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/ru/ru_RU/ksenia/medium/ru_RU-ksenia-medium.onnx
curl -fL -o ~/.local/share/piper/ru_RU-ksenia-medium.onnx.json \
  https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/ru/ru_RU/ksenia/medium/ru_RU-ksenia-medium.onnx.json
```

Then point `options.tts.voice` at it — the `piper:` prefix stays, only the name changes:

```json
"tts": { "voice": "piper:ksenia", "enabled": true }
```

The URL pattern below `<lang>/<voice>/<quality>` mirrors any
[piper voice on Hugging Face](https://huggingface.co/rhasspy/piper-voices). Use `medium` for a good
speed/quality balance; `high`/`low`/`x_low` also exist for most voices.

### 5. RHVoice (alternative engine)

The `rhvoice` provider is built in — it uses the native `RHVoice-test` binary. To use it, install
RHVoice with the Russian voice(s) you want, then set `options.tts.voice` to `rhvoice:<profile>`
(the profile is the bare voice name, e.g. `elena`, `anna`, `irina`):

```bash
# Ubuntu/Debian
sudo apt-get install -y rhvoice rhvoice-russian
```

```json
"tts": { "voice": "rhvoice:elena", "enabled": true }
```

`speed` maps to RHVoice's `--rate` in percent (`speed: 1.0` → 100%), and the stream is a WAV on
stdout that `aplay -t wav` reads directly. To list installed profiles:

```bash
RHVoice-test --help >/dev/null; ls /usr/share/RHVoice/voices/ 2>/dev/null || ls ~/.local/share/RHVoice/voices/
```

Adding another RHVoice voice is just installing it system-wide (apt or a voice package) — no code
change: the provider passes the profile name straight through to `RHVoice-test -p <name>`.

### 6. Silero (alternative engine)

The `silero` provider drives the Silero v4_ru model (a python/torch model). The thin python wrappers —
`speak.py` + `normalize.py` — ship with this repo under `silero/`. You provide the python environment
and the model; both go under `~/.local/share/silero/`.

Speakers: `baya`, `kseniya`, `xenia`, `aidar`, `eugene`.

```bash
# 1. python venv with torch
python3 -m venv ~/.local/share/silero/venv
~/.local/share/silero/venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu

# 2. the v4_ru model
curl -fL -o ~/.local/share/silero/v4_ru.pt \
  https://models.silero.ai/models/tts/ru/v4_ru.pt
```

```json
"tts": { "voice": "silero:baya", "enabled": true }
```

`speed` maps to `speak.py <speaker> <speed>` (1.0 = natural pace); the output is raw PCM at 48 kHz
that `aplay` plays directly. Override the python / speak.py paths with `OPENCODE_TTS_SILERO_PYTHON`
and `OPENCODE_TTS_SILERO_SPEAK` if they are not in the default locations.

> **License:** the Silero `v4_ru` model is published under CC BY-NC-SA 4.0 — **non-commercial use
> only**. This plugin is MIT; the silero model itself is not. For commercial use, pick `piper` or
> `rhvoice` instead.

## Model selection

`tui.ts` looks for whisper models in this order: `ggml-small.bin` → `ggml-medium-q5_0.bin` →
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

## Acknowledgements

Inspired by [@renjfk](https://github.com/renjfk)'s
[opencode-voice](https://github.com/renjfk/opencode-voice).

## License

[MIT](LICENSE). Note: the external TTS engines have their own licenses — in particular the Silero
`v4_ru` model is CC BY-NC-SA (non-commercial only), while piper and RHVoice are free for commercial use.
