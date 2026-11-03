# Jarvis's cloned voice: Qwen3-TTS (a Base model) speaking in the voice of a
# reference clip, through faster-qwen3-tts (CUDA graphs: measured 2.5-3.3x
# faster than real time on an RTX 4080 SUPER, vs 0.4x for the plain package).
#
#   python tts-qwen.py <model dir> <reference clip> <transcript file>
#
# One JSON object per line, both ways, like the Kokoro helper:
#   <- {"type":"ready","model":"Qwen3-TTS-12Hz-0.6B-Base","loadSeconds":24.1}
#   -> {"id":7,"text":"Good evening."}
#   <- {"type":"tts","id":7,"mime":"audio/wav","data":"<base64>","seconds":1.2}
#
# The clip's exact words are needed to clone it well; they sit in a .txt beside
# the clip. Runs on the GPU (about 3 GB of VRAM for the 0.6B, 5 GB for the
# 1.7B). Exits when the dashboard closes its stdin.
import base64
import io
import json
import os
import sys
import time
import wave

# transformers would import TensorFlow (installed for something else) at
# startup: seconds of loading and a page of warnings for nothing.
os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("TRANSFORMERS_NO_TF", "1")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
os.environ.setdefault("HF_HUB_OFFLINE", "1")


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def to_wav(samples, rate):
    import numpy as np
    pcm = (np.clip(np.asarray(samples, dtype="float32"), -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    model_dir, ref_audio, ref_file = sys.argv[1], sys.argv[2], sys.argv[3]
    t0 = time.time()
    try:
        with open(ref_file, encoding="utf-8") as f:
            ref_text = f.read().strip()
        import torch
        from faster_qwen3_tts import FasterQwen3TTS
        model = FasterQwen3TTS.from_pretrained(model_dir, device="cuda", dtype=torch.bfloat16, local_files_only=True)
        # The first generation captures the CUDA graphs (about 8 s): pay it now.
        model.generate_voice_clone(text="Ready.", language="English", ref_audio=ref_audio, ref_text=ref_text)
    except Exception as e:  # noqa: BLE001 - reported to the dashboard
        emit({"type": "error", "error": type(e).__name__ + ": " + str(e)})
        return 1
    emit({"type": "ready", "model": os.path.basename(os.path.normpath(model_dir)), "loadSeconds": round(time.time() - t0, 1),
          "vramGB": round(torch.cuda.max_memory_allocated() / 1e9, 2)})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            text = str(req.get("text") or "").strip()[:2000]
            if not text:
                emit({"type": "tts", "id": rid, "error": "no text"})
                continue
            a = time.time()
            # 12 codec steps a second; speech runs about 14 characters a second.
            # Capping at twice that stops a sampled-in long pause or ramble.
            cap = int(min(2048, 24 + len(text) * 1.8))
            wavs, sr = model.generate_voice_clone(text=text, language=req.get("language") or "English", ref_audio=ref_audio, ref_text=ref_text, max_new_tokens=cap)
            emit({"type": "tts", "id": rid, "mime": "audio/wav", "data": base64.b64encode(to_wav(wavs[0], sr)).decode("ascii"),
                  "seconds": round(time.time() - a, 2), "audioSeconds": round(len(wavs[0]) / sr, 2)})
        except Exception as e:  # noqa: BLE001
            emit({"type": "tts", "id": rid, "error": type(e).__name__ + ": " + str(e)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
