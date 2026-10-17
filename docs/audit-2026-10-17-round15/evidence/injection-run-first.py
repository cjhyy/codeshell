"""Capture each guarded first run before inspection; never overwrite evidence."""
from pathlib import Path
import json
import subprocess
import sys
ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
GROUPS = {
    "cache-queue": ["packages/core/src/engine/injected-context-cache.test.ts", "packages/core/src/engine/steer-queue.test.ts", str((HERE / "injection-cache-queue.test.ts").relative_to(ROOT))],
    "image-grammar": ["tests/parse-task.test.ts", str((HERE / "injection-image-grammar.test.ts").relative_to(ROOT))],
}
name = sys.argv[1]
raw = HERE / f"injection-{name}.first.raw.log"
receipt = HERE / f"injection-{name}.first.exit.json"
if raw.exists() or receipt.exists():
    raise SystemExit("First evidence already exists; refusing rerun")
command = ["node", "scripts/run-bun-test-shard.mjs", "--timeout", "30000", *GROUPS[name]]
result = subprocess.run(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
raw.write_bytes(result.stdout)
receipt.write_text(json.dumps(dict(command=command, cwd=str(ROOT), exitCode=result.returncode, rawLog=str(raw.relative_to(ROOT)), attempts=1, reruns=0), indent=2)+"\n")
print(json.dumps(dict(exitCode=result.returncode, rawLog=str(raw.relative_to(ROOT)), exitReceipt=str(receipt.relative_to(ROOT)))))
