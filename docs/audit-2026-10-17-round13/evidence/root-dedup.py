"""Structured historical search; metadata only, no product/test execution."""
from pathlib import Path
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).with_suffix(".json")
PATTERNS = {
    "git_log": r"parseGitLog|getGitLog|parse-log[.]ts|%H[|]%s[|]%an[|]%ci",
    "pipe_subject": r"(?:git|commit|提交|subject|author).{0,100}(?:pipe|separator|delimiter|竖线|分隔|[|]).{0,100}(?:pars|log|author|截断|字段|提交)|(?:pipe|竖线).{0,100}(?:commit|git log|提交)",
    "transcript_projection": r"mergeTranscripts|foldTranscript|importAutomationRuns|lastCovered|transcriptSignatures",
    "git_status": r"getGitStatus|git[.]trim|porcelain.{0,80}(?:trim|首|空格)",
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

compiled = {key: re.compile(value, re.I) for key, value in PATTERNS.items()}
hits, counts = {key: [] for key in PATTERNS}, {key: 0 for key in PATTERNS}
scanned = dict(markdownFiles=0, jsonFiles=0, jsonStringLeaves=0)
inventory, errors = [], []
for directory in [ROOT / "docs", ROOT / "bugs"]:
    for path in sorted(directory.rglob("*")):
        if not path.is_file() or path.suffix not in [".md", ".json"] or "audit-2026-10-17-round13" in path.parts:
            continue
        raw = path.read_bytes()
        relative = str(path.relative_to(ROOT))
        inventory.append(dict(path=relative, bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest()))
        try:
            body = raw.decode()
            if path.suffix == ".json":
                scanned["jsonFiles"] += 1
                units = list(leaves(json.loads(body)))
                scanned["jsonStringLeaves"] += len(units)
            else:
                scanned["markdownFiles"] += 1
                units = [("$", body)]
            for location, body in units:
                for key, pattern in compiled.items():
                    for match in pattern.finditer(body):
                        counts[key] += 1
                        if len(hits[key]) < 120:
                            hits[key].append(dict(file=relative, location=location, context=body[max(0, match.start()-140):match.end()+280]))
        except Exception as error:
            errors.append(dict(file=relative, error=str(error)))
OUT.write_text(json.dumps(dict(baseline="7927a7c8b80b4aec710dee1f6d831ad1982bb466", scope="All prior docs/bugs Markdown and parsed JSON, archives included; current round excluded.", patterns=PATTERNS, scanned=scanned, parseErrors=errors, matchCounts=counts, maxContextsPerPattern=120, hits=hits, inventory=inventory), ensure_ascii=False, indent=2)+"\n")
print(json.dumps(dict(scanned=scanned, parseErrors=errors, matchCounts=counts)))
