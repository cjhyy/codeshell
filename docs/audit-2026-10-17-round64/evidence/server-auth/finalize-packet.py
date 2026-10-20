from pathlib import Path
import json,hashlib,datetime,re
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round172-server-auth')
def load(n):return json.loads((out/n).read_text())
def put(n,v):(out/n).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def digest(b):return hashlib.sha256(b).hexdigest()
def union(rs):
 result=[]
 for i in sorted({i for a,z in rs for i in range(a,z+1)}):
  if result and i==result[-1][1]+1:result[-1][1]=i
  else:result.append([i,i])
 return result
first={r['path']:r for r in load('initial-pins.json')['files']}
for r in load('caller-before-navigation-pins.json'):first.setdefault(r['path'],r)
plans=[
 ('packages/server/src/hub/auth-http.ts',[[1,290]],[[1,290]],'product'),
 ('packages/server/src/hub/auth-store.ts',[[1,415]],[[1,415]],'product'),
 ('packages/server/src/serve/headless-server.ts',[[189,206],[276,290],[779,797],[842,859],[878,883]],[[185,215],[255,294],[775,820],[842,887]],'product'),
 ('packages/web/app/auth.ts',[[72,105],[122,141],[196,205]],[[61,141],[196,205]],'product'),
 ('packages/web/app/AuthGate.tsx',[[114,145],[192,224],[289,348]],[[114,145],[192,224],[289,348]],'product'),
 ('packages/server/src/hub/auth-store.test.ts',[[21,97]],[[21,97]],'test-declaration'),
 ('packages/server/src/hub/auth-http.test.ts',[[92,148]],[[92,148]],'test-declaration')]
nav={}
for group in load('caller-navigation.json'):
 paths=[x for x in group['command'] if x.startswith('packages/')]
 for line in group['stdout'].splitlines():
  m=re.match(r'^([^:]+):(\d+):',line)
  if m:nav.setdefault(m[1],set()).add(int(m[2]));continue
  m=re.match(r'^(\d+):',line)
  if m and len(paths)==1:nav.setdefault(paths[0],set()).add(int(m[1]))
scopes={
 'auth-http.ts':'Complete physical source through EOF; ordinary bootstrap/setup/login, source/global/concurrency admission counters, cookie rotation, authenticate/status/list/revoke/logout, origin/token parsing, body read limits/timeout/disconnect cleanup and typed/generic error responses. Not an attack campaign or runtime certificate.',
 'auth-store.ts':'Complete physical source through EOF; initialize, setup/login preflight and locked recheck, grant/rotation/expiry/oldest-session removal, authentication/read throttling, list/revoke/revokeAll, strict storage read/write/finally, and record validation. Real stores, crypto, filesystem/locks/accounts and restoration are not executed or universally certified.',
 'headless-server.ts':'Selected actual HubAuth creation/onRevoke, periodic session revalidation, auth route before responses.track, protected API/WS authentication and per-message check. Adjacent publishing/upload/worker lines are display only; not full Host/security enforcement certification.',
 'auth.ts':'Selected actual same-origin JSON POST/status helper, error propagation and non-cloud status projection. Adjacent Desktop helper and unselected cloud branch are outside semantic scope.',
 'AuthGate.tsx':'Selected normal Hub submit/refresh state protection, accepted UI fields and error/busy cleanup. Adjacent cloud guards visible, without auditing cloud-account mechanisms or mounting React.',
 'auth-store.test.ts':'Selected existing declarations for one-time bootstrap/restart, setup/login concurrency, rotation/revocation/fixed expiry and session cap. No tests/crypto/timers/filesystem fixtures run.',
 'auth-http.test.ts':'Selected existing normal status/setup/login/cookie/bearer/list/revoke/logout declaration. No HTTP/server/network/test fixture run.'}
files=[]
for p,semantic,display,kind in plans:
 r=first[p];semantic=union(semantic);display=union(display);semset={i for a,z in semantic for i in range(a,z+1)}
 files.append({'path':p,'bytes':r['bytes'],'lines':r['lines'],'sha256':r['sha256'],'initialPinAtUTC':r['pinAtUTC'],'initialSemanticReadSha256':r['sha256'],'coverage':'full' if semantic==[[1,r['lines']]] else 'selected','selectedLineRanges':semantic,'semanticReadLineRanges':semantic,'displayedLineRanges':display,'semanticReadLines':len(semset),'displayedLines':sum(z-a+1 for a,z in display),'sourceKind':kind,'scope':scopes[Path(p).name],'fullReadReachedEOF':semantic==[[1,r['lines']]],'navigationLineRanges':union([[n,n] for n in nav.get(p,set())]),'navigationOnlyLineRanges':union([[n,n] for n in nav.get(p,set())-semset]),'oldOverlap':'Old auth-round7 lifecycle and file-mutex-quality-round19 auth lock scopes overlap. Their report commit/path references do not provide a current per-file SHA/full proof; no first-read or unique-new-coverage claim.' if '/hub/auth-' in p and kind=='product' else 'Necessary selected contract reading; no first-read/unique coverage claim.'})
