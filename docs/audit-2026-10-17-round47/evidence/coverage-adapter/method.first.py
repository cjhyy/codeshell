from pathlib import Path
import json, hashlib, datetime, re, subprocess
from collections import Counter
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT=Path('/tmp/codeshell-audit-round57-coverage-adapter')
UTC=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
SHA=lambda b:hashlib.sha256(b).hexdigest()
def dump(name,v):
 (OUT/name).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
base='docs/audit-2026-10-17-round44/evidence/'
old_index=json.loads((ROOT/(base+'coverage-frontier/coverage-index.json')).read_text())['files']
old_sources=json.loads((ROOT/(base+'coverage-frontier/package-inventory.json')).read_text())['files']
old_hp=json.loads((ROOT/(base+'coverage-frontier/history-inventory.json')).read_text())
history_rows=old_hp['files']
old_hpaths={x['path'] for x in history_rows}
old_map={x['path']:x for x in old_sources}
status51=json.loads((ROOT/(base+'coverage-status/current-inventory.json')).read_text())
map51={x['path']:x for x in status51['files']}
rgsrc=['rg','--files','--hidden','-g','*.ts','-g','*.tsx','-g','!**/node_modules/**','-g','!**/.git/**']
sp=sorted(set(subprocess.run(rgsrc,cwd=ROOT,capture_output=True,text=True,check=True).stdout.splitlines()))
current={}
source_started=UTC()
for rel in sp:
 b=(ROOT/rel).read_bytes();current[rel]={'path':rel,'bytes':len(b),'sha256':SHA(b),'lines':len(b.splitlines())}
fresh_map=current.copy()
source_delta={'capturedUTC':UTC(),'startedUTC':source_started,'filter':rgsrc,'sourceCount':len(current),'input51':base+'coverage-status/current-inventory.json','added':[current[x] for x in sorted(set(current)-set(map51))],'removed':sorted(set(map51)-set(current)),'changed':[{'path':x,'before':{k:map51[x][k] for k in ['bytes','sha256','lines']},'now':current[x]} for x in sorted(set(current)&set(map51)) if current[x]['sha256']!=map51[x]['sha256']],'sourceBodyDecodedOrExecuted':False}
dump('current-source-delta.json',source_delta)
exclude=re.compile(r'(^|/)audit-2026-10-17-round(?:4[6-9]|5[0-7])(/|$)')
hcmd=['rg','--files','--hidden','--no-ignore','docs','bugs','-g','*.md','-g','*.MD','-g','*.json','-g','!**/.git/**','-g','!**/node_modules/**']
hpaths=sorted(set(x for x in subprocess.run(hcmd,cwd=ROOT,capture_output=True,text=True,check=True).stdout.splitlines() if not exclude.search(x)))
# Strict scalar path matching; embedded prose paths are intentionally not inferred.
def source_path(value):
    if not isinstance(value,str) or len(value)>1800 or '\n' in value:return None
    v=value.strip().strip('`').replace('\\','/')
    if v.startswith('./'):v=v[2:]
    located=False
    m=re.search(r':\d+(?:[-–]\d+)?$',v)
    if m:v=v[:m.start()];located=True
    if v in current:return v,located
    if v.startswith('/'):
        # Different old worktree roots are allowed only when the remainder is
        # an exact complete current repository path, not an arbitrary basename.
        for marker in ('/packages/','/tests/','/scripts/'):
            j=v.find(marker)
            if j>=0 and v[j+1:] in current:return v[j+1:],located
    return None
def sourceish_path(value):
    if not isinstance(value,str) or len(value)>1800 or '\n' in value:return None
    v=value.strip().strip('`').replace('\\','/')
    if v.startswith('./'):v=v[2:]
    v=re.sub(r':\d+(?:[-–]\d+)?$','',v)
    if not re.search(r'\.tsx?$',v):return None
    if v.startswith('/'):
        for marker in ('/packages/','/tests/','/scripts/','/docs/'):
            k=v.find(marker)
            if k>=0:return v[k+1:]
    return v if re.match(r'^(?:packages|tests|scripts|docs)/',v) else None

