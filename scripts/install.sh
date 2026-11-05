#!/usr/bin/env bash
# Install the opencode-speech plugin and its runtime dependencies:
#   - system: sox, pulseaudio-utils (parecord), cmake, build tools
#   - whisper-cli: built from source (not packaged for Ubuntu)
#   - whisper model: ggml-small.bin from huggingface
#
# Idempotent: safe to re-run. Skips steps whose result is already present.
set -euo pipefail

WHISPER_CLI="$HOME/.local/bin/whisper-cli"
MODELS_DIR="$HOME/.local/share/whisper-cpp"
MODEL_NAME="ggml-small.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}"
BUILD_DIR="$(mktemp -d)"
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"

info()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m==> skip\033[0m %s\n' "$*"; }
err()   { printf '\033[1;31m==> error:\033[0m %s\n' "$*"; }

# 1. System packages ---------------------------------------------------------
info "System packages (parecord, sox, cmake, build tools)"
if command -v parecord >/dev/null 2>&1 && command -v sox >/dev/null 2>&1 \
   && command -v cmake >/dev/null 2>&1 && command -v g++ >/dev/null 2>&1; then
  warn "all system packages already present"
else
  echo "Installing: sox pulseaudio-utils cmake build-essential (needs sudo)"
  sudo apt-get update
  sudo apt-get install -y sox pulseaudio-utils cmake build-essential
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
with open(path) as f:
    cfg = json.load(f)
cfg["plugins"] = [p for p in cfg.get("plugins", []) if not str(p).endswith("/plugin")]
cfg.setdefault("plugins", []).append(plugin_dir)
cfg.setdefault("keybinds", {})["session.rename"] = "none"
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
  *) warn "add $HOME/.local/bin to your PATH so whisper-cli resolves" ;;
esac

rm -rf "$BUILD_DIR"
info "Done. Restart opencode, then press Ctrl+R in the TUI to record."