for p in ['CODESHELL.md','AGENTS.md']:
 r=first[p];files.append({'path':p,'bytes':r['bytes'],'lines':r['lines'],'sha256':r['sha256'],'initialPinAtUTC':r['pinAtUTC'],'coverage':'hash-only','selectedLineRanges':[],'semanticReadLineRanges':[],'displayedLineRanges':[],'semanticReadLines':0,'displayedLines':0,'sourceKind':'instruction','fullReadReachedEOF':False,'scope':'Unchanged previously read instructions, hash-only reuse; no new instruction semantic lines.'})
product=sum(r['semanticReadLines'] for r in files if r['sourceKind']=='product');test=sum(r['semanticReadLines'] for r in files if r['sourceKind']=='test-declaration');display=sum(r['displayedLines'] for r in files)
assert product==970 and test==134 and display==1218
metadata=load('old-gate-initial-pins.json');history=load('history-projection.json');shared=history['sharedBatch'];ending=[]
for r in files:
 b=(root/r['path']).read_bytes();ending.append({'path':r['path'],'initialSha256':r['sha256'],'endingSha256':digest(b),'initialBytes':r['bytes'],'endingBytes':len(b),'lines':len(b.decode().splitlines()),'endsWithNewline':b.endswith(b'\n'),'same':digest(b)==r['sha256'] and len(b)==r['bytes']})
me=[]
for r in metadata:
 b=(root/r['path']).read_bytes();me.append({'path':r['path'],'initialSha256':r['sha256'],'endingSha256':digest(b),'same':digest(b)==r['sha256']})
b=Path(shared['path']).read_bytes();me.append({'path':shared['path'],'initialSha256':shared['sha256'],'endingSha256':digest(b),'same':digest(b)==shared['sha256']});assert all(r['same'] for r in ending+me)
put('ending-checks.json',{'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceRows':ending,'selectedMetadataRows':me,'allSame':True,'wholeHistoryRehashed':False,'newSourceSemanticReadFromThisCheck':0})
counts={'sourceRows':9,'productFullFiles':2,'productSelectedFiles':3,'testSelectedFiles':2,'instructionHashOnlyFiles':2,'productFullReadLines':705,'productSelectedReadLines':265,'productSemanticLines':product,'testDeclarationLines':test,'sourceAndTestDisplayedLines':display}
put('source-manifest.json',{'root':str(root),'rootReportedHead':'5fa6a076db90682733c33fd46e1f473f9214d196','rootReportedBranch':'codex/audit/auth-panel-attachments-round64-20261018','GitVerified':False,'files':files,'counts':counts,'metadataFiles':metadata,'sharedHistory':shared,'oldGateSemanticScope':{'auth-round7.md':[[1,45],[89,102]],'file-mutex-quality-round19.md':[[5,15],[19,23],[31,31],[53,57]],'totalSelectedPriorReportLines':81,'originalInventoryObjects':'2 compact original /module_inventory groups; target /paths/8 and /paths/9 only, no per-file SHA or scope; 187/188 inventoried paths are not semantic reads.','file-mutex-round19.md':'hash-only; original intended range exceeded EOF96 and no body emitted for this file'},'meaning':'Full/selected means bounded physical source reading, not all behaviors validated, all enforcement certified, first reading or unique coverage. Display-only adjacent lines and navigation-only matches are not added to semantic counts. Existing test declarations are not executions.','productExecutions':0,'testsExecuted':0,'gitCalls':0,'networkCalls':0})
matrix=[
 {'lifecycle':'initialize/restart/bootstrap','source':'auth-store.ts102–120,276–295','review':'Creates one-time secret only for first creator; established missing/corrupt store does not reopen bootstrap. Disclosure-once policy is explicit, reinforced by selected test declaration21–46. Not promoted as a restart defect.'},
 {'lifecycle':'setup and concurrent setup','source':'auth-store.ts123–139,203–211','review':'Validates input, prechecks bootstrap before async hash, then rechecks same bootstrap/account under mutate lock before commit.'},
 {'lifecycle':'login and token rotation','source':'auth-store.ts142–158,214–240; auth-http.ts101–104,130–143','review':'Authenticates normalized credentials, rechecks locked account hash after async work, removes presented/expired sessions, evicts oldest if capped, and returns revoked ids; HTTP performs callbacks, cookie and reply.'},
 {'lifecycle':'fixed expiry/authentication/list','source':'auth-store.ts161–183','review':'Validating auth rereads under mutation, checks expiry/createdAt; throttles lastSeen write; listing filters expired rows. Fixed rather than sliding TTL is explicit in selected declaration65–83.'},
 {'lifecycle':'revoke/logout and concrete cleanup','source':'auth-store.ts186–200; auth-http.ts146–168; headless-server.ts189–206,779–797','review':'Logout/revoke update store before callback and cookie clear. Concrete auth.handle routing occurs before protected-response tracking, so this inspected Hub handler is not assumed to cancel its own response. Existing R38 is kept under its original scope, not called fixed by this negative.'},
 {'lifecycle':'validation after connect','source':'headless-server.ts276–290,842–859,878–883','review':'Concrete WS principal checked on admission, every handled message and periodic recheck; failures close with4401. No real WS, timers or revocation timing observed.'},
 {'lifecycle':'HTTP input/error/cleanup','source':'auth-http.ts48–92,116–178,184–290; auth.ts72–105,122–141','review':'Actual Web POST sends JSON with same-origin credentials. Origin/token parse/body type and size/abort/timeout cleanup, activeLogins finally, typed error codes and generic503 branches were read; malformed DTOs were not used as findings.'},
 {'lifecycle':'UI normal producers/recovery','source':'AuthGate.tsx114–145,192–224,289–348','review':'Normal field maxima match store labels/password bounds; pending login prevents focus refresh superseding submit; revision and finally protect late responses and busy cleanup. No React/browser request observed.'},
 {'lifecycle':'storage/lock error boundary','source':'auth-store.ts254–310,369–415','review':'Full static read of locked reload/write/finally and strict record shape. Native storage errors, lock acquisition semantics, all restore/custody/platform races remain unvalidated; old FM19-1 acquisition retry root cause is excluded.'}]
