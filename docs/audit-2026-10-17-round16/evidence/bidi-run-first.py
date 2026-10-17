"""Capture the only guarded first attempt before inspecting combined output."""
from pathlib import Path
import json,subprocess
ROOT=Path(__file__).resolve().parents[3]
HERE=Path(__file__).resolve().parent
raw=HERE/'bidi-predicate.first.raw.log'
receipt=HERE/'bidi-predicate.first.exit.json'
if raw.exists() or receipt.exists(): raise SystemExit('First evidence exists; refusing rerun')
command=['node','scripts/run-bun-test-shard.mjs','--timeout','30000',str((HERE/'bidi-predicate.test.ts').relative_to(ROOT))]
result=subprocess.run(command,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
raw.write_bytes(result.stdout)
receipt.write_text(json.dumps({'command':command,'cwd':str(ROOT),'exitCode':result.returncode,'rawLog':str(raw.relative_to(ROOT)),'attempts':1,'reruns':0,'actualProductModuleImported':False,'executionScope':'Exact frozen-source hasRTLCharacters predicate; only two TS signature annotations removed; no platform/env reads or bidi-js import.'},indent=2)+'\n')
print(json.dumps({'exitCode':result.returncode,'rawLog':str(raw.relative_to(ROOT)),'exitReceipt':str(receipt.relative_to(ROOT))}))
