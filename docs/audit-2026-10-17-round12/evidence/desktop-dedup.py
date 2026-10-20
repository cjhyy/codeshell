"""Historical Markdown and parsed JSON search only; no product execution."""
import json, pathlib, re
ROOT=pathlib.Path(__file__).resolve().parents[3]
patterns={
 "diff_parser":r"parseUnifiedDiff|UnifiedDiffViewer|gitPath\(",
 "header_only":r"(?:binary|二进制|mode.only|权限位|chmod|mode.change|empty.file|空文件).{0,160}(?:diff|差异|路径|path|unknown)|(?:diff|差异|路径|path|unknown).{0,160}(?:binary|二进制|mode.only|权限位|chmod|mode.change|empty.file|空文件)",
 "file_byte_label":r"FileToolCard|content[.]length.{0,80}(?:bytes?|字节|B[)])|(?:Write|写入|工具卡).{0,80}(?:UTF.16|byte.{0,10}count|字节数)",
 "utils":r"tool-cards/utils\.ts|formatDuration|prettyJson|classifyBashLines|keyboardShortcutHints|formatModifierShortcut",
 "truncate_unicode":r"(?:truncate|截断).{0,100}(?:surrogate|UTF.16|emoji|代理|Unicode)|(?:surrogate|UTF.16|emoji|代理|Unicode).{0,100}(?:truncate|截断)",
}
compiled={k:re.compile(v,re.I) for k,v in patterns.items()}
hits={k:[] for k in patterns}; counts={k:0 for k in patterns}; scan={"markdownFiles":0,"jsonFiles":0,"jsonStringLeaves":0}; errors=[]
def leaves(v,l="$ "):
 if isinstance(v,str): yield l,v
 elif isinstance(v,list):
  for i,x in enumerate(v): yield from leaves(x,f"{l}[{i}]")
 elif isinstance(v,dict):
  for k,x in v.items(): yield from leaves(x,f"{l}.{k}")
for directory in (ROOT/"docs",ROOT/"bugs"):
 for p in sorted(directory.rglob("*")):
  if not p.is_file() or p.suffix not in (".md",".json"): continue
  rel=p.relative_to(ROOT).as_posix()
  if rel.startswith("docs/audit-2026-10-17-round12/"):continue
  try:
   s=p.read_text()
   if p.suffix==".json":
    scan["jsonFiles"]+=1; units=list(leaves(json.loads(s))); scan["jsonStringLeaves"]+=len(units)
   else: scan["markdownFiles"]+=1; units=[("$",s)]
   for loc,s in units:
    for k,pat in compiled.items():
     for m in pat.finditer(s):
      counts[k]+=1
      if len(hits[k])<150:hits[k].append({"file":rel,"location":loc,"snippet":s[max(0,m.start()-100):m.end()+260]})
  except Exception as e: errors.append({"file":rel,"error":str(e)})
out={"frozenSource":"d5fae44358b3a92d4d02fd5fcc4ac21c56b2a08a","scope":"All Markdown and parsed JSON in docs/bugs, including archive/_archive; round12 excluded","patterns":patterns,"scanned":scan,"parseErrors":errors,"matchCounts":counts,"maxContextsPerPattern":150,"hits":hits}
path=pathlib.Path(__file__).with_suffix(".json"); path.write_text(json.dumps(out,ensure_ascii=False,indent=2)+"\n")
print(json.dumps({"output":str(path.relative_to(ROOT)),"scanned":scan,"parseErrors":errors,"matchCounts":counts}))
