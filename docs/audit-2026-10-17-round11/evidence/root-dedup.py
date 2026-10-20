"""Bounded structured historical search; metadata only, no product/test execution."""
from pathlib import Path
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).with_suffix(".json")
PATTERNS = {'composition': 'compileComposition|freezeDeclarations|ResolvedComposition|presetInjectedTools|composition snapshot', 'immutability': '(?:composition|declarations?|组合|声明).{0,100}(?:mutab|immutab|freeze|null.prototype|冻结|可变)|(?:freezeDeclarations|null.prototype).{0,100}(?:Map|Set|record|object|properties)', 'digest': 'computeCompositionDigest|compositionDigest|compositionPromptSections'}


def leaves(value, location="$"):
    if isinstance(value, str):
        yield location, value
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from leaves(item, f"{location}[{index}]")
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from leaves(item, f"{location}.{key}")


compiled = {key: re.compile(pattern, re.I) for key, pattern in PATTERNS.items()}
hits = {key: [] for key in PATTERNS}
counts = {key: 0 for key in PATTERNS}
scanned = {"markdownFiles": 0, "jsonFiles": 0, "jsonStringLeaves": 0}
inventory, errors = [], []
for directory in [ROOT / "docs", ROOT / "bugs"]:
    for path in sorted(directory.rglob("*")):
        if not path.is_file() or path.suffix not in [".md", ".json"] or "audit-2026-10-17-round11" in path.parts:
            continue
        raw = path.read_bytes()
        relative = str(path.relative_to(ROOT))
        inventory.append(dict(path=relative, bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest()))
        try:
            text = raw.decode()
            if path.suffix == ".json":
                scanned["jsonFiles"] += 1
                units = list(leaves(json.loads(text)))
                scanned["jsonStringLeaves"] += len(units)
            else:
                scanned["markdownFiles"] += 1
                units = [("$", text)]
            for location, text in units:
                for key, pattern in compiled.items():
                    for match in pattern.finditer(text):
                        counts[key] += 1
                        if len(hits[key]) < 100:
                            hits[key].append(dict(file=relative, location=location,
                                context=text[max(0, match.start() - 140):match.end() + 280]))
        except Exception as error:
            errors.append(dict(file=relative, error=str(error)))
OUT.write_text(json.dumps(dict(baseline="b8b776d56e5982e59b18de0262d5c49367746625",
    scope="All historical docs/bugs Markdown and parsed JSON, archives included; current round excluded.",
    patterns=PATTERNS, scanned=scanned, parseErrors=errors, matchCounts=counts,
    maxContextsPerPattern=100, hits=hits, inventory=inventory), ensure_ascii=False, indent=2) + "\n")
print(json.dumps(dict(scanned=scanned, parseErrors=errors, matchCounts=counts)))
