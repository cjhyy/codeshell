"""Assemble metadata only. Never starts product code, tests or a browser."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
ROUND = ROOT / "docs/audit-2026-10-17-round10"
EVIDENCE = ROUND / "evidence"
BASE = "6966dc0f98d21dbc2ecced6cdd6467d17b81bc39"

def write(name, value):
    (EVIDENCE / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")

def sha(data):
    return hashlib.sha256(data).hexdigest()

def artifact(path):
    data = path.read_bytes()
    return {"path": str(path.relative_to(ROOT)), "bytes": len(data), "sha256": sha(data)}

source_paths = [
    "CODESHELL.md",
    "packages/browser-devtools/README.md",
    "packages/browser-devtools/package.json",
    "packages/browser-devtools/src/contracts.ts",
    "packages/browser-devtools/src/index.ts",
    "packages/browser-devtools/src/inspector.ts",
    "packages/browser-devtools/src/inspector.test.ts",
    "packages/desktop/src/browser-library/browser-inspector.ts",
    "packages/desktop/src/browser-library/puppeteer-browser-driver.ts",
    "packages/desktop/src/browser-library/browser-inspector.integration.test.ts",
    "docs/todo/browser-automation-library-reuse.md",
    "docs/audit-2026-10-17-round3/cdp-browser.md",
    "docs/audit-2026-10-17-round3/evidence/cdp-diagnostics-projection.test.ts",
]
sources = []
for path in source_paths:
    frozen = subprocess.check_output(["git", "show", f"{BASE}:{path}"], cwd=ROOT)
    current = (ROOT / path).read_bytes()
    sources.append({"path": path, "frozenSha256": sha(frozen),
                    "currentSha256": sha(current), "currentEqualsFrozen": current == frozen})
write("diagnostics-source-manifest.json", {"sourceBase": BASE, "files": sources,
      "coverageLimit": "Full browser-devtools src, metadata and tests; Desktop caller excerpt and integration test read only."})

findings = [{
    "id": "DIAG-R10-01", "priority": "P3",
    "title": "DOM bounded traversal eagerly enumerates complete child collections before queue cap",
    "file": "packages/browser-devtools/src/inspector.ts", "line": 167,
    "additionalLines": [168, 171, 172],
    "contract": ["packages/browser-devtools/README.md:43-44",
                 "docs/todo/browser-automation-library-reuse.md:81",
                 "packages/browser-devtools/src/inspector.ts:132-134"],
    "observed": "Actual callback in Node VM fully enumerated 20000 ordinary light children and 20000 open-shadow children independently at maxEntries=1; output stayed one node/truncated=true.",
    "controls": "Four-child complete summary, Network mixed response/failure metadata, Performance count/timing projection, existing inspector baseline.",
    "evidenceLevel": "Actual production inspector callback + fake iterable collection; real HTMLCollection enumeration and Desktop consumers source-only.",
    "limitations": "No real browser, CSS/layout engine, measured browser latency or memory peak, timeout/hang, complete tool-chain or platform acceptance.",
    "dedup": "CDP-R3-03 visibility hidden pruning has a different cause and is excluded; no eager collection cap finding found in parsed historical MD/JSON.",
    "report": "docs/audit-2026-10-17-round10/diagnostics.md",
    "fixture": "docs/audit-2026-10-17-round10/evidence/diagnostics-bounded-projection.test.ts",
}]
write("diagnostics-findings.json", {"sourceBase": BASE, "findings": findings})
write("diagnostics-candidates.json", {"sourceBase": BASE, "candidates": [],
      "excluded": [
          {"direction": "visibility:hidden ancestor pruning", "reason": "Already CDP-R3-03; not revalidated or counted new."},
          {"direction": "Performance summary is not globally chronological/recent", "reason": "No contract promises recent N or a global sort; no finding."},
      ]})

write("diagnostics-static-lookup-failures.json", {
    "sourceBase": BASE, "kind": "Labeled tool-response transcription excerpts; not raw Bun logs",
    "failures": [
        {"command": "rg -n 'BrowserInspect|createBrowserInspector|mode: \"performance\"|mode: \"dom\"' packages/core/src/browser packages/desktop/src/browser-library docs --glob '*.md' --glob '*.ts' --glob '!audit-2026-10-17-round10/**' --max-count 20",
         "exitCode": 2,
         "toolOutputExcerpt": "rg: packages/core/src/browser: No such file or directory (os error 2)\n",
         "scope": "The same response also had valid Desktop/docs matches, not reproduced here. Guessed Core path skipped; no correction or rerun."},
        {"command": "cat docs/audit-2026-10-17-round9/evidence/attachments-findings.json docs/audit-2026-10-17-round9/evidence/attachments-validation.json",
         "exitCode": 1,
         "toolOutputExcerpt": "cat: docs/audit-2026-10-17-round9/evidence/attachments-findings.json: No such file or directory\n",
         "scope": "The same response also returned existing attachments-validation.json. Guessed prior findings file skipped; no correction or rerun."},
    ],
    "productTestsAffected": False,
})

runs = []
for name, kind, fixture_paths in [
    ("diagnostics-bounded-projection", "focused observations and normal controls", [str((EVIDENCE / "diagnostics-bounded-projection.test.ts").relative_to(ROOT))]),
    ("diagnostics-existing-inspector", "existing targeted unit baseline", ["packages/browser-devtools/src/inspector.test.ts"]),
]:
    log = EVIDENCE / f"{name}.first.log"
    exit_file = EVIDENCE / f"{name}.first.exit.json"
    receipt = json.loads(exit_file.read_text())
    text = log.read_text()
    completed = re.search(r"Completed Bun shard: (\d+) tests, (\d+) skipped; (\d+) failures\.", text)
    expect = re.search(r"(\d+) expect\(\) calls", text)
    assert completed and expect and receipt["exitCode"] == 0
    tests, skipped, failures = map(int, completed.groups())
    runs.append({"name": name, "command": receipt["command"], "sourceBase": BASE,
                 "attempt": 1, "kind": kind, "tests": tests, "expectCalls": int(expect.group(1)),
                 "skipped": skipped, "failures": failures, "exitCode": receipt["exitCode"],
                 "guardedCompletionPresent": True,
                 "fixtures": [artifact(ROOT / path) for path in fixture_paths],
                 "rawCombinedStdoutStderr": str(log.relative_to(ROOT)), "rawLogSha256": sha(log.read_bytes()),
                 "exitFile": str(exit_file.relative_to(ROOT)), "exitFileSha256": sha(exit_file.read_bytes())})
write("diagnostics-validation.json", {
    "sourceBase": BASE, "confirmedFindings": findings, "runs": runs,
    "totals": {"cleanFirstShards": len(runs), "tests": sum(r["tests"] for r in runs),
               "newFocusedTests": 5, "baselineTests": 5,
               "expectCalls": sum(r["expectCalls"] for r in runs),
               "failures": sum(r["failures"] for r in runs), "skipped": sum(r["skipped"] for r in runs),
               "failedShards": 0, "retries": 0},
    "firstRunPolicy": "Combined raw stdout/stderr and exit receipts were saved before inspection. No failed shard, repairs or reruns.",
    "staticLookupFailures": "docs/audit-2026-10-17-round10/evidence/diagnostics-static-lookup-failures.json",
    "scope": "Actual inspector callback through fake injected page and Node VM; no browser/network/CDP/native/tool process, user data or models. Desktop consumer read only.",
    "sourceManifest": "docs/audit-2026-10-17-round10/evidence/diagnostics-source-manifest.json",
})
paths = [ROUND / "diagnostics.md"] + sorted(EVIDENCE.glob("diagnostics-*"))
write("diagnostics-artifacts.json", {"sourceBase": BASE,
      "artifacts": [artifact(path) for path in paths if path.is_file() and path.name != "diagnostics-artifacts.json"],
      "selfHashExcluded": True})
print(json.dumps({"confirmed": len(findings), "sources": len(sources), "tests": sum(r["tests"] for r in runs),
                  "expectCalls": sum(r["expectCalls"] for r in runs)}, ensure_ascii=False))
