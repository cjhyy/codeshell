# Metadata only: never launches tests, platform adapters, network or native product processes.
from pathlib import Path
import hashlib, json, subprocess
root = Path(__file__).resolve().parents[3]
out = Path(__file__).resolve().parent
base = "b8b776d56e5982e59b18de0262d5c49367746625"
selected = [
 ("CODESHELL.md", "full instruction read"),
 ("packages/chat/src/channel.ts", "full helper read and real execution"),
 ("packages/chat/src/channel.test.ts", "full read and existing guarded baseline execution"),
 ("packages/chat/src/notification-progress.ts", "full helper read; memory progress execution; File store static only"),
 ("packages/chat/src/notification-progress.test.ts", "source read only; no security/permission/custody tests executed"),
 ("packages/chat/src/attachments.ts", "full ordinary metadata helper read; no bytes loading execution"),
 ("packages/chat/src/media.ts", "full source read; no download/upload/security execution"),
 ("packages/chat/src/media.test.ts", "source read only; no network/security tests executed"),
 ("packages/chat/src/protocol.ts", "full protocol declaration read"),
 ("packages/chat/src/lifecycle.ts", "full helper read; format candidate not tested"),
 ("packages/chat/src/notification-relay.ts", "ordinary handler/splitter/validation directed read; real in-memory notification execution; file materialization not executed"),
 ("packages/chat/src/notification-relay.test.ts", "directed source read of first 225 lines; tests not executed"),
 ("packages/chat/src/gateway.ts", "directed text/button projection read"),
 ("packages/chat/src/mattermost.ts", "full source read; no adapter execution or platform/socket/network"),
 ("packages/chat/src/wecom.ts", "full source read; no adapter/SDK execution"),
 ("packages/chat/src/dingtalk.ts", "full source read; no adapter/SDK execution"),
 ("packages/chat/src/wechat.ts", "directed send formatting/chunk path source read; no adapter execution"),
 ("packages/chat/src/desktop-control-client.ts", "directed source read; watchEvents prototype method only with page/sleep callbacks; no constructor/request/descriptor/spawn/checkpoint"),
 ("packages/chat/src/cli.ts", "directed production watcher wiring source read; not executed"),
 ("packages/chat/src/config.ts", "directed target count/shape source read; not executed"),
 ("packages/chat/README.md", "notification contract excerpt read"),
 ("packages/pet/src/host-actions.ts", "directed GatewayReply limits/schema source search; not executed"),
 ("packages/desktop/src/main/im-gateway-service.ts", "directed production watcher wiring source read; not executed"),
 ("scripts/run-bun-test-shard.mjs", "actual guarded test entry for both first shards"),
]
files=[]
for name,scope in selected:
 frozen=subprocess.check_output(["git","show",f"{base}:{name}"],cwd=root)
 current=(root/name).read_bytes()
 files.append({"path":name,"frozenSha256":hashlib.sha256(frozen).hexdigest(),"currentSha256":hashlib.sha256(current).hexdigest(),"currentMatchesFrozen":current==frozen,"scope":scope})
(out/"chat-source-manifest.json").write_text(json.dumps({"sourceCommit":base,"files":files,"limitations":"Selected source receipts do not imply full-module dynamic or full repository coverage. Native Node/Bun built-ins only; no imported SDK, installed third-party runtime or real platform used by fixtures."},ensure_ascii=False,indent=2)+"\n")
artifacts=[]
for p in sorted(out.parent.rglob("*")):
 if p.is_file() and (p.name.startswith("chat-") or p.name=="chat.md") and p.name!="chat-artifact-receipt.json":
  b=p.read_bytes();artifacts.append({"path":str(p.relative_to(root)),"bytes":len(b),"sha256":hashlib.sha256(b).hexdigest()})
(out/"chat-artifact-receipt.json").write_text(json.dumps({"sourceCommit":base,"files":artifacts,"summary":{"formalFindings":1,"staticCandidates":1,"firstBunShards":2,"cleanPass":6,"expect":91,"fail":0,"skipped":0,"failedBunShards":0,"frozenSourceFiles":len(files)},"metadataOnly":True},ensure_ascii=False,indent=2)+"\n")
print(json.dumps({"sources":len(files),"allCurrentSourcesMatchFrozen":all(x["currentMatchesFrozen"] for x in files),"artifactFiles":len(artifacts)},ensure_ascii=False))
