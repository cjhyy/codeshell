from pathlib import Path
import json,hashlib
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');D=Path('/tmp/codeshell-audit-round175-settings-flags')
path='packages/core/src/settings/hook-provenance.ts';raw=(R/path).read_bytes();lines=raw.decode().splitlines()
row=dict(path=path,bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest(),totalLines=len(lines),ranges=[[1,len(lines)]],lines=[dict(line=i,text=x) for i,x in enumerate(lines,1)])
(D/'source-excerpts.json').write_text(json.dumps(dict(files=[row]),ensure_ascii=False,indent=2)+'\n')
print(path)
for i,line in enumerate(lines,1):print(f'{i:4}: {line}')
