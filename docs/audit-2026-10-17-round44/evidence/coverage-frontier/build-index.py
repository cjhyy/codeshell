from pathlib import Path
import datetime, hashlib, json, re, subprocess
from collections import Counter

ROOT = Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT = Path('/tmp/codeshell-audit-round49-coverage-frontier')
UTC = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
SHA = lambda b: hashlib.sha256(b).hexdigest()
def dump(name, value):
    (OUT / name).write_text((json.dumps(value, ensure_ascii=False, separators=(',',':')) if name in {'coverage-claims.json','coverage-index.json'} else json.dumps(value, ensure_ascii=False, indent=2)) + '\n')
def rg_files(*args):
    p = subprocess.run(['rg', '--files', '--hidden', *args], cwd=ROOT, capture_output=True, text=True, check=True)
    return sorted(set(p.stdout.splitlines()))
# Reuse the first dated byte inventories for this metadata classifier revision.
source_inventory = json.loads((OUT/'package-inventory.json').read_text())
source_rows = source_inventory['files']
source_paths = [r['path'] for r in source_rows]
current = {r['path']:r for r in source_rows}
hp = json.loads((OUT/'history-inventory.json').read_text())
history_rows = hp['files']
history_paths = [r['path'] for r in history_rows]
excluded = hp['excluded']
all_history = history_paths + excluded
excluded_prefixes = tuple(hp['excludedPrefixes'])

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

def add_claim(path,located,obj,ptr,origin,direct_paths,ancestor=None):
    scopes,ranges,roles,hashes=row_fields(obj)
    kind,hash_binding,valid=classification(path,located,scopes,ranges,roles,hashes,direct_paths,origin)
    ancestor_hashes={}
    if not hashes and ancestor:
        ap,ao=ancestor
        aps={v for x in ao.values() if (v:=sourceish_path(x))}
        _,_,_,ah=row_fields(ao)
        if len(aps)==1 and path in aps and len(set(ah.values()))==1:
            ancestor_hashes={'pointer':ap,'hashFields':ah,'binding':'pending-only; never used for explicit-full or selected activation'}
    # Retain minimal exact scope fields; no whole historical object/context copy.
    claim={'path':path,'sourceHashFields':hashes,'hashBinding':hash_binding,'coverageKind':kind,'scopeFields':scopes,'rangeFields':ranges,'rangeBoundsValidForCurrent':valid,'roleBoundaryFields':roles,'sourcePathIncludesLocator':located,'directSourcePathsInObject':sorted(direct_paths),'origin':origin}
    if ancestor_hashes:claim['narrowAncestorHashPending']=ancestor_hashes
    key=json.dumps(claim,ensure_ascii=False,sort_keys=True)
    if key not in all_claims:all_claims[key]=dict(claim,provenance=[])
    prov={'historyRow':history_row_index[CURRENT_DOC],'jsonPointer':ptr}
    if prov not in all_claims[key]['provenance']:all_claims[key]['provenance'].append(prov)
    anchor_counts[origin]+=1

def walk(v,ptr='',ancestor=None,in_list=False):
    global scalar_count,string_count,object_count
    if isinstance(v,dict):
        object_count+=1
        anchors=[]
        for k,x in v.items():
            q=source_path(x)
            if q:anchors.append((str(k),q))
        direct={q for x in v.values() if (q:=sourceish_path(x))}
        for k,(p,loc) in anchors:add_claim(p,loc,v,ptr,'object-scalar-field',direct,ancestor)
        for k,x in v.items():
            q=source_path(k)
            escaped=str(k).replace('~','~0').replace('/','~1')
            if q and isinstance(x,dict):add_claim(q[0],q[1],x,ptr+'/'+escaped,'structured-path-key',{q[0]}|{z for value in x.values() if (z:=sourceish_path(value))},(ptr,v))
            yield_dummy=None
            walk(x,ptr+'/'+escaped,(ptr,v),False)
    elif isinstance(v,list):
        for i,x in enumerate(v):walk(x,ptr+'/'+str(i),ancestor,True)
    else:
        scalar_count+=1
        if isinstance(v,str):
            string_count+=1
            q=source_path(v)
            if q and in_list:add_claim(q[0],q[1],{},ptr,'list-scalar',{q[0]},ancestor)

