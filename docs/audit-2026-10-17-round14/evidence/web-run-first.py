from pathlib import Path
import json,subprocess,sys,datetime,hashlib
root=Path(__file__).resolve().parents[3]
evidence=Path(__file__).resolve().parent
label=sys.argv[1]
files=sys.argv[2:]
raw=evidence/f'web-{label}.first.raw.log'
receipt=evidence/f'web-{label}.first.exit.json'
if raw.exists() or receipt.exists():raise SystemExit('Refusing to replace first execution evidence')
command=['node','scripts/run-bun-test-shard.mjs','--timeout','30000',*files]
started=datetime.datetime.now(datetime.timezone.utc).isoformat()
result=subprocess.run(command,cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
raw.write_bytes(result.stdout)
receipt.write_text(json.dumps({'command':command,'cwd':str(root),'startedAt':started,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exitCode':result.returncode,'rawLog':str(raw.relative_to(root)),'rawSha256':hashlib.sha256(result.stdout).hexdigest(),'capture':'combined stdout/stderr saved before inspecting','files':files},indent=2)+'\n')
print(json.dumps({'receipt':str(receipt.relative_to(root)),'exitCode':result.returncode}))