put('lifecycle-review.json',{'matrix':matrix,'normalCounterexampleEstablished':False,'arbitraryBadDtoOrInjectedRejectUsed':False,'runtimeTests':0})
put('classification.json',{'formalFindings':[],'candidates':[],'newRelatedFindings':[],'counts':{'formal':0,'candidate':0,'newRelated':0},'result':'Finite static negative after complete HTTP/store source lifecycle and error-branch reading, with concrete selected consumers.','existingCauseExclusions':[{'reference':'docs/review-2026-10-12/auth-round7.md:3,89','oldCauses':['R03 ACK duplication','R32 quota/secret persistence failure','R38 HTTP logout black hole'],'meaning':'Not recounted or declared repaired; old dynamic experiments are not rerun.'},{'reference':'docs/review-2026-10-12/file-mutex-quality-round19.md:5,11–23,31,53–57','oldCause':'FM19-1 auth lock acquisition retries EACCES synchronously','meaning':'Same old acquisition/availability cause not reported anew; no permission/lock/process experiment.'}],'unpromotedLead':{'topic':'bootstrap undisclosed again after restart','disposition':'Not a new bug: original creator-only comment and selected existing declaration explicitly require initialize return undefined on restart while original token remains valid. No contrary normal recovery contract established.'},'notClaimed':['current auth is universally secure/correct','all storage/process/clock/real account/network states covered','old runtime tests pass again','all historical causes exhausted','new unique source coverage'],'productExecutions':0})
put('diagnostics.json',{'firstOldGateReader':{'stdout':'read-old-gate.first.stdout.txt','stderr':'read-old-gate.first.stderr.txt','exit':'read-old-gate.first.exit.json','childExitCode':1,'cause':'Requested file-mutex-round19.md 88–103 but actual EOF96. Previous two old reports had emitted; no product code ran. Original source/method retained.','followup':'Separate bounded old metadata windows and compact module-object projection only, no product validation retry.'},'toolDisplayTruncations':[{'chunkId':'84bb9d','raw':'read-old-gate.first.stdout.txt','toolReportedOriginalTokens':7026,'maxOutputTokens':6800},{'chunkId':'31d44b','raw':'read-old-gate-bounded.first.stdout.txt','toolReportedOriginalTokens':8349,'maxOutputTokens':5700,'cause':'Unnecessarily printed original 187/188-path inventory groups; subsequently inspected compact fields and exact missing old-report windows, not all inventory paths semantically.'}],'sourceBodyDisplayTruncations':[],'metadataSyntaxWarning':{'artifact':'navigate-callers.first.stderr.txt','childExitCode':0,'cause':'Non-raw regex literal invalid-escape SyntaxWarning; navigation completed. Method not rewritten/rerun.'},'actualProductImportOrTestAttempts':0})
report=f'''# Hub认证生命周期静态审查（预备172）

**0 正式 / 0 候选 / 0 新 related**。当前未建立普通用户可达的新反例；这是完整阅读两主文件后、结合真实入口的有限结论，不认证全部认证/安全机制正确。

Root报告冻结HEAD `5fa6a076db90682733c33fd46e1f473f9214d196`、分支 `codex/audit/auth-panel-attachments-round64-20261018`；本作者Git0。CODESHELL/AGENTS同SHA承接，源码只读，仅写exact tmp。

- auth-http.ts **1–290**、auth-store.ts **1–415**完整读到实际EOF，705行。审查initialize→setup→异步密码计算后锁内复核→login/grant→轮换/过期/最旧淘汰→authenticate/list→revoke/logout，以及输入、读取、写入、异常与finally分支。不是只核DTO。[逐生命周期检查](lifecycle-review.json)逐项列实际行号、反证与限度。
- 最小真实消费者为Headless创建/onRevoke、auth.handle先于受保护response跟踪、WS接入/逐消息/周期复查，及Web JSON POST/status helper、AuthGate普通提交/刷新/字段约束；实际语义范围共265产品行。对应 [source manifest](source-manifest.json) 明确完整/选段/导航/hash和相邻显示。合计 **970产品语义行、134既有测试声明行；显示1218行**。5产品文件=2full+3selected，2test selected，2instruction hash-only。声明不是测试通过；没有产品/helper/import/fixture/test/clock/crypto/native/process/account/network执行。
- 正常分支反证：setup/login在异步hash后重新核验锁内状态；grant回传实际撤销ID再触发清理；认证重新读取且TTL固定；Web pending/revision/finally保护普通提交与状态刷新。一次性bootstrap重启不再次披露是注释和既有声明的明确策略，未把“重启拿不到原令牌”强报新缺陷。具体未晋升理由见 [classification](classification.json)。
- 旧gate实际读取auth-round7选段59行、file-mutex-quality-round19选段22行及2个原inventory对象的compact字段。R03/R32/R38和FM19-1旧因保留不重报；不以本次Hub接线反证冒称旧logout或锁问题已修。原module_inventory187/188只是路径集合，没有逐文件SHA/full，不据其排除当前阅读，也不称本次首读或唯一新增覆盖。
- Root175 [共享历史投影](history-projection.json) 纳冻63排64+：6801 MD/JSON、5,060,759 JSON value scalar visits、errors=[]、含archive/hidden/unignored；HTTP72/store78命中均低cap100且全保存。机器命中、库存、旧读范围不等于根因全史穷尽；无新反例故未扩一次全史cause扫描。

未验证真实账号登录、HTTP/WS、30天等待/并发帧、真实磁盘故障/跨进程锁、所有恢复/平台/权限边界、cloud-account机制或全Host防护。旧动态失败方向均SKIP，不恢复、不替代运行。

初始pin先于正文/行导航；两主文件EOF均LF。Ending9源/指令pins及4份旧材料+shared batch均同，见 [ending](ending-checks.json)；未重hash全6801历史。首次旧metadata EOF断言exit1、两次历史工具显示截断、导航SyntaxWarning均保留原stdout/stderr/exit与 [诊断](diagnostics.json)。准确补选仅元数据，产品源正文输出未截断。所有child输出先保存后展示，无修复或仓库写入。
'''
(out/'report.md').write_text(report)
links=[{'target':target,'exists':(out/target).is_file()} for _,target in re.findall(r'\[([^\]]+)\]\(([^)]+)\)',report)];assert all(x['exists'] for x in links)
for r in files:assert sum(z-a+1 for a,z in r['selectedLineRanges'])==r['semanticReadLines']
excerpts=[]
for n in ['http-part1-excerpt.json','source-part2-excerpts.json','store-part2-excerpt.json','caller-excerpts.json','reaper-excerpt.json']:
 d=load(n)
 for x in d if isinstance(d,list) else [d]:
  b=x['text'].encode();assert len(b)==x['bytes'] and digest(b)==x['sha256'];excerpts.append({'artifact':n,'path':x['path'],'range':x['range']})
put('checks.json',{'classification':{'formal':0,'candidate':0,'newRelated':0},'counts':counts,'reportLinks':links,'allLinksExist':True,'sourceExcerptRangeObjectsChecked':len(excerpts),'sourceExcerptBytesAndHashesValid':True,'endingAllSame':True,'fullTargetEOFs':['auth-http.ts:290','auth-store.ts:415'],'productExecutions':0,'gitCalls':0})
print(json.dumps({'classification':'0/0/0','sourceRows':9,'productSemanticLines':product,'testDeclarationLines':test,'displayLines':display,'links':len(links),'endingAllSame':True},ensure_ascii=False))
