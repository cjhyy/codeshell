"""Freeze metadata-only through62 increment. Does not execute product methods."""
from pathlib import Path
import hashlib,json,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');D=Path('/tmp/codeshell-audit-round171-coverage62')
def sha(b):return hashlib.sha256(b).hexdigest()
def write(n,v):(D/n).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
pins=json.loads((D/'input-pins.json').read_text())['files'];inventory=json.loads((D/'current-source-inventory.json').read_text())['files'];ending=[]
for row in inventory:
 raw=(R/row['path']).read_bytes();assert len(raw)==row['bytes'] and sha(raw)==row['sha256'];ending.append(dict(path=row['path'],bytes=len(raw),sha256=sha(raw)))
for row in pins:
 raw=(R/row['path']).read_bytes();assert len(raw)==row['bytes'] and sha(raw)==row['sha256']
queries=json.loads((D/'initial-query-pins.json').read_text())['files']
for row in queries:assert sha((R/row['path']).read_bytes())==row['sha256']
write('ending-source-inventory.json',dict(files=ending,sourceSemanticReads=0));write('ending-checks.json',dict(sourcePaths=4643,sourceDrift=[],metadataPins=len(pins),metadataDrift=[],queryPins=len(queries),queryDrift=[],productRuns=0))
write('diagnostics.json',dict(methodDiscovery='First Root metadata lookup guessed old163/migrate-coverage.py; wc and sed returned missing-file errors, shell exit1. Original only tool transcript, no standalone raw streams claimed. Exact source-manifest.currentMethod later identified migrate.py. No old method executed.',schemaPeekTiming='Before new adapter, Root printed selected original source-manifest fields and SHA. Persistent input-pins explicitly say before adapter parse, after earlier schema peek; no invented earliest before-read pin. Earlier peek objects now preserved in canonical-rows.json from unchanged metadata.',adapterFirstExit=0,verificationFirstExit=0,productFailures=0,productReruns=0))
write('source-manifest.json',dict(role='Root metadata-only through62 coverage increment and shared history navigation',files=[],metadataFiles=pins[:-2],instructionHashOnly=pins[-2:],hashOnlyFiles=[dict(row,coverage='hash-only',semanticLineCount=0,scope='Root shared query bytes only, no Root semantic reading; source actors168–170 own their actual source reads.') for row in queries[:-2]],sourceByteInventoryArtifact=dict(path='current-source-inventory.json',bytes=len((D/'current-source-inventory.json').read_bytes()),sha256=sha((D/'current-source-inventory.json').read_bytes())),endingSourceByteInventoryArtifact=dict(path='ending-source-inventory.json',bytes=len((D/'ending-source-inventory.json').read_bytes()),sha256=sha((D/'ending-source-inventory.json').read_bytes())),rootBaseline='9874f8abdfce0ade5bb058d26e026b10f173a129',gitCertified=False,productSemanticReads=0,productRuns=0,oldMethodsExecuted=False,scope='Only four formal62 primary .files lists. No aggregate Git binding/derived claims/MD-only old source expansion. Original purposes and overlap retained; current63 source records not merged. Earlier61 deferred display row is not cleared by zero new62 deferrals.'))
summary=json.loads((D/'summary.json').read_text());assert summary['counts']==dict(full=368,selected=377,unknown=3898)
j=json.loads((D/'history-batch.json').read_text())
(D/'report.md').write_text(f'''# Root171：正式62覆盖回填与本轮共享导航

原4643路径的相同9874源码SHA索引更新为 **368 full /377 selected /3898 unknown**，4275条尚不能标完整范围。这是已有正式62审查记录的metadata回填，不是本次新读4643源码、精确未读量、剩余bug数或当前未修复总数。

四个原canonical .files共36行，26条有效语义记录对应26路径、10条显式hash/instruction排除、0本次新deferred。22个unknown升级：8full、14selected；另4条既有状态仅补provenance。8full为model-catalog三叶、collection、theme conversion/URL/shared types和1份既有run-replay测试声明；full原用途/权限/机制/旧重叠限制随[完整原对象](canonical-rows.json)和[full用途](new-full-provenance.json)保留。235行既有测试声明不代表执行或通过。

只接纳原明确selected范围、同SHA/EOF、实际body/display/nav union支持，full还需单份明确whole1–EOF且无full veto；多份selected不相加成full。显式nav也不能凭出现就新增语义。接受原selectedLineRanges及一致的semanticReadLineRanges别名，规范allowlist保留sha256数字。原62/Root166 realpath7行措辞澄清和旧61 display越EOF由原[scope metadata](source-manifest.json)输入保留；本次0deferred不解除旧61那1条暂缓记录。

[适配器](migrate.py)首stdout/stderr/exit在查看前保存，exit0；[第二实现](verify.py)直接从原metadata重建4643状态和22变化，未调用适配器，exit0。这是Root两种方法的自检，非另一个peer或新增源码审查。[summary](summary.json)、[claims](accepted-claims.json)、[排除](excluded-deferred.json)、[transitions](transitions.json)、[更新索引](unified-current-index.json)、[verification](verification.json)。

4643源码只读raw bytes/hash/EOF，初末全同；8份metadata/instruction pins与11份query/instruction pins均未漂移，见[结束核对](ending-checks.json)。Git认证由Root集成另行完成，此包gitCertified=false、Git0、files=[]。四份manifest在本adapter之前有Root字段投影；持久化pins只声明beforeAdapterParse，未捏造先于所有早期peek。首次猜旧method文件名exit1保留[diagnostics](diagnostics.json)，没有运行旧方法、产品或测试。

共享机器导航纳冻62排63+：{j['historyFiles']} MD/JSON、{j['jsonValueScalarsVisited']}递归JSON value scalars，含archive/hidden/unignored，parse errors=[]。9目标命中57/60/84、48/52/48、51/51/51均低cap100全保存；这不是全历史语义阅读或新颖性穷尽证明。Root只提供字节/query，168–170的实际产品阅读单独分账。[原batch](history-batch.json)、[首stdout](history-first.stdout)、[首exit](history-first-exit.json)。

产品语义阅读/产品import/helper/fixture/test/native/模型/网络均0；原4643分母与旧失败方法不改，原始epoch/source时点不倒填。本轮63源选段未并入此索引；非TS/TSX与完整行为/平台/运行验证不在分母，全仓目标保持active。
''')
rows=[]
for p in sorted(D.rglob('*')):
 if p.is_file() and p.name!='artifact-receipt.json':
  raw=p.read_bytes();rows.append(dict(path=str(p.relative_to(D)),bytes=len(raw),sha256=sha(raw)))
write('artifact-receipt.json',dict(frozenUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),selfExcluded=True,files=rows))
print(json.dumps(dict(files=len(rows)+1,summary=summary,anchors=[dict(path=n,bytes=len((D/n).read_bytes()),sha256=sha((D/n).read_bytes())) for n in ['report.md','source-manifest.json','artifact-receipt.json']]),ensure_ascii=False))
