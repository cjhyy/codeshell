"""Static source reader only; no imports or execution of product code."""
from pathlib import Path
import hashlib,json,subprocess
from datetime import datetime,timezone
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT=Path('/tmp/codeshell-audit-round38-root-mcp-frontier');OUT.mkdir(exist_ok=True)
SCOPES={
'packages/desktop/src/renderer/settings/mcpSettingsPatch.ts':[(1,62)],
'packages/desktop/src/renderer/settings/McpSection.tsx':[(21,53),(390,448),(1092,1135),(1357,1405),(1756,1769),(1870,1893)],
}
def sha(b):return hashlib.sha256(b).hexdigest()
def write(name,obj):(OUT/name).write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n')
pins=[]
for path,ranges in SCOPES.items():
 b=(ROOT/path).read_bytes();lines=b.decode().splitlines();assert all(1<=a<=z<=len(lines) for a,z in ranges)
 pins.append(dict(path=path,bytes=len(b),sha256=sha(b),lineCount=len(lines),selectedLineRanges=ranges,coverage='full' if ranges==[(1,len(lines))] else 'selected',semanticReadLines=sum(z-a+1 for a,z in ranges),initialSemanticReadSha256=None,readTiming='Hash before this direct read; peer precise excerpts already seen, so no backdated first-semantic pin.'))
write('initial-pins.json',dict(atUTC=datetime.now(timezone.utc).isoformat(),files=pins,baseline=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT).decode().strip(),productRuns=0))
with (OUT/'source-excerpts.txt').open('w') as out:
 for row in pins:
  lines=(ROOT/row['path']).read_text().splitlines()
  for a,z in row['selectedLineRanges']:
   header=f"{row['path']}:{a}-{z}";print(header);out.write(header+'\n')
   for n in range(a,z+1):
    line=f'{n}: {lines[n-1]}';print(line);out.write(line+'\n')
write('source-manifest.json',dict(files=pins,productRuns=0,testDeclarations=0,limitations=['Direct selected source only; no actual form, helper, language fixture, MCP, process, network, or settings operations.','Metadata source display errors are not product attempts.']))
