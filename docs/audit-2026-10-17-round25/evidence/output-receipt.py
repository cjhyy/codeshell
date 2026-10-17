from pathlib import Path
import hashlib
import json
import re
import subprocess

base = "8b9677c78d150abe9681a2f65ab8e55b1288be4b"
root = Path(".")
batch = root / "docs/audit-2026-10-17-round25"
evidence = batch / "evidence"
report = batch / "output-clean.md"
receipt = evidence / "output-artifact-receipt.json"
check_path = evidence / "output-metadata-check.json"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


# Metadata only. This helper never imports/invokes product code or the test runner.
# Establish the generated check path before checking the report's local links.
if not check_path.exists():
    save(check_path, {"state": "metadata generation path established"})

source = json.loads((evidence / "output-source-manifest.json").read_text())
source_checks = []
for row in source["files"]:
    p = root / row["path"]
    current = p.read_bytes()
    frozen = subprocess.check_output(["git", "show", base + ":" + row["path"]])
    blob = subprocess.check_output(["git", "rev-parse", base + ":" + row["path"]], text=True).strip()
    assert sha(current) == row["sha256"] == row["currentSha256"] == row["frozenSha256"] == sha(frozen)
    assert blob == row["frozenGitBlob"]
    count = len(current.splitlines())
    assert count == row["lineCount"]
    assert all(1 <= start <= end <= count for start, end in row["selectedLineRanges"])
    source_checks.append({"path": row["path"], "sha256": sha(current), "frozenGitBlob": blob, "coverage": row["coverage"], "matchesFrozen": True})
assert len(source_checks) == 7
assert source["productContractReadLines"] == 550
assert source["prepHashRecheckCount"] == 11
for row in source["prepHashRechecks"]:
    current = (root / row["path"]).read_bytes()
    assert sha(current) == row["sha256"]

run = json.loads((evidence / "output-first.exit.json").read_text())
raw = (root / run["raw"]).read_bytes()
assert run["exitCode"] == 0 and run["attempt"] == 1 and run["productReruns"] == 0
assert len(raw) == run["rawBytes"] == 2477
assert sha(raw) == run["rawSha256"] == "3756561600256bdbd45f529d4a6b0d0936c1e6fb49710c36a79a08e6d02c80d0"
assert b"Completed Bun shard: 13 tests, 0 skipped; 0 failures." in raw
assert re.search(rb"\b13 pass\b", raw) and re.search(rb"\b23 expect\(\) calls\b", raw)
assert len([line for line in raw.splitlines() if line.startswith(b'{"characterization":')]) == 4
fixture = (evidence / "output-crlf.test.ts").read_bytes()
preflight = json.loads((evidence / "output-preflight.json").read_text())
assert sha(fixture) == preflight["focusedFixtureSha256"]
assert preflight["leafRuntimeImports"] == [] and preflight["focusedCases"] == 6

findings = json.loads((evidence / "output-findings.json").read_text())
candidates = json.loads((evidence / "output-candidates.json").read_text())
related = json.loads((evidence / "output-related.json").read_text())
assert len(findings) == 1 and findings[0]["id"] == "OUTPUT-R25-01" and findings[0]["priority"] == "P2"
assert candidates == related == []
links = []
for link in re.findall(r"\[[^\]]+\]\(([^)]+)\)", report.read_text()):
    target, sep, tail = link.rpartition(":")
    line = int(tail) if sep and tail.isdigit() else None
    path_text = target if line is not None else link
    local = report.parent / path_text
    assert local.is_file(), link
    if line is not None:
        assert 1 <= line <= len(local.read_bytes().splitlines()), link
    links.append({"link": link, "exists": True, "line": line})

foreign_review_names = {"output-static-crosscheck.md", "output-static-source-manifest.json"}
owned = [report] + sorted(p for p in evidence.glob("output-*") if p.is_file() and p != receipt and p.name not in foreign_review_names)
json_paths = [p for p in owned if p.suffix == ".json"]
for path in json_paths:
    json.loads(path.read_text())
check = {"base": base, "kind": "metadata-only; no product/test rerun", "sourcePinCount": 7,
         "activeProductContractPinCount": 6, "instructionPinCount": 1,
         "productContractReadLines": 550, "sourceChecks": source_checks,
         "prepHashOnlyRecheckCount": 11, "rawBytes": len(raw), "rawSha256": sha(raw),
         "firstRunExitCode": run["exitCode"], "guardCompleted": True,
         "pass": 13, "expect": 23, "fail": 0, "skipped": 0,
         "existingTests": 7, "focusedTests": 6,
         "formalCount": 1, "candidateCount": 0, "relatedCount": 0,
         "localLinkCount": len(links), "localLinks": links,
         "authorArtifactCountWithoutReceipt": len(owned),
         "ownedJSONParseCountWithoutReceipt": len(json_paths),
         "metadataOnlyFailureCount": 1, "productFailureCount": 0,
         "productReruns": 0, "productChanges": False, "gitWrites": False}
save(check_path, check)
artifacts = [{"path": str(path), "bytes": path.stat().st_size, "sha256": sha(path.read_bytes())} for path in owned]
save(receipt, {"base": base, "report": str(report), "formalCount": 1,
               "candidateCount": 0, "relatedCount": 0,
               "artifactCount": len(artifacts), "files": artifacts,
               "receiptExcludesItself": True, "prepExcludedFromAuthorReceipt": True,
               "foreignReviewArtifactsExcluded": sorted(foreign_review_names),
               "rawLogs": [run["raw"]], "productChanges": False, "gitWrites": False})
print(json.dumps({"sourcePins": 7, "authorArtifacts": len(artifacts), "receiptAdditional": 1,
                  "localLinks": len(links), "rawSha256": sha(raw), "productReruns": 0}, ensure_ascii=False))