hash_pattern=re.compile(r'^[0-9a-fA-F]{64}$')
scope_key=re.compile(r'^(?:coverage|review|scope|readscope|reviewscope|readcoverage|semanticcoverage|readingscope|coveragelabel|rawcoveragelabel|readscopeclaim|coverageclaimfromauthor)$',re.I)
range_keys={'selectedlineranges','readranges','readlineranges','semanticreadranges','semanticlineranges','selectedranges','selectedlinerangesfromauthor'}
role_keys={'role','purpose','note','notes','readnote','timing','scopeboundary','readboundary','semanticreadperformed','additionalsemanticread','initialbeforesemanticread'}
metadata_keys={'context','excerpt','snippet','needle','match','jsonpointer','jsonlocation'}
history_row_index={r['path']:i for i,r in enumerate(history_rows)}
all_claims={}
anchor_counts=Counter(); scalar_count=0; string_count=0; errors=[]; object_count=0

def field_label(k):return re.sub(r'[^a-z]','',str(k).lower())
def ranges_of(value):
    rs=[]
    if isinstance(value,list) and len(value)==2 and all(type(z)is int for z in value):return [value]
    if isinstance(value,str):
        txt=value.strip()
        if re.fullmatch(r'[\s\[\]L0-9,;–—:-]+',txt):
            matches=re.findall(r'L?(\d+)\s*[-–—:]\s*L?(\d+)',txt)
            if matches:return [[int(a),int(b)]for a,b in matches]
    if isinstance(value,list):
        for x in value:
            if isinstance(x,list) and len(x)==2 and all(type(z) is int for z in x):rs.append(x)
            elif isinstance(x,dict):
                a=x.get('start',x.get('from'));b=x.get('end',x.get('to'))
                if type(a)is int and type(b)is int:rs.append([a,b])
    return rs

def row_fields(obj):
    scopes={};ranges={};roles={};hashes={}
    for k,v in obj.items():
        kk=field_label(k)
        if isinstance(v,str) and ('sha' in kk or kk=='hash') and hash_pattern.fullmatch(v):hashes[k]=v.lower()
        if scope_key.fullmatch(kk):
            if isinstance(v,(str,bool,int,float)) or v is None:scopes[k]=v
            elif isinstance(v,list):
                for i,x in enumerate(v):
                    if isinstance(x,(str,bool,int,float)):scopes[str(k)+'['+str(i)+']']=x
            elif isinstance(v,dict):
                # Only one explicit nested review/scope object, not arbitrary
                # descendant files or prose containers.
                for k2,v2 in v.items():
                    if scope_key.fullmatch(field_label(k2)) and isinstance(v2,(str,bool,int,float)):
                        scopes[str(k)+'.'+str(k2)]=v2
        if kk in range_keys or kk=='ranges':
            rs=ranges_of(v)
            if rs:ranges[k]=rs
            elif v not in (None,[]):roles['unparsedRangeFields.'+str(k)]=json.dumps(v,ensure_ascii=False)
        if kk in role_keys and isinstance(v,(str,bool,int,float)):
            roles[k]=v
    return scopes,ranges,roles,hashes

full_exact={'full','full-file','full file','full module','full static module','full-static','full source','full source file','全文','全文静态审查','full-static-module'}
no_semantic=re.compile(r'hash[- _]?only|pin[- _]?only|metadata[- _]?only|byte[- _]?only|no[- _]?semantic|not semantically|not (?:body[- ]?)?read|not reviewed|unread|未读|未阅读|不计语义|仅哈希|只.*哈希|only.*(?:hash|pin)|incidental|inventory[- _]?only',re.I)
nav_marker=re.compile(r'nav(?:igation)?[- _]?only|rg[- _]?(?:only|hits)|search hits|locator|导航|定位片段',re.I)
partial_marker=re.compile(r'selected|partial|snippet|except|excluding|excludes|选段|部分|not[- _]full|no full|not (?:a )?full|非全文|未全文|not whole|not all|not.*entire',re.I)
boundary_marker=re.compile(r'boundary|boundaries|mechanism[- _]?only|mechanism boundary|authority[- _]?only|边界|机制止|权限未审|不展开机制',re.I)
full_phrase=re.compile(r'\bfull\s+(?:(?:static|source|semantic)\s+)*(?:file|module)\b|全文(?:静态)?(?:阅读|审查|读取)',re.I)
selected_marker=re.compile(r'selected|partial|选段|部分',re.I)

