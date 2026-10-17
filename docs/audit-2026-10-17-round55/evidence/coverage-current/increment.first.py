from pathlib import Path
import json,hashlib,re,collections,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round121-coverage-refresh');now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
def save(n,v):(O/n).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
inv=json.loads((O/'current-source-inventory.json').read_text());cur={x['path']:x for x in inv['files']};docs=json.loads((O/'increment-manifest-inventory.json').read_text())['files'];states={p:x['carryForwardCoverage']for p,x in cur.items()};claims=[];reject=[];allrows=0
key=lambda k:re.sub('[^a-z]','',k.lower())
sha_keys={'sha256','currentsha256','frozensha256','frozensourcesha256','firstsha256','initialsha256','beforesha256','aftersha256','firstreadsha256','endingsha256','initialfilesystemsha256','finishfilesystemsha256','initialsemanticreadsha256','finishsha256'}
range_keys={'selectedlineranges','readranges','readlineranges','semanticlineranges','semanticreadranges','selectedranges'}
scope_keys={'coverage','review','scope','readscope','inspectionscope','reviewmode','readcoverage','semanticcoverage'}
fulltag=re.compile(r'^(?:full(?:[- ](?:file|module|static(?:[- ](?:leaf|file|module))?|source(?:[- ]file)?|semantic(?:[- ](?:read|file))?))?|whole[- ]file|entire[- ]file|全文(?:静态)?(?:阅读|审查|读取)?)(?:$|[;:,.，；：。\s])',re.I)
nonsemantic=re.compile(r'hash[- _]?only|pin[- _]?only|metadata[- _]?only|incidental|navigation[- _]?only|nav[- _]?only|no[- _]?semantic|zero[- _]?semantic|not semantically|not (?:body[- ]?)?read|display[- _]?only|only (?:displayed|hashed)|仅哈希|不计语义',re.I)
partial=re.compile(r'\bselected\b|\bpartial\b|\bnot[- ]full\b|\bno full\b|not (?:the )?(?:entire|whole)|选段|部分|非全文|未全文',re.I)
boundary=re.compile(r'mechanism[- ](?:boundary|only)|boundary[- ]only|authority[- ]only|机制边界|机制止|权限未审|不展开机制',re.I)
def parse_ranges(v):
 if v is None or v==[]:return [],True
 if isinstance(v,list):
  if len(v)==2 and all(type(i)is int for i in v):return [v],True
  out=[]
  for z in v:
   q,ok=parse_ranges(z)
   if not ok:return [],False
   out+=q
  return out,True
 if isinstance(v,dict):
  a=v.get('start',v.get('from'));b=v.get('end',v.get('to'))
  return ([[a,b]],True)if type(a)is int and type(b)is int else([],False)
 if isinstance(v,str)and re.fullmatch(r'[\s\[\]L0-9,;–—:-]+',v):
  ms=re.findall(r'L?(\d+)\s*[-–—:]\s*L?(\d+)',v)
  return ([[int(a),int(b)]for a,b in ms],bool(ms))
 return [],False
for d in docs:
 b=(R/d['path']).read_bytes();assert len(b)==d['bytes']and hashlib.sha256(b).hexdigest()==d['sha256'];v=json.loads(b)
 # Canonical normalized active rows only. No recursive scalar/historical copies, outer source pins, or hashOnly/navigation collections.
 rows=v.get('files',[])if isinstance(v,dict)else[]
 if not isinstance(rows,list):reject.append(dict(document=d['path'],reason='files-not-array; schema deferred'));continue
 ancestor={k:v[k]for k in ['scope','coverageLimit','coverageBoundary','boundary','limitations','consumerCoverageLimits','oldFullAllowedScope']if k in v}
 ancestor_txt=' | '.join(x for x in ancestor.values()if isinstance(x,str))
 zero_ancestor=any(v.get(k) is not None and type(v.get(k))is int and v[k]==0 for k in ['newProductSemanticLines','newSourceSemanticLines','productSourceBodiesRead'])
 for i,row in enumerate(rows):
  if not isinstance(row,dict):continue
  p=row.get('path')
  if p not in cur:continue
  allrows+=1;n=cur[p]['lines'];sc={k:x for k,x in row.items()if key(k)in scope_keys and isinstance(x,(str,bool,int,float))};role={k:x for k,x in row.items()if key(k)in {'purpose','note','notes','role','kind','readnote','scopeboundary','readboundary'}and isinstance(x,(str,bool,int,float))};txt=' | '.join(str(x)for x in sc.values());rt=' | '.join(str(x)for x in role.values());h={k:x.lower()for k,x in row.items()if key(k)in sha_keys and isinstance(x,str)and re.fullmatch('[0-9a-fA-F]{64}',x)};rs=[];valid=True
  for k,x in row.items():
   if key(k)in range_keys:
    q,ok=parse_ranges(x);rs+=q;valid&=ok
  if rs:valid&=all(1<=a<=z<=n for a,z in rs)
  rsset={j for a,z in rs for j in range(a,z+1)}if valid else set()
  nums={k:x for k,x in row.items()if key(k)in {'semanticlinecount','semanticlines','coveredlinecount','semanticreadlinecount','semanticproductlines','testdeclarationlinecount'}and type(x)is int}
  flags={k:x for k,x in row.items()if key(k)in {'semanticread','semanticreadperformed','readperformed','reviewed'}and type(x)is bool}
  proof=dict(document=d['path'],documentSha256=d['sha256'],pointer='/files/'+str(i),path=p,currentSha256=cur[p]['sha256'],sourceHashFields=h,scopeFields=sc,roleFields=role,semanticRanges=rs,semanticCounts=nums,ancestorLimits=ancestor)
  reasons=[]
  if not h or set(h.values())!={cur[p]['sha256']}:reasons.append('no-unique-current-same-object-source-sha')
  if nonsemantic.search(txt+' | '+rt)or any(x is False for x in flags.values())or(nums and all(x==0 for x in nums.values()))or zero_ancestor:reasons.append('nonsemantic-or-zero-read-declaration')
  if not valid:reasons.append('semantic-range-invalid-or-unparsed')
  full=any(isinstance(x,str)and fulltag.search(x.strip())for x in sc.values());sel=bool(partial.search(txt))or bool(rs)
  veto=bool(partial.search(txt+' | '+rt)or boundary.search(txt+' | '+rt)or re.search(r'not[- ]full|no full|metadata[- ]only|hash[- ]only|zero semantic',ancestor_txt,re.I))
  if reasons:
   reject.append(dict(**proof,reason=reasons));continue
  kind=None
  # A full label alone without an explicit complete semantic range/count is intentionally deferred.
  complete=rsset==set(range(1,n+1))if rs else any(x==n for x in nums.values())
  if full and complete and not veto:kind='full'
  elif rsset and (sel or full):kind='selected'
  if kind:
   proof.update(kind=kind,purposeRetained=True,fullVetoedByLimits=bool(full and veto),fullLabel=full,semanticRangeComplete=complete);claims.append(proof)
  else:reject.append(dict(**proof,reason=['no-unambiguous-explicit-semantic-full-or-selected-record'],fullLabel=full,rangeComplete=complete,fullVeto=veto))
