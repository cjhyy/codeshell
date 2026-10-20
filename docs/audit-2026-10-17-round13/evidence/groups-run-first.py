#!/usr/bin/env python3
"""Capture the first combined guarded shard bytes and exit before inspection."""
import datetime,hashlib,json,pathlib,subprocess,sys
root=pathlib.Path(__file__).resolve().parents[3]
label=sys.argv[1]; files=sys.argv[2:]
raw=pathlib.Path(__file__).with_name(label+'.first.raw.log')
receipt=pathlib.Path(__file__).with_name(label+'.first.exit.json')
if raw.exists() or receipt.exists(): raise SystemExit('Refusing an existing first-run destination')
command=['node','scripts/run-bun-test-shard.mjs','--timeout','30000',*files]
started=datetime.datetime.now(datetime.timezone.utc).isoformat()
r=subprocess.run(command,cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
raw.write_bytes(r.stdout)
receipt.write_text(json.dumps({'command':command,'cwd':str(root),'startedAt':started,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exitCode':r.returncode,'rawLog':str(raw.relative_to(root)),'rawBytes':len(r.stdout),'rawSha256':hashlib.sha256(r.stdout).hexdigest(),'policy':'FIRST combined stdout/stderr saved before inspection; no retry, fixture repair or alternate validation after any failure'},indent=2)+'\n')
print(json.dumps({'receipt':str(receipt.relative_to(root)),'exitCode':r.returncode,'bytes':len(r.stdout)}))