def classification(path, located, scopes, ranges, roles, hashes, direct_paths, origin):
    vals=[str(v) for v in scopes.values() if v is not None]
    text=' | '.join(vals)
    rs=[z for values in ranges.values() for z in values]
    n=current[path]['lines']
    valid=bool(rs) and all(1<=a<=b<=n for a,b in rs)
    unique_hashes=set(hashes.values());cur=current[path]['sha256']
    same=cur in unique_hashes
    unambiguous=same and len(unique_hashes)==1 and len(direct_paths)==1 and origin!='list-scalar' and not located
    evidence_hash='current-same-object' if unambiguous else 'same-object-conflicted' if same else 'different-sha-same-object' if hashes else 'no-same-object-sha'
    scope_false=any(v is False for k,v in scopes.items() if 'review' in k.lower() or 'coverage' in k.lower())
    unparsed_ranges=any(k.startswith('unparsedRangeFields.')for k in roles)
    explicit_full=any(str(v).strip().lower() in full_exact or full_phrase.search(str(v)) for v in scopes.values() if isinstance(v,str))
    nonsemantic=bool(no_semantic.search(text))
    nav=bool(nav_marker.search(text))
    partial=bool(partial_marker.search(text))
    boundary=bool(boundary_marker.search(text))
    role_text=' | '.join(str(v) for v in roles.values())
    # A negative semantic/read boundary stored in a role/note can veto an
    # upgrade. It can never supply positive full evidence by itself.
    role_veto=bool(no_semantic.search(role_text) or boundary_marker.search(role_text))
    full_ranges=not unparsed_ranges and (not rs or (valid and set(i for a,b in rs for i in range(a,b+1))==set(range(1,n+1))))
    if explicit_full and not (nonsemantic or nav or partial or boundary or role_veto or scope_false) and full_ranges:
        kind='explicit-full' if unambiguous else 'full-claim-unbound-or-ambiguous'
    elif nonsemantic:
        kind='explicit-nonsemantic-or-hash-only'
    elif nav:
        kind='explicit-navigation-only'
    elif explicit_full:
        kind='full-word-vetoed-or-conflicting-scope'
    elif (selected_marker.search(text) or any(field_label(k) in range_keys for k in ranges)) and valid:
        kind='explicit-selected' if unambiguous else 'selected-claim-unbound-or-prior-sha'
    elif partial or boundary or role_veto:
        kind='limited-or-not-full-scope-unknown'
    elif scopes or ranges:
        kind='scope-unknown'
    else:
        kind='incidental-path-or-pin-object'
    return kind,evidence_hash,valid

# The above functions are the pinned49 metadata classifier, not product code.
old_scope_key=scope_key
new_scope_key=re.compile(r'^(?:coverage|review|scope|readscope|reviewscope|readcoverage|semanticcoverage|readingscope|coveragelabel|rawcoveragelabel|readscopeclaim|coverageclaimfromauthor|inspectionscope)$',re.I)
inspection_full=re.compile(r'^(?:(?:read|reviewed|inspected|examined)\s+)?(?:(?:entire|whole|full)[ -]+(?:(?:static|source|semantic)\s+)*(?:file|module))(?=$|[\s;,.：:])|^全文(?:静态)?(?:阅读|审查|读取)?(?=$|[\s;,.；，。：:])',re.I)
quote_marker=re.compile(r'quoted?|quotation|verbatim|excerpt|original[- _]?text|raw[- _]?text|citation|example|引用|引文|摘录|原文',re.I)
source_hash_labels={'sha','sha256','hash','sourcesha','sourcesha256','frozensha256','currentsha256','initialsemanticreadsha256','initialsha256','readtimesha256','endingsha256','beforesha256','aftersha256'}
proofs={};states={};field_deltas=[];field_objects=0;veto_counts=Counter();veto_witnesses={};inventory=[];errors=[];history_drift=[]
stats={'md':0,'json':0,'jsonObjects':0,'jsonArrays':0,'jsonScalars':0,'jsonStrings':0,'mdUTF8Chars':0,'opaqueCountOnlyJson':0,'candidateObjects':0,'inspectionScopeObjects':0}
current_doc='';current_cohort='';current_doc_sha='';started=UTC()