# Union by exact current path/SHA, full has precedence; no summing read lines or author/reviewer copies.
rank={'unknown':0,'selected':1,'full':2}
for c in claims:
 if rank[c['kind']]>rank[states[c['path']]]:states[c['path']]=c['kind']
changes=[]
for p in sorted(states):
 if states[p]!=cur[p]['carryForwardCoverage']:
  witnesses=[x for x in claims if x['path']==p and x['kind']==states[p]]
  witnesses.sort(key=lambda x:(len(x['document']),x['document'],x['pointer']))
  changes.append(dict(path=p,sha256=cur[p]['sha256'],before=cur[p]['carryForwardCoverage'],after=states[p],witness=witnesses[0],supportingClaimCount=len(witnesses)))
save('increment-claims.json',dict(createdAt=now(),method='Strict active top-level .files only in64 canonical source-manifest-named documents46..53; direct same-object unique current source SHA; explicit semantic ranges/counts; no display/full-gate/hash-only/ancestral/historical positive inference; complex schemas deferred',documents=len(docs),sourceRowsConsidered=allrows,acceptedClaimCount=len(claims),acceptedClaims=claims,deferredOrRejectedRows=reject,globalCountsAreNotPercentOrUnread=True))
save('unified-current-index.json',dict(createdAt=now(),rootReportedMetadataBaseline='0d2d5418b0b4821fdb11dc87e328fce7e1f2433e',rootLaterDocsOnlyHead='00c046367769349c1f5413e74c993b2c19ce8337',gitCertified=False,sourceSemanticReads=0,scope='Frozen45 reconstructed exact records plus conservative explicit active canonical manifests46..53 bound to current SHA;54+ excluded',files=[dict(**cur[p],mergedConservativeCoverage=states[p])for p in sorted(cur)]))
summary=dict(createdAt=now(),sourceUniverse=len(cur),frozen45Counts=json.loads((O/'base-reconstruction.json').read_text())['frozen45Counts'],conservativeCurrentCarryForward=dict(collections.Counter(x['carryForwardCoverage']for x in cur.values())),afterConservative46to53=dict(collections.Counter(states.values())),changedPaths=len(changes),transitions=changes,manifestDocuments=len(docs),sourceRowsConsidered=allrows,acceptedClaims=len(claims),deferredOrRejectedRows=len(reject),limits=['No full-history scalar or MD-only reclassification; no author method execution or product body read.','Only explicit semantic whole/range records recognized. Hash/nav/display/first-full exclusions and ambiguous ancestor limits never upgrade full; complex or missing fields remain unconfirmed.','Same-source author/reviewer/formalization duplicates are deduplicated by path/SHA; no sum of line/file readings.','Full records retain original purpose and mechanism limits and are not all-contract completeness or runtime validation. Unknown is not unread/unfinished or bug count.'])
save('increment-summary.json',summary)
print(json.dumps({k:v for k,v in summary.items()if k!='transitions'},ensure_ascii=False))
for c in changes:print(json.dumps(dict(path=c['path'],before=c['before'],after=c['after'],witnessDocument=c['witness']['document'],pointer=c['witness']['pointer'],scope=c['witness']['scopeFields'],ranges=c['witness']['semanticRanges'],counts=c['witness']['semanticCounts'],ancestorLimits=c['witness']['ancestorLimits']),ensure_ascii=False))
