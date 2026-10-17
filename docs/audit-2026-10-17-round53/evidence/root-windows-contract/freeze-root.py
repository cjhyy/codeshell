from pathlib import Path
from datetime import datetime,timezone
import json,hashlib
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');D=Path('/tmp/codeshell-audit-round114-windows-contract')
def sha(b):return hashlib.sha256(b).hexdigest()
def put(n,j):(D/n).write_text(json.dumps(j,ensure_ascii=False,indent=2)+'\n')
a=json.loads((D/'initial-pins.json').read_text())['files'];a.append(json.loads((D/'release-before-pin.json').read_text()));pins={r['path']:r for r in a};rows=[]
for p,dr in [('README.md',[[15,24]]),('packages/core/src/tool-system/builtin/read.ts',[[1,12],[18,55]]),('.github/workflows/release.yml',[[145,155]])]:
 t=(R/p).read_text().splitlines();rows.append(dict(path=p,displayedLineRanges=dr,excerpts=[dict(start=x,end=z,text='\n'.join(f'{i}: {t[i-1]}' for i in range(x,z+1))) for x,z in dr]))
put('source-excerpts.json',dict(captureAfterActualDisplay=True,files=rows))
x=dict(pins['packages/core/src/tool-system/builtin/read.ts']);x.update(coverage='selected',selectedLineRanges=[[8,8],[27,35],[50,54]],displayedLineRanges=[[1,12],[18,55]],semanticLineCount=15,scope='Native path import + ordinary absolute input schema/rawPath normalization boundary only; no ReadFS/permission implementation/full-source or runtime claim.')
metadata=[]
for p,rr in [('README.md',[[20,20]]),('.github/workflows/release.yml',[[151,152]])]:
 r=dict(pins[p]);r.update(coverage='selected current platform-declaration metadata only',selectedLineRanges=rr,scope='Platform badge and Desktop release matrix only. Does not certify Windows CLI/native operation.');metadata.append(r)
for r in [x,*metadata]:
 b=(R/r['path']).read_bytes();assert len(b)==r['bytes'] and sha(b)==r['sha256'];r['endingSha256']=sha(b)
put('source-manifest.json',dict(rootReportedReadBaseline='524c0827a480132119b637aa87e16f0eab9895f3',files=[x],metadataFiles=metadata,counts=dict(productSemanticLines=15,metadataSelectedLines=3,productBodyDisplayedLines=50,metadataBodyDisplayedLines=21,full=0,selected=1,tests=0),sameRootAs111=True,priorRoot111ToolDisplayReadReused=True,newStandaloneFindingCount=0,productRuns=0,globalCoverageUpdated=False))
(D/'report.md').write_text('''# Root114：Windows路径摘要合同核对\n\n支持与独立113相同的有限P3静态显示线索，待Root统一正式编号；不是第三个独立作者或单独计数。Root111已读同SHAtoolDisplay全文及真实TUI/CLI args显示分支，此处不重读它们。只补当前普通Windows输入合同和平台声明，0产品/helper/test/Windows/native/TTY/DOM/clock/network/Git运行。\n\nREADME20明示macOS/Windows/Linux；release.yml151–152有Windows Desktop发布matrix，但它单独不能证明完整CLI Windows运行验收。Read schema27–35要求file_path是绝对路径，8从node:path导入isAbsolute/resolve，51–54保留rawPath并按本机绝对路径处理。没有展开或执行Read权限/FS机制、真实文件或用户数据。\n\n在正常Windows进程cwd下，合法的C盘绝对文件路径不以斜杠开头。Root111已读toolDisplay26–27因此直接返回原绝对值，未到28–31的cwd去前缀。84–97又对路径摘要限60字符，ToolCallStart43/56与TextRenderer57–60直接显示它。较长共同cwd前缀可占满预算，两个不同ASCII文件相对尾部都不显示。它违反本helper15–24的按cwd缩短约定；本例不依赖UTF16/任意坏DTO，也不声称实际Windows帧、所有路径或路径访问失败。\n\n原R14UTF16关联及失败fixture保持排除，Windows这条仅源推导。113独立限定复核并做历史同因去重，本包不新扫全仓/全历史或借旧pass。仅15产品语义+3平台元数据行，实际显示71行；不是新full或唯一覆盖升级。预读[初pin](initial-pins.json)/[releasepin](release-before-pin.json)和读后[摘录](source-excerpts.json)、[范围](source-manifest.json)保留。三pin结束相同，无metadata错误/截断，不改产品或旧冻件。\n''')
rr=[]
for p in sorted(D.rglob('*')):
 if p.is_file() and p.name!='author-receipt.json':
  b=p.read_bytes();rr.append(dict(path=p.relative_to(D).as_posix(),bytes=len(b),sha256=sha(b)))
put('author-receipt.json',dict(atUTC=datetime.now(timezone.utc).isoformat(),files=rr,selfExcluded=True,productRuns=0));print(json.dumps(dict(files=len(rr)+1,sourcePins=3,productSemanticLines=15,productRuns=0)))