def fields(obj,adapted=False):
 global scope_key
 scope_key=new_scope_key if adapted else old_scope_key
 result=row_fields(obj)
 scope_key=old_scope_key
 return result

def classify_obj(path,located,obj,direct,origin,adapted,source_map):
 global current
 current=source_map
 scopes,ranges,roles,hashes=fields(obj,adapted)
 raw_scopes=scopes.copy();vetos=[]
 if adapted:
  inspect={k:v for k,v in scopes.items() if field_label(k.split('.')[0].split('[')[0])=='inspectionscope' or 'inspectionscope' in field_label(k)}
  if inspect:
   positive=[]
   for k,v in inspect.items():
    if v is False:vetos.append('false-inspection-flag')
    if isinstance(v,str):
     clear=bool(inspection_full.search(v.strip())) or v.strip().lower() in full_exact
     if not clear:vetos.append('no-clear-leading-full-label')
     if quote_marker.search(v):vetos.append('quoted-or-raw-text-scope')
     if clear and not quote_marker.search(v):positive.append(k)
   for k in positive:scopes[k]='full file; '+str(scopes[k])
   rt=' | '.join(str(v) for v in roles.values())
   if no_semantic.search(rt) or nav_marker.search(rt) or partial_marker.search(rt) or boundary_marker.search(rt):vetos.append('negative-role-scope')
   for k,v in roles.items():
    if v is False and field_label(k) in {'semanticreadperformed','readperformed','reviewed','semanticread'}:vetos.append('false-read-role-flag')
   for k,v in obj.items():
    if field_label(k) in {'role','purpose','kind','origin','note','notes'} and isinstance(v,str) and quote_marker.search(v):vetos.append('quoted-record-purpose')
   if any(field_label(k) not in source_hash_labels for k in hashes):vetos.append('non-source-hash-field')
   if vetos:scopes['reviewInspectionVeto']=False
 result=classification(path,located,scopes,ranges,roles,hashes,direct,origin)
 return result,raw_scopes,ranges,roles,hashes,sorted(set(vetos))

def add_state(bucket,kind,path,proof):
 if kind not in {'explicit-full','explicit-selected'}:return
 d=states.setdefault(bucket,{'full':set(),'selected':set()});k='full' if kind=='explicit-full' else 'selected';d[k].add(path)
 proofs.setdefault((bucket,k,path),proof)

