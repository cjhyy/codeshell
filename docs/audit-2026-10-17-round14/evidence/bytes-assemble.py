"""Metadata only. Do not execute or retry product tests."""
import hashlib
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[3]
BATCH = ROOT / "docs/audit-2026-10-17-round14"
EVIDENCE = BATCH / "evidence"
BASE = "badc2262a90966f6f903977b849adf1f22b55e9f"

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def write(name, value):
    (EVIDENCE / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")

paths = [
    "CODESHELL.md",
    "scripts/run-bun-test-shard.mjs",
    "packages/server/src/image-byte-probe.ts",
    "packages/server/src/attachment-service.ts",
    "packages/server/src/attachment-service.test.ts",
    "packages/server/src/remote-relay/byte-stream.ts",
    "packages/server/src/remote-relay/protocol.ts",
    "packages/server/src/mobile-remote/codex-parse.ts",
    "packages/server/src/mobile-remote/codex-parse.test.ts",
    "docs/device-relay.md",
]
files = []
for relative in paths:
    frozen = subprocess.check_output(["git", "show", f"{BASE}:{relative}"], cwd=ROOT)
    current = (ROOT / relative).read_bytes()
    files.append({"path": relative, "frozenSha256": digest(frozen), "sha256": digest(frozen), "frozenBytes": len(frozen), "currentEqualsFrozen": current == frozen})
write("bytes-source-manifest.json", {"frozenSource": BASE, "files": files, "scope": "Selected read source plus actual pure probe runtime. Manifest does not imply execution of service/stream/Codex runtime; failed guessed upload-store path excluded per navigation skip."})
write("bytes-findings.json", {"sourceBase": BASE, "findings": [], "reason": "No new ordinary-producer defect with all requested contract/runtime/consumer evidence."})
write("bytes-candidates.json", {"sourceBase": BASE, "candidates": [{
    "id": "BYTES-R14-C1", "title": "JPEG SOF3 识别与全局 DQT 前提可能不一致", "sourceBase": BASE,
    "file": "packages/server/src/image-byte-probe.ts", "line": 119,
    "report": "docs/audit-2026-10-17-round14/bytes.md",
    "evidenceLevel": "Real pure probe rejection of self-built SOF3 marker sequence; format source read; candidate only",
    "reason": "Recognized SOF set includes lossless SOF3, but EOI requires DQT independently of frame coding mode.",
    "limits": "No independent pixel-decoder proof of sample validity or normal downstream lossless JPEG support/contract; no stage/upload/file/native/runtime/network/UI exercised. No severity or confirmed bug claim."
}]})
write("bytes-external-sources.json", {"capturedUtcDate": "2026-10-17", "mechanism": "web search/open/find; brief tool-response metadata transcription, not a downloaded PDF or full raw fetch", "sources": [{
    "url": "https://www.w3.org/Graphics/JPEG/itu-t81.pdf", "title": "CCITT Rec. T.81 (1992 E) / ISO/IEC 10918-1 standard text hosted by W3C",
    "inspected": "PDF extracted text: B.1.1.3 Table B.1 SOF3; B.2.4.1 Table B.4 lossless column; B.2.4.2 DHT table syntax",
    "toolObservation": "open returned 186 pages, 6984 extracted lines; find returned SOF3 at extracted lines 1692-1700 and Table B.4 lossless Undefined fields at lines 2114-2125",
    "scope": "Format contract only; not a product codec support promise, decoder run, fixture validity certificate or image download."
}]})
exit_path = EVIDENCE / "bytes-image-probe.first.exit.json"
receipt = json.loads(exit_path.read_text())
raw = (ROOT / receipt["rawLog"]).read_bytes()
assert digest(raw) == receipt["rawSha256"]
fixture = (ROOT / receipt["fixture"]).read_bytes()
assert digest(fixture) == receipt["fixtureSha256"]
assert receipt["exitCode"] == 0
assert b"Completed Bun shard: 11 tests, 0 skipped; 0 failures." in raw
assert b"31 expect() calls" in raw
run = dict(receipt)
run.update({"name": "bytes-image-probe", "attempt": 1, "sourceBase": BASE, "rawBytes": len(raw), "exitFile": exit_path.relative_to(ROOT).as_posix(), "exitFileSha256": digest(exit_path.read_bytes()), "passedTests": 11, "tests": 11, "expectCalls": 31, "failures": 0, "errors": 0, "skipped": 0, "guardedCompletionPresent": True, "clean": True, "kind": "new focused ordinary-byte controls plus one candidate characterization"})
write("bytes-validation.json", {"sourceBase": BASE, "confirmedFindings": [], "candidateIds": ["BYTES-R14-C1"], "runs": [run], "totals": {"cleanFirstShards": 1, "tests": 11, "expectCalls": 31, "baselineTests": 0, "newFocusedTests": 11, "cleanFailures": 0, "skipped": 0, "failedShards": 0, "retries": 0}, "firstRunPolicy": "FIRST combined bytes and exit saved before viewing; no product retries or alternate route; metadata assembler executes no tests.", "scope": "Direct probeImageBytes/sanitizeImageBytes, entirely self-owned memory. All attachment-service/relay/Codex producer/consumer checks source-only. No end-to-end claim.", "sourceManifest": "docs/audit-2026-10-17-round14/evidence/bytes-source-manifest.json", "dedup": ["docs/audit-2026-10-17-round14/evidence/bytes-dedup.json"], "skipNote": "docs/audit-2026-10-17-round14/evidence/bytes-navigation-skip.md"})
artifacts = []
for path in sorted([BATCH / "bytes.md", *EVIDENCE.glob("bytes-*")]):
    if not path.is_file() or path.name == "bytes-artifact-receipt.json":
        continue
    data = path.read_bytes()
    artifacts.append({"path": path.relative_to(ROOT).as_posix(), "bytes": len(data), "sha256": digest(data)})
write("bytes-artifact-receipt.json", {"sourceBase": BASE, "artifacts": artifacts, "selfExcluded": True, "policy": "Metadata only; no product test/fixture rerun."})
print(json.dumps({"sources": len(files), "artifacts": len(artifacts), "currentSourcesEqualFrozen": all(item["currentEqualsFrozen"] for item in files)}))
