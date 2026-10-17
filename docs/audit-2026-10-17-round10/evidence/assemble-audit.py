"""Build audit indexes from preserved observations. Metadata only; no tests."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round10"
EV = OUT / "evidence"
BASE = "6966dc0f98d21dbc2ecced6cdd6467d17b81bc39"


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def save(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


findings = []
for filename, report, log in [
    ("diagnostics-findings.json", "diagnostics.md", "diagnostics-bounded-projection.first.log"),
    ("pet-findings.json", "pet.md", "pet-search-display.first.log"),
]:
    data = json.loads((EV / filename).read_text())
    rows = data if isinstance(data, list) else data["findings"]
    for row in rows:
        ident = row["id"]
        source = row.get("file", row.get("source"))
        line = row["line"]
        blob = subprocess.check_output(["git", "show", BASE + ":" + source], cwd=ROOT)
        assert 0 < line <= len(blob.decode().splitlines())
        heading = next(n for n, text in enumerate((OUT / report).read_text().splitlines(), 1)
                       if text.startswith("#") and ident in text)
        findings.append(dict(id=ident, priority="P3", title=row["title"], source=source,
            line=line, report=report, reportLine=heading, log="evidence/" + log,
            evidenceLevel=row.get("evidenceLevel", row.get("evidence", "Actual source helper with owned data; see report")),
            limitations=row.get("limitations", row.get("limits", "See report for dynamic/static and platform limits")),
            status="confirmed-at-frozen-source-baseline", currentMainSourceDisposition="direct-source-unchanged-at-reviewed-main",
            runtimeRetested=False))
assert {row["id"] for row in findings} == {"DIAG-R10-01", "PET-R10-01", "PET-R10-02"}
save("findings.json", dict(baseline=BASE, count=3, priorities={"P3": 3}, findings=findings))
candidates = json.loads((EV / "root-candidates.json").read_text())
assert len(candidates) == 1
save("candidates.json", dict(baseline=BASE, count=1, candidates=candidates, staticNotPromoted=[
    dict(report="catalog.md", subject="inferred context-window cache provenance/refresh", reason="Known design observation; caller lookup skipped and no stronger refresh contract."),
    dict(report="runs.md", subject="equal checkpoint timestamp ordering and per-execution model labels", reason="No tie-order or verified historical identity producer/consumer contract; renderer lookup skipped."),
    dict(report="diagnostics.md", subject="performance latest/global time ordering", reason="No promise of latest N or global chronological ordering found."),
]))

names = ["root-run-data", "root-run-existing-baseline", "catalog-existing", "catalog-cache-existing",
         "catalog-data-controls", "diagnostics-bounded-projection", "diagnostics-existing-inspector",
         "pet-search-display", "pet-pure-baseline"]
runs = []
for name in names:
    log = EV / (name + ".first.log")
    raw = log.read_bytes()
    text = raw.decode(errors="replace")
    exit_file = next(path for path in [EV / (name + suffix)
        for suffix in [".first.exit.json", ".first-exit.json", ".first.exit.txt"]] if path.is_file())
    code = json.loads(exit_file.read_text())["exitCode"] if exit_file.suffix == ".json" else int(exit_file.read_text().strip())
    complete = re.search(r"Completed Bun shard: (\d+) tests, (\d+) skipped; (\d+) failures\.", text)

    def count(pattern):
        match = re.search(pattern, text, re.M)
        return int(match.group(1)) if match else None

    row = dict(log="evidence/" + log.name, exitFile="evidence/" + exit_file.name,
               firstRun=True, exitCode=code, completed=bool(complete),
               passed=count(r"^\s*(\d+) pass\s*$"), failed=count(r"^\s*(\d+) fail\s*$"),
               expectations=count(r"^\s*(\d+) expect\(\) calls\s*$"),
               skipped=int(complete.group(2)) if complete else None, sha256=sha(raw))
    assert complete and code == row["failed"] == row["skipped"] == 0, row
    assert row["passed"] == int(complete.group(1))
    runs.append(row)
totals = dict(firstBunShards=len(runs), completedCleanShards=len(runs), passedTests=sum(row["passed"] for row in runs),
    expectations=sum(row["expectations"] for row in runs), skippedOrFilteredTests=sum(row["skipped"] for row in runs),
    failedShardsSeparatelyRetained=0, existingBaselineTests=154, newFocusedObservationsAndControls=15)
assert totals["passedTests"] == 169 and totals["expectations"] == 582, totals
assert totals["existingBaselineTests"] + totals["newFocusedObservationsAndControls"] == totals["passedTests"]
save("validation.json", dict(baseline=BASE, totals=totals, runs=runs, notes=[
    "Nine first raw combined stdout/stderr logs and exit receipts saved before inspection; no failed Bun shard/product rerun.",
    "169 tests = 154 existing baseline tests + 15 focused observations/controls; shared finding logs counted once.",
    "Characterization pass asserts current wrong behavior and controls, not a product fix.",
    "Diagnostics callback uses a fake iterable collection in VM; no real DOM/browser performance, timeout or memory peak claim.",
    "Pet search uses real reader/search over owned temporary transcript metadata, with ASCII/boundary controls. IPC/UI/Host callers are static only.",
    "Catalog assertions establish frozen repository consistency, not current external model capability or pricing facts.",
    "Negative checkpoint text remains a contract candidate because keyword heuristic is documented; no Engine/evaluator/UI success-status claim.",
    "Static path/glob and metadata regex/field/citation diagnostics are separately preserved; add zero product executions and do not recover failed product directions.",
    "No real models/paid APIs/accounts/user data/external messages/native apps/PTY/auth/permission/security/custody/watchdog experiments, shared dist/dependency rebuild or full build/typecheck/lint/test.",
]))

sources = {"CODESHELL.md", "AGENTS.md", "package.json", "bun.lock", "tsconfig.json"}
for path in OUT.glob("*.md"):
    sources.update(re.findall(r"\b(?:packages|scripts|tests)/[A-Za-z0-9_.\-/]+\.(?:tsx?|mjs|cjs|js|md|json)\b", path.read_text()))
for path in EV.glob("*source-manifest.json"):
    data = json.loads(path.read_text())
    for row in data.get("files", data.get("sources", data.get("paths", []))):
        if isinstance(row, dict) and isinstance(row.get("path"), str):
            sources.add(row["path"])
manifest, unresolved = [], []
explicitly_skipped = {
    "packages/core/src/engine.ts": "Catalog's static path lookup failed; no such source was read or validated. See catalog-static-read-failure.md.",
}
skipped_references = []
for name in sorted(sources):
    if name in explicitly_skipped:
        skipped_references.append(dict(path=name, reason=explicitly_skipped[name]))
        continue
    blob = subprocess.run(["git", "show", BASE + ":" + name], cwd=ROOT, capture_output=True)
    path = ROOT / name
    if blob.returncode or not path.is_file():
        unresolved.append(name)
        continue
    manifest.append(dict(path=name, bytes=len(blob.stdout), sha256=sha(blob.stdout), frozenBlobVerified=True,
                         currentWorkingTreeMatchesFrozenBlob=path.read_bytes() == blob.stdout))
assert not unresolved, unresolved
save("source-manifest.json", dict(baseline=BASE,
    assemblyWorkingTreeHead=subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip(),
    files=manifest, unresolvedReferences=unresolved, skippedStaticReferences=skipped_references,
    note="Frozen Git blob SHA and current equality are distinct. Selected source inventory does not imply full-file/full-depth review coverage. Installed nanoid separately pinned in root-preflight."))
files = []
for path in sorted(OUT.rglob("*")):
    if path.is_file() and path.name != "evidence-index.json":
        raw = path.read_bytes()
        files.append(dict(path=str(path.relative_to(OUT)), bytes=len(raw), sha256=sha(raw)))
save("evidence-index.json", dict(baseline=BASE, algorithm="sha256", files=files,
    note="Self excluded; first raw process logs retained verbatim. Tool response transcriptions labeled; metadata-only assembly executes no product/test code."))
print(json.dumps(dict(findings=3, candidates=1, totals=totals, sources=len(manifest), evidenceFiles=len(files)), ensure_ascii=False))
