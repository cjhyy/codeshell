"""Read all historical Markdown and parsed JSON leaves; no product execution."""
import hashlib
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[3]
BASE = "badc2262a90966f6f903977b849adf1f22b55e9f"
PATTERNS = {
    "image_probe": r"image-byte-probe|probeImageBytes|sanitizeImageBytes",
    "jpeg_lossless": r"(?:lossless|无损|SOF3|SOF7|SOF11|DQT|DNL|quantization|量化).{0,100}(?:JPEG|JPG|image)|(?:JPEG|JPG|image).{0,100}(?:lossless|无损|SOF3|SOF7|SOF11|DQT|DNL|quantization|量化)",
    "webp_dimensions": r"(?:webp|VP8X|VP8L|ANMF).{0,100}(?:canvas|dimension|尺寸|画布|width|height|尺寸)|(?:canvas|dimension|尺寸|画布).{0,100}(?:webp|VP8X|VP8L|ANMF)",
    "relay_stream": r"createRelayByteStream|byte-stream[.]ts|relay.{0,30}(?:frame|stream|backpressure|分片|回压)",
    "codex_parse": r"codex-parse|parseCodexJsonLine|extractThreadId",
}
compiled = {k: re.compile(v, re.I) for k, v in PATTERNS.items()}
hits = {k: [] for k in PATTERNS}
counts = {k: 0 for k in PATTERNS}
inventory = []
errors = []
scan = {"markdownFiles": 0, "jsonFiles": 0, "jsonStringLeaves": 0}

def leaves(value, loc="$"):
    if isinstance(value, str):
        yield loc, value
    elif isinstance(value, list):
        for i, item in enumerate(value):
            yield from leaves(item, f"{loc}[{i}]")
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from leaves(item, f"{loc}.{key}")

for directory in (ROOT / "docs", ROOT / "bugs"):
    for path in sorted(directory.rglob("*")):
        if not path.is_file() or path.suffix not in (".md", ".json"):
            continue
        relative = path.relative_to(ROOT).as_posix()
        if relative.startswith("docs/audit-2026-10-17-round14/"):
            continue
        try:
            raw = path.read_bytes()
            inventory.append({"path": relative, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()})
            content = raw.decode("utf-8")
            if path.suffix == ".json":
                scan["jsonFiles"] += 1
                units = list(leaves(json.loads(content)))
                scan["jsonStringLeaves"] += len(units)
            else:
                scan["markdownFiles"] += 1
                units = [("$", content)]
            for location, text in units:
                for key, pattern in compiled.items():
                    for match in pattern.finditer(text):
                        counts[key] += 1
                        if len(hits[key]) < 120:
                            hits[key].append({"file": relative, "location": location, "snippet": text[max(0, match.start()-100):match.end()+240]})
        except Exception as error:
            errors.append({"file": relative, "error": str(error)})
out = {"frozenSource": BASE, "scope": "Every Markdown file and parsed JSON string leaf in docs/bugs including archive/_archive; current round14 excluded", "patterns": PATTERNS, "scanned": scan, "inventory": inventory, "parseErrors": errors, "matchCounts": counts, "maxContextsPerPattern": 120, "hits": hits}
output = pathlib.Path(__file__).with_suffix(".json")
output.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"output": output.relative_to(ROOT).as_posix(), "scanned": scan, "parseErrors": errors, "matchCounts": counts}))
