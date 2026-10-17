"""Metadata only: source/evidence hashing and first-run log classification; never runs tests."""
import hashlib
import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[3]
HERE = pathlib.Path(__file__).parent
BASE = "7927a7c8b80b4aec710dee1f6d831ad1982bb466"
PREFIX = "docs/audit-2026-10-17-round13/"
SOURCES = {
    "CODESHELL.md": "entire instruction file",
    "packages/desktop/src/renderer/shell/sessionContentSearch.ts": "entire file; production pure functions executed",
    "packages/desktop/src/renderer/shell/sessionContentSearch.test.ts": "entire file; 11 existing tests executed once",
    "packages/desktop/src/renderer/modelSelection.ts": "entire file; production callback helper executed",
    "packages/desktop/src/renderer/modelSelection.test.ts": "entire file; 2 existing tests executed once",
    "packages/desktop/src/renderer/shell/searchFocus.ts": "entire file; static only, no DOM/runtime test",
    "packages/desktop/src/renderer/shell/SearchDialog.tsx": "entire file; focus wiring static only",
    "packages/desktop/src/renderer/shell/SearchBar.tsx": "entire file; focus wiring static only",
    "packages/desktop/src/renderer/shell/SessionSearchModal.tsx": "entire file; query producer/error consumer static only",
    "packages/desktop/src/renderer/shell/useSessionContentSearch.ts": "entire file; request producer and invalidation static only",
    "packages/desktop/src/renderer/chat/modelPickerPresentation.ts": "entire file; static only, historical failed direction remains SKIP",
    "packages/desktop/src/renderer/chat/modelPickerPresentation.test.tsx": "entire file; static only, no React/DOM test run",
    "packages/desktop/src/renderer/transcripts.ts": "selected import/header, makeSessionId, archived/import/binding producer sections; content-search module dependency loaded without real storage",
    "packages/desktop/src/shared/session-catalog.ts": "entire file; local/engine identity contract static only",
    "packages/desktop/src/renderer/streamRouting.ts": "lines 1-90; normal identity fallback contract static only",
    "packages/desktop/src/renderer/App.tsx": "lines 1678-1706 and targeted call-site search; static only",
    "packages/desktop/src/preload/index.ts": "lines 1046-1047 and target search references; static only",
    "packages/desktop/src/main/index.ts": "lines 5017-5035 and target search references; static only",
}
def sha(data):
    return hashlib.sha256(data).hexdigest()
def write(name, value):
    (HERE/name).write_text(json.dumps(value, ensure_ascii=False, indent=2)+"\n")
def entry(path):
    data = path.read_bytes()
    return {"path": path.relative_to(ROOT).as_posix(), "bytes": len(data), "sha256": sha(data)}

sources = []
for path, scope in SOURCES.items():
    frozen = subprocess.check_output(["git", "show", f"{BASE}:{path}"], cwd=ROOT)
    blob = subprocess.check_output(["git", "rev-parse", f"{BASE}:{path}"], cwd=ROOT, text=True).strip()
    current = (ROOT/path).read_bytes()
    sources.append({"path": path, "frozenGitBlob": blob, "frozenSha256": sha(frozen), "sha256": sha(current), "frozenBytes": len(frozen), "currentEqualsFrozen": current == frozen, "inspectionScope": scope})
assert all(item["currentEqualsFrozen"] for item in sources)
write("search-source-manifest.json", {"frozenSource": BASE, "files": sources, "scope": "Hashing complete files does not imply full-file behavioural coverage; inspectionScope distinguishes executed pure functions from static consumers and skipped grouping."})

