"""Aggregate audit metadata only. Never import or rerun product code."""
from pathlib import Path
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round27"
EV = OUT / "evidence"
BASE = "9b667863e8a8eb91db7b1f99eb9876169dcf19ec"


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def read(name):
    return json.loads((EV / name).read_text())


def save(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def rows(value, *keys):
    if isinstance(value, list):
        return value
    for key in keys:
        if key in value:
            return value[key]
    raise ValueError(list(value))


findings, candidates, related = [], [], []
for prefix in ["compose", "snapshot", "aggregator", "root-frontier"]:
    findings += rows(read(prefix + "-findings.json"), "findings")
    candidates += rows(read(prefix + "-candidates.json"), "candidates")
    related += rows(read(prefix + "-related.json"), "observations", "related")
assert {row["id"] for row in findings} == {"AGGREGATOR-R27-01"}
assert {row["id"] for row in candidates} == {"COMPOSE-R27-C1"}
assert len(related) == 1 and related[0]["priorId"] == "HL-01"
for name, key, value in [("findings.json", "findings", findings),
                         ("candidates.json", "candidates", candidates),
                         ("related.json", "observations", related)]:
    save(name, dict(baseline=BASE, count=len(value), **{key: value}))

runtime = read("root-validation.json")
run = runtime["guardedRuns"][0]
assert len(runtime["guardedRuns"]) == 1
assert run["exitCode"] == 1 and not run["completedGuard"]
assert run["focusedEnteredTests"] == run["productReruns"] == 0
raw = (ROOT / run["raw"]).read_bytes()
assert len(raw) == run["rawBytes"] == 2272 and sha(raw) == run["rawSha256"]
assert b"Completed Bun shard" not in raw and b"54 expect() calls" in raw
assert raw.count(b"(pass)") == 16
totals = runtime["totals"] | dict(fixturesAuthored=1, focusedDeclaredTests=3)
save("validation.json", dict(
    baseline=BASE, totals=totals,
    runs=[dict(log="evidence/root-containment-first.raw.log", **run)],
    staticAuthors=["compose", "snapshot", "aggregator", "root-frontier"],
    notes=["One failed shard: existing16 passed/54 expectations, focused0 entered, no completed guard.",
           "Root fixture import locator failure is not a product missing-module bug. No repair, retry or alternate runtime.",
           "The worktree path formal is independent static producer/consumer evidence, not this failed dynamic direction.",
           "The compose item remains a static candidate and entire dynamic direction SKIP."]
))

manifest_names = ["root-source-manifest.json", "root-frontier-source-manifest.json",
                  "compose-source-manifest.json", "snapshot-source-manifest.json",
                  "aggregator-source-manifest.json", "review-aggregator-root-source-manifest.json",
                  "review-aggregator-independent-source-manifest.json"]
source_checks, sources = [], {"CODESHELL.md", "AGENTS.md", "package.json", "bun.lock", "tsconfig.json"}
for name in manifest_names:
    for row in rows(read(name), "files", "sources"):
        path = row["path"]
        frozen = git("show", BASE + ":" + path)
        expected = row.get("sha256") or row.get("firstFilesystemSha256")
        assert expected == sha(frozen), (name, path)
        ranges = row.get("selectedLineRanges") or row.get("ranges") or []
        assert all(1 <= start <= end <= len(frozen.decode().splitlines()) for start, end in ranges), (name, path)
        source_checks.append(dict(manifest=name, path=path, sha256=expected,
                                  coverage=row.get("coverage", row.get("readScope")),
                                  rootIndependentlyBoundFrozenBlob=True))
        sources.add(path)
prep_checks = []
for row in read("compose-prep/inventory.json")["files"]:
    path = row["path"]
    expected = row["firstFilesystemSha256"]
    assert sha(git("show", BASE + ":" + path)) == expected, path
    prep_checks.append(dict(path=path, sha256=expected, coverage="hash-only prep inventory recheck; no new semantic reading"))
    sources.add(path)
main_head = git("rev-parse", "main").decode().strip()
manifest = []
for path in sorted(sources):
    frozen = git("show", BASE + ":" + path)
    current = (ROOT / path).read_bytes()
    main = git("show", main_head + ":" + path)
    assert current == main, path
    manifest.append(dict(path=path, bytes=len(frozen), sha256=sha(frozen),
                         currentBytes=len(current), currentSha256=sha(current),
                         mainBytes=len(main), mainSha256=sha(main),
                         currentWorkingTreeMatchesFrozenBlob=current == frozen,
                         mainMatchesFrozenBlob=main == frozen,
                         currentWorkingTreeMatchesMain=True))
changed = [row["path"] for row in manifest if not row["mainMatchesFrozenBlob"]]
assert changed == read("main-source-review.json")["changedSelectedSourcePaths"]
save("source-manifest.json", dict(baseline=BASE, mainHead=main_head, files=manifest,
     workerSourceChecks=source_checks, priorPrepHashOnlyChecks=prep_checks,
     changedFromFrozenPaths=changed,
     note="Frozen author bytes, current and main kept separate. Root Git binding is not an author execution or full-source semantic coverage claim."))

receipt_names = ["root-artifact-receipt.json", "root-frontier-artifact-receipt.json",
                 "compose-author-receipt.json", "snapshot-author-receipt.json", "aggregator-artifact-receipt.json"]
artifacts = []
for name in receipt_names + ["compose-prep-copy-receipt.json"]:
    for row in read(name)["files"]:
        path = row.get("destination", row.get("path"))
        target = ROOT / path if path.startswith("docs/") else OUT / path
        content = target.read_bytes()
        assert len(content) == row["bytes"] and sha(content) == row["sha256"], (name, path)
        if "source" in row:
            assert Path(row["source"]).read_bytes() == content, row["source"]
        artifacts.append(dict(receipt=name, path=str(target.relative_to(ROOT)),
                              bytes=len(content), sha256=sha(content)))
save("worker-integrity.json", dict(baseline=BASE, artifactChecks=artifacts,
     sourceCheckCount=len(source_checks), prepHashOnlyCheckCount=len(prep_checks),
     authorArtifactCount=len(artifacts) - 4, prepCopyCount=4, productTestsRerun=False))
save("addressed-sources.json", dict(baseline=BASE, count=0, sourceChanges=[],
     sourceMetadataChanges=changed, runtimeRetested=False,
     note="Audit only. Concurrent source changes are not a product fix or runtime acceptance by this task."))
index = []
for path in sorted(OUT.rglob("*")):
    if path.is_file() and path.name != "evidence-index.json":
        content = path.read_bytes()
        index.append(dict(path=str(path.relative_to(OUT)), bytes=len(content), sha256=sha(content)))
save("evidence-index.json", dict(baseline=BASE, algorithm="sha256", files=index,
     note="Self excluded; one failed first raw log retained verbatim. Metadata diagnostics are separately labeled excerpts."))
print(json.dumps(dict(findings=1, candidates=1, related=1, sourcePins=len(manifest),
     sourceChecks=len(source_checks), prepHashOnlyChecks=len(prep_checks),
     authorArtifacts=len(artifacts) - 4, prepCopies=4, indexedFiles=len(index))))