def inspect_object(obj,ptr,extra_path=None,origin='object-scalar-field'):
 global field_objects
 direct={q for x in obj.values() if (q:=sourceish_path(x))}
 anchors={q for x in obj.values() if (q:=source_path(x))}
 if extra_path:
  direct.add(extra_path[0]);anchors.add(extra_path)
 if not anchors:return
 stats['candidateObjects']+=1
 has_inspect=any(field_label(k)=='inspectionscope' for k in obj) or any(isinstance(v,dict) and any(field_label(k2)=='inspectionscope' for k2 in v) for k,v in obj.items() if old_scope_key.fullmatch(field_label(k)))
 if has_inspect:stats['inspectionScopeObjects']+=1
 for path,located in anchors:
  if path not in fresh_map:continue
  proof={'document':current_doc,'documentSha256':current_doc_sha,'jsonPointer':ptr,'path':path,'sourceSha256':fresh_map[path]['sha256'],'origin':origin}
  a,os,ors,oro,oh,_=classify_obj(path,located,obj,direct,origin,False,fresh_map)
  b,ns,nrs,nro,nh,vs=classify_obj(path,located,obj,direct,origin,True,fresh_map)
  add_state(current_cohort+'-original',a[0],path,{**proof,'scopeFields':os,'sourceHashFields':oh,'ranges':ors})
  add_state(current_cohort+'-adapted',b[0],path,{**proof,'scopeFields':ns,'sourceHashFields':nh,'ranges':nrs})
  if current_cohort=='old49' and path in old_map:
   da,*_=classify_obj(path,located,obj,direct,origin,False,old_map)
   db,*_=classify_obj(path,located,obj,direct,origin,True,old_map)
   add_state('old49-dated-original',da[0],path,{**proof,'sourceSha256':old_map[path]['sha256'],'scopeFields':os,'sourceHashFields':oh,'ranges':ors})
   add_state('old49-dated-adapted',db[0],path,{**proof,'sourceSha256':old_map[path]['sha256'],'scopeFields':ns,'sourceHashFields':nh,'ranges':nrs})
  if has_inspect:
   for reason in vs:
    veto_counts[reason]+=1
    if reason not in veto_witnesses:veto_witnesses[reason]={**proof,'scopeFields':ns,'roleFields':nro,'sourceHashFields':nh}
   if a[0]!=b[0]:field_deltas.append({**proof,'oldKind':a[0],'adaptedKind':b[0],'hashBinding':b[1],'directPaths':sorted(direct),'located':located,'scopeFields':ns,'roleFields':nro,'sourceHashFields':nh,'rangeFields':nrs,'vetoReasons':vs})
 current=fresh_map

def walk(v,ptr='',count_only=False):
 if isinstance(v,dict):
  stats['jsonObjects']+=1
  if not count_only:inspect_object(v,ptr)
  for k,x in v.items():
   esc=str(k).replace('~','~0').replace('/','~1');q=source_path(k)
   if q and isinstance(x,dict) and not count_only:inspect_object(x,ptr+'/'+esc,q,'structured-path-key')
   walk(x,ptr+'/'+esc,count_only)
 elif isinstance(v,list):
  stats['jsonArrays']+=1
  for i,x in enumerate(v):walk(x,ptr+'/'+str(i),count_only)
 else:
  stats['jsonScalars']+=1
  if isinstance(v,str):stats['jsonStrings']+=1

opaque=base+'coverage-frontier/coverage-claims.json'
old_hr={x['path']:x for x in history_rows}
for rel in hpaths:
 current_doc=rel;b=(ROOT/rel).read_bytes();current_doc_sha=SHA(b);kind='json' if rel.lower().endswith('.json') else 'md'
 inventory.append({'path':rel,'bytes':len(b),'sha256':current_doc_sha,'kind':kind,'classification':'count-only-derived-claims' if rel==opaque else 'structured JSON metadata' if kind=='json' else 'MD byte/text inventory; no automatic full classification'})
 if rel in old_hr and old_hr[rel]['sha256']!=current_doc_sha:history_drift.append({'path':rel,'old49Sha256':old_hr[rel]['sha256'],'freshSha256':current_doc_sha,'kind':kind})
 current_cohort='old49' if rel in old_hpaths else 'round45' if rel.startswith('docs/audit-2026-10-17-round45/') else 'post49-pre45'
 try:
  if kind=='md':stats['md']+=1;stats['mdUTF8Chars']+=len(b.decode('utf-8'))
  else:
   stats['json']+=1
   if rel==opaque:stats['opaqueCountOnlyJson']+=1
   walk(json.loads(b),count_only=rel==opaque)
 except Exception as e:errors.append({'path':rel,'error':type(e).__name__+': '+str(e)})

def combine(*buckets):
 f=set();s=set()
 for bucket in buckets:
  d=states.get(bucket,{'full':set(),'selected':set()});f|=d['full'];s|=d['selected']
 return {'full':f,'selected':s-f,'unknown':set(fresh_map)-f-s}

