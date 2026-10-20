"""Assemble preserved audit evidence into indexes. No product/test execution."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round11"
EV = OUT / "evidence"
BASE = "b8b776d56e5982e59b18de0262d5c49367746625"


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def save(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


chat = json.loads((EV / "chat-findings.json").read_text())["findings"]
assert len(chat) == 1 and chat[0]["id"] == "CHAT-R11-01"
row = chat[0]
source = row["source"]
blob = subprocess.check_output(["git", "show", BASE + ":" + source], cwd=ROOT)
assert 0 < row["line"] <= len(blob.decode().splitlines())
heading = next(n for n, text in enumerate((OUT / "chat.md").read_text().splitlines(), 1)
               if text.startswith("#") and row["id"] in text)
findings = [dict(id=row["id"], priority="P3", title=row["title"], source=source, line=row["line"],
    report="chat.md", reportLine=heading, log="evidence/chat-progress-load.first.log",
    evidenceLevel=row["dynamicScope"], staticScope=row["staticScope"], limitations=row["limitations"],
    status="confirmed-at-frozen-source-baseline", currentMainSourceDisposition="direct-source-unchanged-at-reviewed-main",
    runtimeRetested=False)]
save("findings.json", dict(baseline=BASE, count=1, priorities={"P3": 1}, findings=findings))
candidates = json.loads((EV / "hooks-candidates.json").read_text())
candidates += json.loads((EV / "chat-candidates.json").read_text())["candidates"]
assert {row["id"] for row in candidates} == {"HOOK-R11-C1", "CHAT-R11-C1"}
save("candidates.json", dict(baseline=BASE, count=2, candidates=candidates,
    note="One actual HookRegistry timing observation with unproven production contract; one static Markdown candidate skipped after official-source access failure. Neither is a confirmed product bug.",
    staticNotPromoted=[
        dict(report="composition.md", subject="digest body exclusions and non-ordinary declaration shapes", reason="Topology projection is deliberate; no normal producer/stronger accepted contract for null-prototype/complex Map-key shape."),
        dict(report="host.md", subject="mutable caller-owned service references", reason="Known HL-C1 and no new normal mutation/snapshot contract; not repeated."),
    ]))

names = ["root-composition-existing", "root-composition-controls", "hooks-pure-contracts",
         "hooks-existing-pure", "host-lifecycle-controls", "chat-progress-load", "chat-channel-baseline"]
runs = []
for name in names:
    log = EV / (name + ".first.log")
    raw = log.read_bytes()
    text = raw.decode(errors="replace")
    exit_file = next(path for path in [EV / (name + suffix)
        for suffix in [".first.exit.json", ".first-exit.json", ".first.receipt.json", ".first.exit.txt"]]
        if path.is_file())
    code = json.loads(exit_file.read_text())["exitCode"] if exit_file.suffix == ".json" else int(exit_file.read_text().strip())
    complete = re.search(r"Completed Bun shard: (\d+) tests, (\d+) skipped; (\d+) failures\.", text)

    def count(pattern):
        match = re.search(pattern, text, re.M)
        return int(match.group(1)) if match else None

    run = dict(log="evidence/" + log.name, exitFile="evidence/" + exit_file.name, firstRun=True,
        exitCode=code, completed=bool(complete), passed=count(r"^\s*(\d+) pass\s*$"),
        failed=count(r"^\s*(\d+) fail\s*$"), expectations=count(r"^\s*(\d+) expect\(\) calls\s*$"),
        skipped=int(complete.group(2)) if complete else None, sha256=sha(raw))
    assert complete and code == run["failed"] == run["skipped"] == 0, run
    assert run["passed"] == int(complete.group(1))
    runs.append(run)
totals = dict(firstBunShards=len(runs), completedCleanShards=len(runs), passedTests=sum(row["passed"] for row in runs),
    expectations=sum(row["expectations"] for row in runs), skippedOrFilteredTests=sum(row["skipped"] for row in runs),
    failedShardsSeparatelyRetained=0, existingBaselineTests=21, newFocusedObservationsAndControls=21)
assert totals["passedTests"] == 42 and totals["expectations"] == 619, totals
save("validation.json", dict(baseline=BASE, totals=totals, runs=runs, notes=[
    "Seven first raw combined stdout/stderr logs and exits saved before inspection; no failed Bun shard/product rerun.",
    "42 tests = 21 existing baseline + 21 focused observations/controls; shared finding logs counted once.",
    "Notification load defect uses real progress/relay/watcher prototype and memory store/pages/sleep/fake adapter; no client constructor, descriptor, request, checkpoint, real OS read failure or network.",
    "No permanent notification-loss claim: cursor stays on the event and new handler can recover. Actual retry demonstration is bounded to three failed iterations.",
    "Hook registration remains a contract candidate; synthetic mid-emit registration is not an Engine repeated-injection claim.",
    "Compiler tests run ordinary metadata only; tool/query callables never run. Host lifecycle adapters are synchronous memory callbacks and dispatch is not invoked.",
    "Static navigation/official-source access and metadata snapshot guard diagnostics separately retained; no skipped product direction recovered.",
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
skipped = {"packages/chat/src/package.json": "Explicitly failed static navigation; not read or validated. See chat-navigation-skip.md."}
manifest, unresolved, skipped_references = [], [], []
for name in sorted(sources):
    if name in skipped:
        skipped_references.append(dict(path=name, reason=skipped[name]))
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
    note="Frozen Git blob SHA and current equality separate. Selected source inventory is not full-file/full-depth/transitive-dependency review coverage."))
files = []
for path in sorted(OUT.rglob("*")):
    if path.is_file() and path.name != "evidence-index.json":
        raw = path.read_bytes()
        files.append(dict(path=str(path.relative_to(OUT)), bytes=len(raw), sha256=sha(raw)))
save("evidence-index.json", dict(baseline=BASE, algorithm="sha256", files=files,
    note="Self excluded; first raw process logs verbatim; tool-response transcriptions labeled. Metadata-only assembly executes no product/test code."))
print(json.dumps(dict(findings=1, candidates=2, totals=totals, sources=len(manifest), evidenceFiles=len(files)), ensure_ascii=False))
