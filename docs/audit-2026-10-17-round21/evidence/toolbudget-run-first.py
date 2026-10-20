from pathlib import Path
import datetime,hashlib,json,subprocess

root=Path.cwd();out=root/'docs/audit-2026-10-17-round21/evidence'
raw=out/'toolbudget-first.raw.log';receipt=out/'toolbudget-first.exit.json'
assert not raw.exists() and not receipt.exists(), 'Never overwrite first-run evidence'
command=['node','scripts/run-bun-test-shard.mjs','--timeout','30000','packages/core/src/context/tool-output-budget.test.ts','docs/audit-2026-10-17-round21/evidence/toolbudget-focused.test.ts']
start=datetime.datetime.now(datetime.timezone.utc).isoformat()
with raw.open('xb') as stream:
 result=subprocess.run(command,cwd=root,stdout=stream,stderr=subprocess.STDOUT)
end=datetime.datetime.now(datetime.timezone.utc).isoformat();data=raw.read_bytes()
obj={'base':'615e4e4dd3a61b1ad132ab4f3683985a0d582386','command':command,'cwd':str(root),'startedAt':start,'endedAt':end,'exitCode':result.returncode,'raw':str(raw.relative_to(root)),'rawSha256':hashlib.sha256(data).hexdigest(),'rawBytes':len(data),'savedBeforeInspection':True,'firstAttempt':True,'reruns':0}
receipt.write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'rawSaved':str(raw.relative_to(root)),'exitSaved':str(receipt.relative_to(root)),'exitCode':result.returncode},ensure_ascii=False))