candidate = {
    "id": "SEARCH-R13-C1",
    "status": "candidate",
    "title": "Content-query readiness differs from Main's trimmed 2-128 length gate",
    "file": "packages/desktop/src/renderer/shell/sessionContentSearch.ts",
    "line": 29,
    "sourceBase": BASE,
    "trigger": "Ordinary content input with one non-space character plus trailing space, or a 129-character term",
    "actual": "Real pure parser returns ready:true; Main source trim/length contract rejects these terms",
    "controls": ["one character without trailing whitespace is not ready", "two characters plus trailing whitespace are ready with trimmed length 2", "128-character term is ready", "title query remains outside content mode"],
    "evidenceLevel": "Actual production pure parser observations; UI/hook/preload/Main connection inspected as source only",
    "limitations": "No actual Main handler, IPC, debounce or UI execution; frontend contract explicitly documents only minimum length, so no formal severity or observed UI failure claimed",
    "report": PREFIX+"search.md",
    "fixture": PREFIX+"evidence/search-pure-contracts.test.ts",
    "rawLog": PREFIX+"evidence/search-pure-contracts.first.log",
}
write("search-findings.json", [])
write("search-candidates.json", [candidate])

receipt = json.loads((HERE/"search-pure-contracts.first.receipt.json").read_text())
raw = (HERE/"search-pure-contracts.first.log").read_text()
summary = re.search(r"Completed Bun shard: (\d+) tests, (\d+) skipped; (\d+) failures[.]", raw)
expect_count = re.search(r"(\d+) expect\(\) calls", raw)
assert receipt["exitCode"] == 0 and summary and expect_count
tests, skips, failures = map(int, summary.groups())
assert (tests, skips, failures, int(expect_count.group(1))) == (18, 0, 0, 32)
for item in [receipt["rawCombinedStdoutStderr"], receipt["exitFile"], *receipt["fixtures"]]:
    assert entry(ROOT/item["path"]) == item
run = {"name": "search-pure-contracts", "kind": "13 existing pure tests plus 5 focused observations and controls", "attempt": 1, "command": receipt["command"], "sourceBase": BASE, "fixtures": receipt["fixtures"], "rawCombinedStdoutStderr": receipt["rawCombinedStdoutStderr"]["path"], "rawLogSha256": receipt["rawCombinedStdoutStderr"]["sha256"], "exitFile": receipt["exitFile"]["path"], "exitFileSha256": receipt["exitFile"]["sha256"], "exitCode": 0, "tests": tests, "expectCalls": int(expect_count.group(1)), "failures": failures, "skipped": skips, "guardedCompletionPresent": True, "clean": True}
write("search-validation.json", {"sourceBase": BASE, "confirmedFindings": [], "candidateIds": [candidate["id"]], "runs": [run], "totals": {"cleanFirstShards": 1, "tests": 18, "expectCalls": 32, "newFocusedTests": 5, "baselineTests": 13, "failures": 0, "skipped": 0, "failedShards": 0, "retries": 0}, "skippedDirections": [{"direction": "modelPickerPresentation grouping/runtime", "reason": "historical round6 DD6-04 failed fixture; no recovery or alternate validation", "historicalReport": "docs/audit-2026-10-17-round6/desktop-display.md"}], "firstRunPolicy": receipt["policy"], "sourceManifest": PREFIX+"evidence/search-source-manifest.json", "dedup": PREFIX+"evidence/search-dedup.json", "scope": "Production pure parsing and memory callback functions only; no UI/DOM/Electron/native/PTY/network/model/user data/settings persistence/real jobs or product Git process"})

artifacts = [ROOT/PREFIX/"search.md", *sorted(HERE.glob("search-*"))]
artifacts = [path for path in artifacts if path.is_file() and path.name != "search-artifact-receipt.json"]
write("search-artifact-receipt.json", {"sourceBase": BASE, "scope": "Final worker report and search-* artifacts except this self-referential receipt; metadata only, no test rerun", "files": [entry(path) for path in artifacts]})
print(json.dumps({"sources": len(sources), "artifacts": len(artifacts), "tests": tests, "expectCalls": int(expect_count.group(1)), "confirmed": 0, "candidates": 1}))
