# opencode-speech

Speech-to-text (STT) voice input for [OpenCode](https://opencode.ai) v2 — a plugin that records
audio from the microphone, transcribes it **locally** with
[whisper.cpp](https://github.com/ggml-org/whisper.cpp), and sends the text straight into the
current session.

- **Input only (STT).** There is no read-aloud (TTS) here.
- **Local and private.** Transcription runs on your machine — nothing leaves for the cloud, and
  there is no LLM normalization pass.
- **Russian out of the box** (the `small` model — the speed/accuracy sweet spot); the language is
  configurable in `tui.ts`.

## How it works

`Ctrl+R` → `parecord` records 16 kHz mono → `whisper-cli` transcribes (`-l ru`, 8 threads) → the
text goes straight into the session. Stopping is manual (press `Ctrl+R` again): silence auto-stop is
intentionally disabled because, in a noisy room, it chops phrases on micro-pauses.

## Requirements

- **Linux** with PulseAudio (Ubuntu/Debian tested; WSL2 — see below).
- **OpenCode ≥ 2.2** (the plugin targets the v2 TUI API; tested on 2.2.5).
- `sudo` to install system packages (one time only).

## Installation

```bash
git clone https://github.com/otokarev/opencode-speech.git
cd opencode-speech
./scripts/install.sh
```

`install.sh` does everything itself and is idempotent (safe to run again):

1. installs system packages: `sox`, `pulseaudio-utils` (provides `parecord`), `cmake`,
   `build-essential`;
2. builds `whisper-cli` from source into `~/.local/bin/whisper-cli`
   (it is not packaged for Ubuntu's apt — building from source is the only sensible route);
3. downloads the `ggml-small.bin` model (~466 MB) into `~/.local/share/whisper-cpp/`;
4. registers the plugin in `~/.config/opencode/cli.json` and frees the `Ctrl+R` hotkey
   (by default it is taken by session rename).

After installing, **restart opencode** and press `Ctrl+R` in the TUI.

### Manual installation (without install.sh)

The same result, step by step:

```bash
# 1. system packages
sudo apt-get install -y sox pulseaudio-utils cmake build-essential

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
  "plugins": [ "/absolute/path/to/opencode-speech/plugin" ]
}
```

## Usage

| Action | How |
|---|---|
| Start recording | `Ctrl+R` (or `/stt-record`) |
| Stop and send | `Ctrl+R` again — transcribes and sends to the session |

The text goes into the session immediately, with no edit dialog: opencode v2 has no API to insert
text into the input line (the composer-append API was removed). If you need editing, just fix the
transcript inline in the already-open session.

## Path configuration

The plugin is portable: paths come from environment variables, falling back to home-directory
defaults.

| What | Variable | Default |
|---|---|---|
| `whisper-cli` binary | `OPENCODE_STT_WHISPER_CLI` | `~/.local/bin/whisper-cli` |
| models directory | `OPENCODE_STT_MODELS_DIR` | `~/.local/share/whisper-cpp` |

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
