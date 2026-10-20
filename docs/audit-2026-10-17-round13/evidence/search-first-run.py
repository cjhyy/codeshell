"""Execute this exact guarded shard once, save combined output and exit before inspection."""
import hashlib
import json
import pathlib
import subprocess
import time

ROOT = pathlib.Path(__file__).resolve().parents[3]
HERE = pathlib.Path(__file__).parent
LOG = HERE / "search-pure-contracts.first.log"
EXIT = HERE / "search-pure-contracts.first.exit.txt"
RECEIPT = HERE / "search-pure-contracts.first.receipt.json"
FILES = [
    "packages/desktop/src/renderer/shell/sessionContentSearch.test.ts",
    "packages/desktop/src/renderer/modelSelection.test.ts",
    "docs/audit-2026-10-17-round13/evidence/search-pure-contracts.test.ts",
]
command = ["node", "scripts/run-bun-test-shard.mjs", "--timeout", "30000", *FILES]
if any(p.exists() for p in (LOG, EXIT, RECEIPT)):
    raise SystemExit("Refuse repeat: a first-run artifact already exists")
start = time.time()
with LOG.open("wb") as stream:
    result = subprocess.run(command, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT)
EXIT.write_text(str(result.returncode) + "\n")
def entry(path):
    data = path.read_bytes()
    return {"path": path.relative_to(ROOT).as_posix(), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
receipt = {"sourceBase": "7927a7c8b80b4aec710dee1f6d831ad1982bb466", "attempt": 1, "command": command, "exitCode": result.returncode, "elapsedSeconds": time.time()-start, "rawCombinedStdoutStderr": entry(LOG), "exitFile": entry(EXIT), "fixtures": [entry(ROOT/path) for path in FILES], "policy": "combined raw output and exit file saved before any inspection; any failure stops this direction with zero retries"}
RECEIPT.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"exitCode": result.returncode, "rawLog": LOG.relative_to(ROOT).as_posix(), "exitFile": EXIT.relative_to(ROOT).as_posix(), "receipt": RECEIPT.relative_to(ROOT).as_posix()}))
