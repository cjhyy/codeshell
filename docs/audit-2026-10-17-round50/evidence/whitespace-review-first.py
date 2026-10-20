from pathlib import Path
import json,re
r=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');e=r/'docs/audit-2026-10-17-round50/evidence';a=json.loads((e/'frozen-artifact-whitespace.json').read_text());rows=[];exact={}
for v in a['exactArtifacts']:
 lines=(r/v['path']).read_bytes().splitlines();assert not v['newBlankLineAtEof'];exact[v['path']]=v['trailingLineNumbers']
 for n in v['trailingLineNumbers']:
  raw=lines[n-1];print(v['path'],n,repr(raw));assert re.fullmatch(rb'\s*\d+\s+',raw),raw;rows.append({'path':v['path'],'line':n,'rawUTF8':raw.decode(),'classification':'numbered blank source line in exact frozen author excerpt'})
(e/'root-whitespace-review.json').write_text(json.dumps({'exactTrailingWhitespaceLines':exact,'reviewedLines':rows,'allOtherFilesMustPass':True,'scope':'Preserve only these19 frozen numbered-blank excerpt lines verbatim; no product source or generated metadata whitespace exemptions.'},ensure_ascii=False,indent=2)+'\n')