def serial_state(d):return {k:sorted(v) for k,v in d.items()}
def counts(d):return {k:len(v) for k,v in d.items()}
oldfull={x['path'] for x in old_index if x['status']=='current-sha-explicit-full-object'};oldsel={x['path'] for x in old_index if x['status']=='current-sha-explicit-selected-object'}
redated=combine('old49-dated-original');adapt_dated=combine('old49-dated-adapted')
base_current=combine('old49-original');field_current=combine('old49-adapted');later_current=combine('old49-adapted','post49-pre45-adapted');all_current=combine('old49-adapted','post49-pre45-adapted','round45-adapted')
51full={x['path'] for x in map51.values() if x['coverageStatus']=='carryable-explicit-full'};sel51={x['path'] for x in map51.values() if x['coverageStatus']=='carryable-explicit-selected-no-full'}
invalid=[{'path':x['path'],'old49Status':x['status'],'old49Sha256':x['sha256'],'currentSha256':fresh_map.get(x['path'],{}).get('sha256'),'currentSourcePresent':x['path'] in fresh_map} for x in old_index if x['status'] in {'current-sha-explicit-full-object','current-sha-explicit-selected-object'} and (x['path'] not in fresh_map or x['sha256']!=fresh_map[x['path']]['sha256'])]
transitions=[]
for path in sorted(fresh_map):
 labels={name:('full' if path in d['full'] else 'selected' if path in d['selected'] else 'unknown') for name,d in [('old49-current',base_current),('plus-inspectionScope',field_current),('plus-frozen43-44',later_current),('plus-frozen45',all_current)]}
 if len(set(labels.values()))>1:
  refs=[]
  for bucket in ['old49-adapted','post49-pre45-adapted','round45-adapted']:
   for k in ['full','selected']:
    if (bucket,k,path) in proofs:refs.append({'cohort':bucket,'kind':k,**proofs[(bucket,k,path)]})
  transitions.append({'path':path,'sha256':fresh_map[path]['sha256'],'states':labels,'provenance':refs})
summary={'startedUTC':started,'finishedUTC':UTC(),'sourceFiles':len(fresh_map),'historyFiles':len(inventory),'historyStats':stats,'historyDriftVsOld49':history_drift,'parseErrors':errors,'original49Reproduction':{'full':len(redated['full']),'selectedNoFull':len(redated['selected']),'fullSetDifference':sorted(oldfull^redated['full']),'selectedSetDifference':sorted(oldsel^redated['selected'])},'old49DatedWithAdapter':counts(adapt_dated),'currentStages':{'old49OriginalReboundToCurrent':counts(base_current),'plusFieldAdapter':counts(field_current),'plusFrozen43and44':counts(later_current),'plusFrozen45':counts(all_current)},'status51Comparison':{'fullSetDifference':sorted(51full^base_current['full']),'selectedSetDifference':sorted(sel51^base_current['selected']),'meaning':'Exact51 carry sets compared to old49 original classifier bound to fresh current SHA; no new reading inferred.'},'inspectionScopeChangedObjects':len(field_deltas),'vetoReasons':dict(veto_counts),'shaInvalidatedPriorSemanticPaths':invalid,'noCoveragePercentage':True,'productSemanticReads':0,'productExecutions':0,'gitOperations':0,'unknownMeaning':'Conservative JSON metadata category, not unread/unfinished/bug count. MD-only/external/unrecognized evidence not exhaustive.'}
dump('history-inventory.json',{'capturedUTC':started,'finishedUTC':UTC(),'command':hcmd,'excluded':'exact46–57 directories; frozen45 included','files':inventory,'stats':stats,'countOnlyDerivedClaims':opaque})
dump('field-adapter-delta.json',{'scope':'Only objects containing inspectionScope; minimal exact fields/provenance, not old claims copy','objects':field_deltas,'vetoWitnesses':veto_witnesses})
dump('status-transitions.json',{'scope':'One current source path/SHA per row; attribution stages separated','rows':transitions,'counts':len(transitions)})
dump('summary.json',summary)
print(json.dumps(summary,ensure_ascii=False,indent=2))
