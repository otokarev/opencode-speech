"""Read text from stdin, write Silero v4_ru speech to stdout as raw S16_LE mono PCM at 48 kHz.

Usage: speak.py SPEAKER [SPEED]   SPEED 1.0 = the model's natural pace

The v4_ru.pt model path is taken from env SILERO_MODEL; falls back to the file
next to this script (for the original ~/.local/share/silero layout).
"""
import os
import sys
from xml.sax.saxutils import escape

import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from normalize import normalize  # noqa: E402

MODEL_PATH = os.environ.get("SILERO_MODEL") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "v4_ru.pt"
)
SAMPLE_RATE = 48000


def main() -> None:
    speaker = sys.argv[1]
    speed = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
    text = normalize(sys.stdin.read())
    if not text:
        return
    torch.set_num_threads(4)
    model = torch.package.PackageImporter(MODEL_PATH).load_pickle("tts_models", "model")
    ssml = f'<speak><prosody rate="{round(speed * 100)}%">{escape(text)}</prosody></speak>'
    audio = model.apply_tts(ssml_text=ssml, speaker=speaker, sample_rate=SAMPLE_RATE)
    sys.stdout.buffer.write((audio.clamp(-1, 1) * 32767).to(torch.int16).numpy().tobytes())


if __name__ == "__main__":
    main()
