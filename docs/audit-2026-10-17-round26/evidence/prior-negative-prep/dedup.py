from pathlib import Path
import hashlib,json,re,subprocess
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
out=Path('/tmp/codeshell-audit-round26-frontier')
patterns={
 'prompt':r'prompt/(?:composer|section-cache|section-loader)|PromptComposer|SectionCache|composeSystemPrompt',
 'user-display':r'userMessageDisplay|user.message.display|strip.*(?:reminder|attachment)|extract.*user.*text',
 'message-mapper':r'messageMappers|map(?:Chat|Session|Protocol).*Message|message.mapper',
 'output-projection':r'outputCoverage|outputJournalRecovery|mobileOutputRecovery|transcriptReplay|streamReducer',
 'model-trace':r'model-trace-presentation|model.trace.presentation|model-trace-api',
 'notebook':r'notebook-edit|NotebookEdit|notebook.{0,40}(?:cell|source|output)',
 'git-parse':r'git/parse-log|parseGitLog|parse-log\.ts',
 'coding-text':r'codex-user-text|external-agent-changes|turn-input\.ts|review-prompt',
 'client-sync':r'remoteAppSync|connectionLiveness|useRemoteApp|mobileOutputClient|uiLanguage',
 'client-env':r'web/src/lib/environment|resolveRemote.{0,15}Url|remoteSocketUrl'
}
compiled={k:re.compile(v,re.I) for k,v in patterns.items()}
counts={k:0 for k in patterns};hits={k:[] for k in patterns};cap=180
stats={'files':0,'markdown':0,'json':0,'stringLeaves':0,'scalarLeaves':0};inventory=[];errors=[]
def scalars(v,p='$'):
 if isinstance(v,dict):
  for k,x in v.items():yield from scalars(x,p+'['+json.dumps(k,ensure_ascii=False)+']')
 elif isinstance(v,list):
  for i,x in enumerate(v):yield from scalars(x,p+'['+str(i)+']')
 else:yield p,v
for dirname in ['docs','bugs']:
 for p in sorted((root/dirname).rglob('*')):
  if not p.is_file() or p.suffix.lower() not in ['.md','.json'] or 'audit-2026-10-17-round26' in p.parts:continue
  raw=p.read_bytes();rel=str(p.relative_to(root));inventory.append({'path':rel,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()});stats['files']+=1
  t=raw.decode('utf-8')
  if p.suffix.lower()=='.md':
   stats['markdown']+=1;rows=[(str(i),line) for i,line in enumerate(t.splitlines(),1)]
  else:
   stats['json']+=1
   try:v=json.loads(t)
   except Exception as e:errors.append({'path':rel,'error':str(e)});continue
   rows=[]
   for loc,v in scalars(v):
    stats['scalarLeaves']+=1
    if isinstance(v,str):stats['stringLeaves']+=1;text=v
    else:text=json.dumps(v,ensure_ascii=False)
    rows.append((loc,text))
  for loc,text in rows:
   for group,pattern in compiled.items():
    for match in pattern.finditer(text):
     counts[group]+=1
     if len(hits[group])<cap:hits[group].append({'path':rel,'location':loc,'excerpt':text[max(0,match.start()-160):min(len(text),match.end()+620)],'wholeValueCharacters':len(text)})
result={'roots':['docs','bugs'],'archivesIncluded':True,'currentRound25IncludedAsHistory':True,'excluded':'future round26; material directory is outside repo','totals':dict(stats,parseErrors=len(errors)),'parseErrors':errors,'inventory':inventory,'patterns':patterns,'matchCounts':counts,'contextCapPerGroup':cap,'retainedContexts':{k:len(v) for k,v in hits.items()},'matches':hits,'limitations':['All recursive MD lines and JSON scalar values searched, not JSON keys.','Snapshot is per-file metadata read, not a Git-verified global atomic source freeze. Root may still be integrating round25.','Keyword matching and bounded hit contexts guide selected review; they do not establish semantic exhaustion.'],'productAttempts':0,'runtimeImports':0,'gitCommands':0}
(out/'history.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
argv=['rg','--files','packages/core/src/prompt','packages/web/src','packages/coding/src']
proc=subprocess.run(argv,cwd=root,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
(out/'inventory.json').write_text(json.dumps({'argv':argv,'exitCode':proc.returncode,'stderr':proc.stderr.decode(),'paths':proc.stdout.decode().splitlines(),'instructionSha256':hashlib.sha256((root/'CODESHELL.md').read_bytes()).hexdigest()},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'totals':result['totals'],'counts':counts,'contexts':result['retainedContexts'],'inventoryPaths':len(proc.stdout.decode().splitlines()),'inventoryExit':proc.returncode},ensure_ascii=False))
