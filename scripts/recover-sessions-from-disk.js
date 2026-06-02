/**
 * 一次性恢复脚本 —— 在桌面应用的 DevTools Console 里运行(Cmd+Opt+I → Console → 整段粘贴回车)。
 *
 * 作用:把 disk 上所有「顶层」会话(state.json 已补 parentSessionId,含 automation 新闻汇总)
 * 按 cwd 归到现有/新建项目,合并写回 localStorage 的 repos + sessionIndex —— 不覆盖现有数据。
 * 纯 localStorage API,零损坏风险;不动 leveldb 文件,不用退应用。跑完刷新/重启应用即可在侧边栏看到。
 *
 * 幂等:重复跑不会重复(按 engineSessionId 去重;repo 按 path 去重)。
 */
(async () => {
  const REPOS_KEY = "codeshell.repos";
  const NO_REPO_KEY = "__no_repo__";
  const indexKey = (repoKey) => `codeshell.sessionIndex.${repoKey}`;

  const get = (k, fb) => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : fb; } catch { return fb; } };
  const set = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const norm = (p) => (p || "").replace(/\/+$/, ""); // 末尾斜杠归一(大小写这里不折叠,macOS 路径通常一致)

  // 1) 从 disk 拉全部顶层会话(分页,调已接好的 IPC)
  const all = [];
  let cursor = undefined;
  for (let i = 0; i < 100; i++) {
    const page = await window.codeshell.listDiskSessions({ limit: 50, cursor });
    all.push(...page.sessions);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  console.log(`[recover] disk 顶层会话: ${all.length} 个`);
  if (all.length === 0) { console.log("[recover] 无可恢复会话,结束。"); return; }

  // 2) 现有 repos(按 path 去重),建 path→repoId 映射
  const repos = get(REPOS_KEY, []);
  const byPath = new Map(repos.map((r) => [norm(r.path), r.id]));
  const newRepoId = () => "r-" + Math.random().toString(36).slice(2, 10);

  // 3) 按 cwd 归 repo;无匹配则新建。NO-cwd 归 __no_repo__(对话区)
  const placements = []; // {repoKey, summary}
  let createdRepos = 0;
  for (const s of all) {
    const cwd = norm(s.cwd);
    let repoKey;
    if (!cwd) {
      repoKey = NO_REPO_KEY;
    } else if (byPath.has(cwd)) {
      repoKey = byPath.get(cwd);
    } else {
      const id = newRepoId();
      const name = cwd.split("/").filter(Boolean).pop() || cwd;
      repos.push({ id, name, path: cwd, addedAt: Date.now() });
      byPath.set(cwd, id);
      repoKey = id; createdRepos++;
    }
    placements.push({
      repoKey,
      summary: {
        id: s.id,
        title: (s.title || s.id).slice(0, 60),
        createdAt: s.updatedAt,
        updatedAt: s.updatedAt,
        engineSessionId: s.engineSessionId,
      },
    });
  }

  // 4) 合并写回每个 repo 的 sessionIndex(按 engineSessionId 去重,updatedAt 降序)
  const touched = new Set(placements.map((p) => p.repoKey));
  let added = 0;
  for (const repoKey of touched) {
    const idx = get(indexKey(repoKey), { sessions: [], activeSessionId: null });
    const mine = placements.filter((p) => p.repoKey === repoKey).map((p) => p.summary);
    const existingEng = new Set(idx.sessions.map((x) => x.engineSessionId).filter(Boolean));
    const fresh = mine.filter((m) => !existingEng.has(m.engineSessionId));
    added += fresh.length;
    idx.sessions = [...idx.sessions, ...fresh].sort((a, b) => b.updatedAt - a.updatedAt);
    set(indexKey(repoKey), idx);
  }
  set(REPOS_KEY, repos);

  console.log(`[recover] 完成:新增会话 ${added} 个,新建项目 ${createdRepos} 个,涉及项目 ${touched.size} 个。`);
  console.log("[recover] 现在刷新页面(Cmd+R)或重启应用,侧边栏即可看到恢复的会话。");
})();
