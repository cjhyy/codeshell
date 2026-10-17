from pathlib import Path
import hashlib,json,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');D=Path('/tmp/codeshell-audit-round131-tool-results')
def sha(b):return hashlib.sha256(b).hexdigest()
def w(n,j):(D/n).write_text(json.dumps(j,ensure_ascii=False,indent=2)+'\n')
pins=json.loads((D/'initial-pins.json').read_text())['files']+json.loads((D/'consumer-before-pins.json').read_text())['files'];by={r['path']:r for r in pins}
specs=[('packages/core/src/context/tool-result-storage.ts',[[57,109],[187,218],[255,270],[287,306],[330,437],[440,475]],[[1,493]]),('packages/core/src/context/tool-output-budget.ts',[[14,46],[64,106]],[[1,106],[128,173]]),('packages/core/src/context/manager.ts',[[385,385],[780,794]],[[375,391],[775,801]]),('tests/tool-result-storage.test.ts',[[98,117],[266,282]],[[98,117],[266,282]]),('packages/core/src/context/tool-output-budget.test.ts',[[48,91],[106,118]],[[48,91],[106,118]])]
rows=[];excerpts=[]
for p,sem,shown in specs:
 r=by[p];b=(R/p).read_bytes();assert sha(b)==r['sha256'];lines=b.decode().splitlines();rows.append(dict(path=p,bytes=len(b),lines=len(lines),sha256=r['sha256'],coverage='selected',selectedLineRanges=sem,bodyDisplayedLineRanges=shown,semanticLines=sum(z-a+1 for a,z in sem),bodyDisplayedLines=sum(z-a+1 for a,z in shown),beforeBodyOrLineNavigation=True,scope='Ordinary text-slot/state/replacement projection and direct manager call boundary; filesystem custody, private file I/O, atomicity, security and callback-failure mechanisms not certified. Test rows are declarations only.',overlap='R4 two primary files same-SHA full; R21 helper full and storage selected. Current targeted read retains overlap, not first/unread or unique coverage.'))
 excerpts.append(dict(path=p,sha256=r['sha256'],captureTiming='After actual display, not a second semantic read',blocks=[dict(start=a,end=z,lines=[dict(line=n,text=lines[n-1]) for n in range(a,z+1)]) for a,z in shown]))
w('source-excerpts.json',dict(files=excerpts,productExecution=0))
meta=[];canonical=[]
for name,key,ids in [('docs/audit-2026-10-17-round4/evidence/context-source-manifest.json','sources',[3,4]),('docs/audit-2026-10-17-round21/evidence/toolbudget-source-manifest.json','files',[0,6])]:
 j=json.loads((R/name).read_text())
 for i in ids:canonical.append(dict(document=name,jsonPointer='/'+key+'/'+str(i),row=j[key][i]))
for p in ['docs/audit-2026-10-17-round4/evidence/context-source-manifest.json','docs/audit-2026-10-17-round21/evidence/toolbudget-source-manifest.json','docs/audit-2026-10-17-round4/context.md','docs/audit-2026-10-17-round21/tool-budget.md']:
 b=(R/p).read_bytes();meta.append(dict(path=p,bytes=len(b),sha256=sha(b),coverage='selected-historical-metadata',firstSemanticReadSha256=None,note='Original row objects or complete original MD actually read; SHA captured after display, not invented pre-read pin.'))
w('canonical-metadata.json',dict(rows=canonical,scope='Four exact original rows, R4 full and R21 full/selected qualifiers retained.'))
w('source-manifest.json',dict(files=rows,historicalMetadataSelected=meta,totals=dict(fullFiles=0,selectedFiles=5,productSemanticLines=357,testDeclarationLines=94,bodyDisplayedLines=783),navigationNote='rg-n test titles and manager import/call locators navigation only, not whole-source reading. Storage493 displayed but only ordinary selected semantics counted; helper128–173 truncation/Unicode adjacency not audited as new route.',rootReportedBaseline='ae7bd786f133f9c42d212d41110b54eb18c4a9e4',productExecution=0))
w('classification.json',dict(formal=[],candidates=[],related=[],counterevidence=['Structured preview retains parts per original text slot; header/footer go into first/last text parts rather than collapsing media positions.','replaceToolResultText preserves nontext references and spreads text blocks; ambiguous legacy scalar for multiple slots returns original rather than guessing positions.','Apply persistence pass spreads tool_result and affected messages, retains other fields; unchanged and cleared-result branches avoid unnecessary rollback.','Cold projection validates version/hash/part count and joined replacement; ordinary cached same-id replay has exact replacement map semantics. No actual FS restart or corrupt-file claim.'],exclusions=['CTX-1 prefix pair snipping and CTX-2 structured summary omission','R21 source concern/structured separator floor and May30 magic200 already recorded','R4 image-number drift old archive cause','Arbitrary repeated-id changed-content or sentinel-looking DTO without actual normal producer not promoted','Filesystem/custody/path/atomic-write fault tests not executed, even though adjacent implementation displayed']))
w('validation.json',dict(productAttempts=0,passedTests=0,expectations=0,testDeclarationLines=94,scope='No product/helper/import/fixture/test/model/native/network/FS experiments. Source files only and standardlib audit metadata. Old R21 passes not borrowed.'))
batch=json.loads((D/'history-batch.json').read_text());changed=[];missing=[]
for r in batch['inventory']:
 p=R/r['path']
 if not p.is_file():missing.append(r['path'])
 else:
  b=p.read_bytes()
  if len(b)!=r['bytes'] or sha(b)!=r['sha256']:changed.append(r['path'])
