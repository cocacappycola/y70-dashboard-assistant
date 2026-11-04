# text-tools: an example Jarvis tool package in Python. See docs/PACKAGES.md.
#
# Jarvis sends one JSON line per call on stdin and reads one JSON line back
# on stdout with the same id. Print debugging to stderr: it lands in the
# package's log.
import json
import re
import sys


def text_stats(inp, context):
    text = str(inp.get("text") or "")
    if not text.strip():
        raise ValueError("there is no text to count")
    words = re.findall(r"\b[\w'-]+\b", text)
    sentences = [s for s in re.split(r"[.!?]+(?:\s|$)", text) if s.strip()]
    paragraphs = [p for p in re.split(r"\n\s*\n", text) if p.strip()]
    n = len(words)
    # About 230 words a minute read silently, 150 spoken.
    read = max(1, round(n / 230))
    speak = max(1, round(n / 150))
    s = lambda k, word: f"{k} {word}" + ("" if k == 1 else "s")
    return (f"{s(n, 'word')}, {s(len(text), 'character')} ({len(re.sub(r'[ \t\r\n]', '', text))} without spaces), "
            f"{s(len(sentences), 'sentence')}, {s(len(paragraphs), 'paragraph')}. "
            f"About {read} min to read and {speak} min to say aloud.")


def change_case(inp, context):
    text = str(inp.get("text") or "")
    to = str(inp.get("to") or "")
    words = re.findall(r"[A-Za-z0-9]+", text)
    if to == "upper":
        return text.upper()
    if to == "lower":
        return text.lower()
    if to == "title":
        small = {"a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to", "with"}
        parts = text.lower().split(" ")
        return " ".join(w.capitalize() if i == 0 or w not in small else w for i, w in enumerate(parts))
    if to == "sentence":
        t = text.strip().lower()
        return re.sub(r"(^|[.!?]\s+)([a-z])", lambda m: m.group(1) + m.group(2).upper(), t)
    if to == "camel":
        return words[0].lower() + "".join(w.capitalize() for w in words[1:]) if words else ""
    if to == "snake":
        return "_".join(w.lower() for w in words)
    raise ValueError("to must be upper, lower, title, sentence, camel or snake")


TOOLS = {"text_stats": text_stats, "change_case": change_case}


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get("type") != "call":
            continue
        try:
            fn = TOOLS.get(msg.get("tool"))
            if fn is None:
                raise ValueError("no tool called " + str(msg.get("tool")))
            out = fn(msg.get("input") or {}, msg.get("context") or {})
            send({"type": "result", "id": msg.get("id"), "content": out if isinstance(out, str) else json.dumps(out)})
        except Exception as e:  # noqa: BLE001 - reported to Jarvis
            send({"type": "result", "id": msg.get("id"), "content": "Failed: " + str(e), "error": True})


if __name__ == "__main__":
    main()
