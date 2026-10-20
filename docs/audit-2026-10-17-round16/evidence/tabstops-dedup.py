"""Structured historical search; metadata only, no product/test execution."""
from pathlib import Path
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).with_suffix(".json")
PATTERNS = {
    "direct_sources": r"tabstops\.ts|expandTabs|squash-text-nodes|writeLineToScreen",
    "origin_mismatch": r"(?:\btab(?:stop)?s?\b|制表符?).{0,100}(?:origin|offset|measure|column|padding|prefix|测量|列宽|起点|偏移)|(?:measure|测量).{0,100}(?:\btab(?:stop)?s?\b|制表符?)",
    "ansi_grapheme": r"(?:ANSI|SGR|escape|转义|样式).{0,100}(?:ZWJ|grapheme|emoji|组合|字素|表情)|(?:ZWJ|grapheme|字素).{0,100}(?:ANSI|SGR|escape|转义|样式)",
}

def leaves(value, location="$"):
    if isinstance(value, str):
        yield location, value
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from leaves(item, f"{location}[{index}]")
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from leaves(item, f"{location}.{key}")

def scalar_count(value):
    if isinstance(value, dict):
        return sum(scalar_count(item) for item in value.values())
    if isinstance(value, list):
        return sum(scalar_count(item) for item in value)
    return 1

compiled = {key: re.compile(value, re.I) for key, value in PATTERNS.items()}
hits, counts = {key: [] for key in PATTERNS}, {key: 0 for key in PATTERNS}
scanned = dict(markdownFiles=0, jsonFiles=0, jsonStringLeaves=0, jsonScalarLeaves=0)
inventory, errors = [], []
for directory in [ROOT / "docs", ROOT / "bugs"]:
    for path in sorted(directory.rglob("*")):
        if not path.is_file() or path.suffix not in [".md", ".json"] or "audit-2026-10-17-round16" in path.parts:
            continue
        raw = path.read_bytes()
        relative = str(path.relative_to(ROOT))
        inventory.append(dict(path=relative, bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest()))
        try:
            body = raw.decode()
            if path.suffix == ".json":
                scanned["jsonFiles"] += 1
                parsed = json.loads(body)
                units = list(leaves(parsed))
                scanned["jsonScalarLeaves"] += scalar_count(parsed)
                scanned["jsonStringLeaves"] += len(units)
            else:
                scanned["markdownFiles"] += 1
                units = [("$", body)]
            for location, body in units:
                for key, pattern in compiled.items():
                    for match in pattern.finditer(body):
                        counts[key] += 1
                        if len(hits[key]) < 180:
                            hits[key].append(dict(file=relative, location=location, context=body[max(0, match.start()-140):match.end()+280]))
        except Exception as error:
            errors.append(dict(file=relative, error=str(error)))
OUT.write_text(json.dumps(dict(baseline="ac314bf73e99399b72ec0aa7c8ce9d5c3ab4bc2f", scope="All prior docs/bugs Markdown and parsed JSON, archives included; current round excluded.", patterns=PATTERNS, scanned=scanned, parseErrors=errors, matchCounts=counts, maxContextsPerPattern=180, hits=hits, inventory=inventory), ensure_ascii=False, indent=2)+"\n")
print(json.dumps(dict(scanned=scanned, parseErrors=errors, matchCounts=counts)))
