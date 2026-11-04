# Jarvis's Qwen3-TTS voices, through faster-qwen3-tts (CUDA graphs: measured
# 2.5-3.3x faster than real time on an RTX 4080 SUPER, vs 0.4x for the plain
# package).
#
#   python tts-qwen.py '<json config>'
#
# The config says which model and how it speaks:
#   {"mode":"clone","model":"...\\Qwen3-TTS-12Hz-0.6B-Base","ref":"...\\voices\\jarvis.mp3","words":"...\\voices\\jarvis.txt"}
#       a Base model speaking in the voice of a clip (its exact words in the .txt)
#   {"mode":"stock","model":"...\\Qwen3-TTS-12Hz-0.6B-CustomVoice","speaker":"ryan"}
#       a CustomVoice model's own speakers (each request may name another
#       speaker, and with the 1.7B an "instruct": a style such as "calm")
#   {"mode":"design","model":"...\\Qwen3-TTS-12Hz-1.7B-VoiceDesign","instruct":"<the voice, described>","text":"...","out":"...\\voices\\name.wav"}
#       once: invent a voice from the description, say the text in it, save
#       the clip and its words (a .txt beside it), exit. Cloning that clip
#       then keeps the voice the same from sentence to sentence, which the
#       design model alone does not.
#
# One JSON object per line, both ways, like the Kokoro helper:
#   <- {"type":"ready","model":"Qwen3-TTS-12Hz-0.6B-Base","loadSeconds":24.1,"speakers":[...]}
#   -> {"id":7,"text":"Good evening.","speaker":"ryan","instruct":""}
#   <- {"type":"tts","id":7,"mime":"audio/wav","data":"<base64>","seconds":1.2}
# Runs on the GPU. Exits when the dashboard closes its stdin.
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


def cap_for(text):
    # 12 codec steps a second; speech runs about 14 characters a second.
    # Capping at twice that stops a sampled-in long pause or ramble.
    return int(min(2048, 24 + len(text) * 1.8))


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    cfg = json.loads(sys.argv[1])
    mode = cfg.get("mode", "clone")
    t0 = time.time()
    try:
        import torch
        from faster_qwen3_tts import FasterQwen3TTS
        model = FasterQwen3TTS.from_pretrained(cfg["model"], device="cuda", dtype=torch.bfloat16, local_files_only=True)
        speakers = []
        if mode == "clone":
            with open(cfg["words"], encoding="utf-8") as f:
                ref_text = f.read().strip()
            ref_audio = cfg["ref"]

            def say(text, req):
                return model.generate_voice_clone(text=text, language=req.get("language") or "English", ref_audio=ref_audio, ref_text=ref_text, max_new_tokens=cap_for(text))
        elif mode == "stock":
            # The speaker list lives on the wrapped Qwen3TTSModel.
            getter = getattr(model, "get_supported_speakers", None) or getattr(getattr(model, "model", None), "get_supported_speakers", None)
            try:
                speakers = sorted(s.lower() for s in (getter() if getter else []) or [])
            except Exception:  # noqa: BLE001
                speakers = []
            if not speakers:
                speakers = ["aiden", "dylan", "eric", "ono_anna", "ryan", "serena", "sohee", "uncle_fu", "vivian"]
            default_speaker = cfg.get("speaker") or (speakers[0] if speakers else "ryan")

            def say(text, req):
                spk = (req.get("speaker") or default_speaker).lower()
                if speakers and spk not in speakers:
                    spk = default_speaker
                instruct = (req.get("instruct") or cfg.get("instruct") or "").strip() or None
                return model.generate_custom_voice(text=text, speaker=spk, language=req.get("language") or "English", instruct=instruct, max_new_tokens=cap_for(text))
        elif mode == "design":
            text = cfg["text"]
            wavs, sr = model.generate_voice_design(text=text, instruct=cfg["instruct"], language=cfg.get("language") or "English", max_new_tokens=cap_for(text) + 60)
            out = cfg["out"]
            with open(out, "wb") as f:
                f.write(to_wav(wavs[0], sr))
            with open(os.path.splitext(out)[0] + ".txt", "w", encoding="utf-8") as f:
                f.write(text + "\n")
            emit({"type": "designed", "path": out, "seconds": round(time.time() - t0, 1), "audioSeconds": round(len(wavs[0]) / sr, 2)})
            return 0
        else:
            raise ValueError("unknown mode " + mode)
        # The first generation captures the CUDA graphs (about 8 s): pay it now.
        say("Ready.", {})
    except Exception as e:  # noqa: BLE001 - reported to the dashboard
        emit({"type": "error", "error": type(e).__name__ + ": " + str(e)})
        return 1
    emit({"type": "ready", "mode": mode, "model": os.path.basename(os.path.normpath(cfg["model"])), "loadSeconds": round(time.time() - t0, 1),
          "vramGB": round(torch.cuda.max_memory_allocated() / 1e9, 2), "speakers": speakers})

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
            wavs, sr = say(text, req)
            emit({"type": "tts", "id": rid, "mime": "audio/wav", "data": base64.b64encode(to_wav(wavs[0], sr)).decode("ascii"),
                  "seconds": round(time.time() - a, 2), "audioSeconds": round(len(wavs[0]) / sr, 2)})
        except Exception as e:  # noqa: BLE001
            emit({"type": "tts", "id": rid, "error": type(e).__name__ + ": " + str(e)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