assert not changed and not missing
checks=[]
for r in pins:
 assert sha((R/r['path']).read_bytes())==r['sha256'];checks.append(dict(path=r['path'],sha256=r['sha256'],same=True))
w('ending-checks.json',dict(atUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),sourcePins=checks,historyFiles=len(batch['inventory']),changed=changed,missing=missing,productExecution=0))
(D/'report.md').write_text('''# Root131：工具结果预览的普通文本槽位与字段保留

有限结论 **0新增正式问题、0候选、0新增关联**。目标是正常structured tool_result生成预览、复用与恢复时是否丢非文本块/字段，不是完整持久化、权限、文件安全或运行认证。

[初始pin](initial-pins.json)先于正文/行导航：storage493行19859B SHAa5bc…、budget173行6990B SHAd1c2…。亲核[四个原canonical对象](canonical-metadata.json)：R4两文件reviewfull同SHA，R21 helper1–173 full/storage180–220与330–420 selected，原context.md与tool-budget.md完整读后保留普通范围、旧实验证据限制。本轮因具体槽位问题定向重读，全部旧重叠明确，不称首次或唯一新增覆盖；R21 separator floor concern/旧magic200、CTX-1/2和图片编号旧因不重报、不复跑。

正常链的反证：buildReplacement保存与原text slot一一对应parts，header/footer置首末text part；replaceToolResultText仅替换text并保留非文本对象和顺序，旧scalar遇多槽位不猜位置。应用pass spread原block/message保留其他字段，cached/cleared分支避免重复改写；恢复投影核version/hash/parts count及joined replacement。真实Manager385初始化state、780–794把正常config/state交实际helper，停在文件读写与日志边界。现有缓存repeat/reconstruct、media slots与legacy scalar测试只声明94行，不导入或执行。

[范围清单](source-manifest.json)为5selected0full：357产品语义、94测试声明，共451；正文显示783行。storage493全显示但仅列普通选段，文件I/O/custody/atomicity等相邻实现不纳本轮认证；helper128–173 Unicode/truncation相邻未开新方向，Manager867与两测试也未全文阅读。[consumer pin](consumer-before-pins.json)在行导航前，[摘录](source-excerpts.json)实际显示后保存。所有产品/helper/import/fixture/test/模型/native/网络/真实FS实验0，不借旧pass认证本轮。

[共享历史batch](history-batch.json)纳已冻55排56+：5584MD/JSON、递归JSON value scalars、archives参与、0parse错误；各query cap100，storage99全存、budget269仅前100。Root给128–130共享path/SHA导航，机器遍历不等于语义穷尽；Root只亲读所显示的有限target命中、原四对象和两原MD。具体候选旧因不能仅凭path/SHA缺少建立新颖性，本轮没有候选。[首stdout](history-first.stdout)/[stderr](history-first.stderr)/[退出](history-first-exit.json)原样exit0。

[结束检查](ending-checks.json)5源/测试pins和原5584历史成员全同。Root单独负责Git分支集成，不将其说成产品执行；其他作者只按自身有限投影与实际原件阅读认范围。全仓覆盖未重算，4339不能确认全文不是精确未读或剩余数。
''')
art=[]
for p in sorted(D.iterdir()):
 if p.is_file() and p.name!='author-receipt.json':
  b=p.read_bytes();art.append(dict(path=p.name,bytes=len(b),sha256=sha(b)))
w('author-receipt.json',dict(frozen=True,files=art,scope='Self-excluded exact finite source/metadata evidence, product execution0.'))
print(json.dumps(dict(files=len(art)+1,receipt=len(art),formal=0)))
