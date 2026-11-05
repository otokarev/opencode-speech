#!/usr/bin/env bash
# Install the opencode-speech plugin and its runtime dependencies:
#   - system: pulseaudio-utils (parecord), cmake, build tools, alsa-utils (aplay)
#   - whisper-cli: built from source (not packaged for Ubuntu)
#   - whisper model: ggml-small.bin from huggingface
#   - piper binary (release tarball) + ru_RU-irina-medium voice
#
# Idempotent: safe to re-run. Skips steps whose result is already present.
set -euo pipefail

WHISPER_CLI="$HOME/.local/bin/whisper-cli"
MODELS_DIR="$HOME/.local/share/whisper-cpp"
MODEL_NAME="ggml-small.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}"
PIPER_DIR="$HOME/.local/share/piper"
PIPER_BIN="$PIPER_DIR/piper/piper"
PIPER_TARBALL="https://github.com/rhasspy/piper/releases/download/v1.2.0/piper_amd64.tar.gz"
PIPER_VOICE="ru_RU-irina-medium"
BUILD_DIR="$(mktemp -d)"
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"

info()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m==> skip\033[0m %s\n' "$*"; }
err()   { printf '\033[1;31m==> error:\033[0m %s\n' "$*"; }

# Clean the temp build dir even on early exit (set -e).
trap 'rm -rf "$BUILD_DIR"' EXIT

# 1. System packages ---------------------------------------------------------
info "System packages (parecord, cmake, build tools)"
if command -v parecord >/dev/null 2>&1 \
   && command -v cmake >/dev/null 2>&1 && command -v g++ >/dev/null 2>&1; then
  warn "all system packages already present"
else
  echo "Installing: pulseaudio-utils cmake build-essential (needs sudo)"
  sudo apt-get update
  sudo apt-get install -y pulseaudio-utils cmake build-essential
fi

# 2. whisper-cli (build from source if missing) ------------------------------
if [ -x "$WHISPER_CLI" ]; then
  warn "whisper-cli already present: $WHISPER_CLI"
else
  info "Building whisper-cli from source (this takes a few minutes)"
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$BUILD_DIR/whisper.cpp"
  cmake -B "$BUILD_DIR/whisper.cpp/build" "$BUILD_DIR/whisper.cpp" \
    -DGGML_CUDA=OFF -DCMAKE_BUILD_TYPE=Release
  cmake --build "$BUILD_DIR/whisper.cpp/build" -j --target whisper-cli
  mkdir -p "$HOME/.local/bin"
  cp "$BUILD_DIR/whisper.cpp/build/bin/whisper-cli" "$WHISPER_CLI"
  chmod +x "$WHISPER_CLI"
  info "whisper-cli installed to $WHISPER_CLI"
fi

# 3. Whisper model -----------------------------------------------------------
mkdir -p "$MODELS_DIR"
if [ -s "$MODELS_DIR/$MODEL_NAME" ]; then
  warn "model already present: $MODELS_DIR/$MODEL_NAME"
else
  info "Downloading whisper model $MODEL_NAME (~466 MB)"
  curl -fL -o "$MODELS_DIR/$MODEL_NAME" "$MODEL_URL"
  info "model saved: $MODELS_DIR/$MODEL_NAME"
fi

# 3b. TTS dependencies --------------------------------------------------------
info "TTS: piper binary + voice + aplay"

if ! command -v aplay >/dev/null 2>&1; then
  echo "Installing: alsa-utils (needs sudo)"
  sudo apt-get install -y alsa-utils
else
  warn "aplay already present"
fi

if [ -x "$PIPER_BIN" ]; then
  warn "piper already present: $PIPER_BIN"
else
  info "Downloading piper (release tarball)"
  mkdir -p "$PIPER_DIR"
  curl -fL "$PIPER_TARBALL" | tar xz -C "$PIPER_DIR"
  info "piper installed to $PIPER_BIN"
fi

if [ -s "$PIPER_DIR/$PIPER_VOICE.onnx" ] && [ -s "$PIPER_DIR/$PIPER_VOICE.onnx.json" ]; then
  warn "voice already present: $PIPER_VOICE"
else
  info "Downloading voice $PIPER_VOICE"
  curl -fL -o "$PIPER_DIR/$PIPER_VOICE.onnx" \
    "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/ru/ru_RU/irina/medium/$PIPER_VOICE.onnx"
  curl -fL -o "$PIPER_DIR/$PIPER_VOICE.onnx.json" \
    "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/ru/ru_RU/irina/medium/$PIPER_VOICE.onnx.json"
  info "voice saved: $PIPER_VOICE"
fi

# 4. Plugin wiring -----------------------------------------------------------
info "Registering the plugin in ~/.config/opencode/cli.json"
CLI_JSON="$HOME/.config/opencode/cli.json"
mkdir -p "$HOME/.config/opencode"

# Bootstrap a minimal cli.json if absent.
if [ ! -f "$CLI_JSON" ]; then
  printf '{\n  "$schema": "https://opencode.ai/v2/cli.json"\n}\n' > "$CLI_JSON"
fi

if command -v python3 >/dev/null 2>&1; then
  python3 - "$CLI_JSON" "$PLUGIN_DIR/plugin" <<'PY'
import json, sys, os
path, plugin_dir = sys.argv[1], sys.argv[2]
plugin_dir = os.path.realpath(plugin_dir)
with open(path) as f:
    cfg = json.load(f)

# Normalise the plugin list to objects, keeping any existing options on ours.
plugins = []
seen = False
for p in cfg.get("plugins", []):
    if isinstance(p, str):
        p = {"package": p, "options": {}}
    pkg = os.path.realpath(p.get("package", "")) if p.get("package") else ""
    if pkg == plugin_dir:
        if seen:
            continue
        seen = True
        p = {"package": plugin_dir, "options": p.get("options", {})}
        p["options"].setdefault("stt", {"language": "ru"})
        # TTS is opt-in: add the settings block without forcing it on.
        p["options"].setdefault("tts", {
            "voice": "piper:irina",
            "speed": 1.0,
            "sentences": 2,
            "enabled": False,
        })
    plugins.append(p)

if not seen:
    plugins.append({
        "package": plugin_dir,
        "options": {
            "stt": {"language": "ru"},
            "tts": {"voice": "piper:irina", "speed": 1.0, "sentences": 2, "enabled": False},
        },
    })

cfg["plugins"] = plugins

# Free the Ctrl+R hotkey (taken by session rename). Keep any existing value if
# the user already set their own — only default it when absent.
kb = cfg.setdefault("keybinds", {})
if "session.rename" not in kb:
    kb["session.rename"] = "none"

with open(path, "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
else
  warn "python3 not found; edit $CLI_JSON by hand to add the plugin path"
fi

# 5. PATH hint ---------------------------------------------------------------
case ":$PATH:" in
  *":$HOME/.local/bin:"*) : ;;
  *) warn "$HOME/.local/bin is not on PATH; the plugin resolves whisper-cli by absolute path, but add it to run whisper-cli by hand" ;;
esac

info "Done. Restart opencode, then press Ctrl+R in the TUI to record; replies are spoken with piper once options.tts.enabled is true."