for hr in history_rows:
    if hr['kind']!='json':continue
    CURRENT_DOC=hr['path'];CURRENT_DOC_SHA=hr['sha256']
    try:
        b=(ROOT/CURRENT_DOC).read_bytes()
        if SHA(b)!=CURRENT_DOC_SHA:raise ValueError('dated bytes changed before JSON metadata parsing')
        walk(json.loads(b))
    except Exception as e:errors.append({'path':CURRENT_DOC,'error':repr(e)})
claims=sorted(all_claims.values(),key=lambda c:(c['path'],c['coverageKind'],json.dumps(c['scopeFields'],sort_keys=True)))
for i,c in enumerate(claims):c['claimId']=f'C{i+1:06d}'
dump('coverage-claims.json', {'createdUTC':UTC(),'sourceInventorySnapshotUTC':source_inventory['capturedUTC'],'sourceInventory':'package-inventory.json','currentShaMeaning':'Current at captured snapshot only; separate ending checks are required.','provenanceRegistry':{'file':'history-inventory.json','collection':'files','historyRow':'zero-based exact row index; path/document SHA are stored once there'},'scope':'Deduplicated JSON source-row claims only; MD prose not classified. Positive full requires clear explicit scope plus unique same-object source SHA matching current filesystem. Narrow ancestor hash is pending-only. Source words never parsed.','claims':claims})
by_path={}
for c in claims:by_path.setdefault(c['path'],[]).append(c)
index=[]
for r in source_rows:
    cs=by_path.get(r['path'],[])
    fs=[c for c in cs if c['coverageKind']=='explicit-full']
    ss=[c for c in cs if c['coverageKind']=='explicit-selected']
    selected=set(i for c in ss for values in c['rangeFields'].values() for a,b in values for i in range(a,b+1))
    status='current-sha-explicit-full-object' if fs else 'current-sha-explicit-selected-object' if ss else 'historical-object-no-current-explicit-semantic-coverage' if cs else 'no-row-in-this-json-object-index-unknown'
    index.append(dict(r,status=status,currentExplicitFullClaimIds=[c['claimId']for c in fs],currentExplicitSelectedClaimIds=[c['claimId']for c in ss],currentSelectedUnionLines=len(selected),claimIds=[c['claimId']for c in cs],claimKindCounts=dict(Counter(c['coverageKind']for c in cs))))
dump('coverage-index.json', {'createdUTC':UTC(),'sourceInventorySnapshotUTC':source_inventory['capturedUTC'],'sourceInventory':'package-inventory.json','currentShaMeaning':'Current at captured snapshot only; separate ending checks are required.','scope':'Current TS/TSX filesystem bytes joined to conservative explicit historical JSON row claims. No-row is unknown, never unread. MD-only full is not exhaustive here; all later source candidates still need precise MD+JSON prior-cause/full gate. Pending tmp semantic reads are not backfilled.','files':index})
summary={'createdUTC':UTC(),'sourceFiles':len(source_rows),'sourceBytes':sum(r['bytes']for r in source_rows),'history':{'discovered':len(all_history),'included':len(history_rows),'excluded':len(excluded),'md':sum(r['kind']=='md'for r in history_rows),'json':sum(r['kind']=='json'for r in history_rows),'jsonStringValues':string_count,'jsonScalarValues':scalar_count,'jsonObjects':object_count,'parseOrDriftErrors':errors,'archiveBySubstring':sum('archiv'in p.lower()for p in history_paths),'archiveExactDirectory':sum(any(s in ['archive','archives']for s in Path(p).parts)for p in history_paths),'frozen42Included':any(p.startswith('docs/audit-2026-10-17-round42/')for p in history_paths)},'anchorsBeforeDedup':dict(anchor_counts),'deduplicatedClaims':len(claims),'provenanceReferences':sum(len(c['provenance'])for c in claims),'claimKinds':dict(Counter(c['coverageKind']for c in claims)),'fileStatuses':dict(Counter(r['status']for r in index)),'noCoveragePercentage':True,'productReads':'byte length / SHA / splitlines only;0 body semantic reading','productAttempts':0,'gitCommands':0,'network':0}
dump('summary.json',summary)
print(json.dumps(summary,ensure_ascii=False,indent=2))
