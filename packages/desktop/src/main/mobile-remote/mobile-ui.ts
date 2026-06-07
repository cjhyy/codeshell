export function mobileRemoteHtml(): string {
  return `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>CodeShell Mobile Remote</title>
  <style>
    :root {
      --bg: #0b0f17; --panel: #111827; --panel2: #0e1420; --border: #243042;
      --fg: #e5e7eb; --muted: #9aa6b6; --accent: #60a5fa; --accent-ink: #06111f;
      --ok: #4ade80; --warn: #fbbf24; --err: #f87171; --danger: #fca5a5;
    }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    html, body { margin: 0; height: 100%; }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
      font-size: 16px; background: var(--bg); color: var(--fg);
      /* 100dvh = dynamic viewport: shrinks when the on-screen keyboard opens,
         so the composer stays visible above it (iOS Safari / Android Chrome). */
      display: flex; flex-direction: column; height: 100dvh;
      overscroll-behavior: none;
    }
    /* Center + cap width on wide screens (landscape phone / tablet / desktop
       browser); full-bleed on a normal portrait phone. */
    @media (min-width: 680px) {
      body { max-width: 860px; margin: 0 auto; border-left: 1px solid var(--border); border-right: 1px solid var(--border); }
    }
    /* top bar */
    header {
      display: flex; align-items: center; gap: 8px; padding: 10px 14px;
      border-bottom: 1px solid var(--border); background: var(--panel2);
      padding-top: max(10px, env(safe-area-inset-top));
    }
    header .title { font-weight: 700; font-size: 15px; }
    header .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
    header .dot.ok { background: var(--ok); }
    header .dot.run { background: var(--warn); animation: pulse 1s infinite; }
    header .dot.err { background: var(--err); }
    @keyframes pulse { 50% { opacity: .35; } }
    header .spacer { flex: 1; }
    header .meta { font-size: 11px; color: var(--muted); }
    .iconbtn {
      border: 1px solid var(--border); background: transparent; color: var(--muted);
      border-radius: 8px; padding: 8px 12px; font-size: 13px; min-height: 36px;
    }
    /* session bar */
    .sessionbar {
      display: flex; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--border);
      align-items: center; font-size: 12px; color: var(--muted); overflow-x: auto;
    }
    .sessionbar .sid { color: var(--fg); font-family: ui-monospace, monospace; }
    /* feed */
    main { flex: 1; overflow-y: auto; padding: 12px 12px 4px; -webkit-overflow-scrolling: touch; }
    .row { margin: 8px 0; display: flex; }
    .row.user { justify-content: flex-end; }
    .bubble {
      max-width: 86%; padding: 9px 12px; border-radius: 14px; font-size: 14px;
      line-height: 1.45; white-space: pre-wrap; word-break: break-word;
    }
    .user .bubble { background: var(--accent); color: var(--accent-ink); border-bottom-right-radius: 4px; }
    .assistant .bubble { background: var(--panel); border: 1px solid var(--border); border-bottom-left-radius: 4px; }
    .card {
      max-width: 100%; background: var(--panel); border: 1px solid var(--border);
      border-radius: 12px; padding: 10px 12px; font-size: 13px;
    }
    .card .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
    .card .mono { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
    .tool .k { color: var(--accent); }
    .sys { color: var(--muted); font-size: 12px; font-style: italic; }
    .err .k, .err .mono { color: var(--err); }
    /* approval card */
    .approval { border-color: var(--warn); }
    .approval.high { border-color: var(--err); background: #1a0f12; }
    .approval .risk { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
    .approval .risk.low { background: #14321f; color: var(--ok); }
    .approval .risk.medium { background: #3a2e10; color: var(--warn); }
    .approval .risk.high { background: #3a1414; color: var(--err); }
    .approval .actions { display: flex; gap: 8px; margin-top: 10px; }
    .approval button { flex: 1; padding: 9px; border-radius: 10px; border: 0; font-weight: 700; }
    .approval .approve { background: var(--accent); color: var(--accent-ink); }
    .approval .reject { background: transparent; border: 1px solid var(--border); color: var(--fg); }
    .approval.high .approve { background: var(--err); color: #1a0a0a; }
    .approval .resolved { margin-top: 8px; color: var(--muted); font-size: 12px; }
    /* composer */
    footer {
      border-top: 1px solid var(--border); background: var(--panel2);
      padding: 10px 12px; padding-bottom: max(10px, env(safe-area-inset-bottom));
    }
    footer .hint { font-size: 11px; color: var(--muted); margin-bottom: 6px; }
    footer .inputrow { display: flex; gap: 8px; align-items: flex-end; }
    textarea {
      flex: 1; min-width: 0; min-height: 44px; max-height: 140px; resize: none;
      border-radius: 12px; border: 1px solid var(--border); background: var(--panel);
      /* 16px: iOS Safari auto-zooms the page when focusing an input <16px. */
      color: var(--fg); padding: 11px 12px; font-size: 16px; font-family: inherit; line-height: 1.4;
    }
    footer .send { border: 0; border-radius: 12px; background: var(--accent); color: var(--accent-ink); padding: 0 16px; height: 44px; font-weight: 700; }
    footer .send:disabled { opacity: .4; }
    footer .stop { border: 1px solid var(--err); color: var(--err); background: transparent; border-radius: 12px; padding: 0 14px; height: 44px; font-weight: 700; }
    .center { text-align: center; color: var(--muted); padding: 24px 12px; font-size: 13px; }
    /* rooms overlay */
    .overlay { position: fixed; inset: 0; background: var(--bg); z-index: 20; display: flex; flex-direction: column; padding-top: max(0px, env(safe-area-inset-top)); }
    .overlay-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--border); }
    .overlay-head .title { font-weight: 700; flex: 1; }
    .overlay-body { flex: 1; overflow-y: auto; padding: 12px 14px; }
    .rowbtn { display: block; width: 100%; text-align: left; padding: 12px; margin-bottom: 8px; border-radius: 10px; border: 1px solid var(--border); background: var(--panel); color: var(--fg); font-size: 14px; }
    .roomitem { display: flex; align-items: center; gap: 8px; padding: 11px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--panel); margin-bottom: 8px; }
    .roomitem .nm { font-weight: 600; }
    .roomitem .cwd { color: var(--muted); font-size: 11px; word-break: break-all; }
    .roomitem .mode { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: #14233a; color: var(--accent); }
    .roomitem .mode.danger { background: #3a1414; color: var(--danger); }
    .roomitem .open { font-size: 10px; color: var(--ok); }
    .roombadge { font-size: 11px; color: var(--accent); margin-left: 6px; }
  </style>
</head>
<body>
  <header>
    <span id="dot" class="dot"></span>
    <span class="title">CodeShell</span>
    <span id="runstate" class="meta"></span>
    <span class="spacer"></span>
    <span id="devname" class="meta"></span>
    <button id="logout" class="iconbtn" style="display:none">退出</button>
  </header>

  <div class="sessionbar">
    <span id="ctxlabel">会话:</span><span id="sid" class="sid">—</span>
    <span class="spacer" style="flex:1"></span>
    <button id="roomsbtn" class="iconbtn">房间</button>
    <button id="newsession" class="iconbtn">新建任务</button>
  </div>

  <main id="feed">
    <div id="empty" class="center">正在连接…</div>
  </main>

  <!-- Rooms overlay: list / create / pick project. Resident CC sessions. -->
  <div id="roomspanel" class="overlay" style="display:none">
    <div class="overlay-head">
      <span class="title">房间(常驻 Claude Code)</span>
      <button id="roomsclose" class="iconbtn">关闭</button>
    </div>
    <div class="overlay-body">
      <button id="roomnew" class="rowbtn">+ 新建房间</button>
      <div id="roomlist"></div>
      <div id="roomcreate" style="display:none">
        <p class="k">选择项目目录(常驻 CC 在此目录干活):</p>
        <div id="projlist"></div>
      </div>
    </div>
  </div>

  <footer>
    <div class="hint">普通任务直接发;需要常驻 Claude Code 会话(上下文持续)请用上方「房间」</div>
    <div class="inputrow">
      <textarea id="input" rows="1" placeholder="给 CodeShell 发个任务…"></textarea>
      <button id="stop" class="stop" style="display:none">停止</button>
      <button id="send" class="send" disabled>发送</button>
    </div>
  </footer>

  <script>
    var feed = document.getElementById('feed');
    var empty = document.getElementById('empty');
    var dot = document.getElementById('dot');
    var runstate = document.getElementById('runstate');
    var devname = document.getElementById('devname');
    var logoutBtn = document.getElementById('logout');
    var sidEl = document.getElementById('sid');
    var newSessionBtn = document.getElementById('newsession');
    var input = document.getElementById('input');
    var sendBtn = document.getElementById('send');
    var stopBtn = document.getElementById('stop');
    var ctxLabel = document.getElementById('ctxlabel');
    var roomsBtn = document.getElementById('roomsbtn');
    var roomsPanel = document.getElementById('roomspanel');
    var roomsClose = document.getElementById('roomsclose');
    var roomNewBtn = document.getElementById('roomnew');
    var roomList = document.getElementById('roomlist');
    var roomCreate = document.getElementById('roomcreate');
    var projList = document.getElementById('projlist');

    var authed = false;
    var currentSession = null;
    var currentRoom = null;   // {id,name,cwd,permissionMode} when inside a room
    var roomSeq = 0;          // last seen room message seq (incremental sync)
    var running = false;
    // streaming assistant bubble currently being appended to (by session)
    var liveAssistant = null;
    var toolEls = {};   // toolCallId -> element

    function hideEmpty() { if (empty) { empty.style.display = 'none'; } }
    function scroll() { feed.scrollTop = feed.scrollHeight; }
    function setRun(state) {
      running = (state === 'running');
      dot.className = 'dot ' + (state === 'running' ? 'run' : state === 'error' ? 'err' : authed ? 'ok' : '');
      runstate.textContent =
        state === 'running' ? '运行中…' :
        state === 'waiting' ? '等待审批' :
        state === 'completed' ? '已完成' :
        state === 'error' ? '出错' : (authed ? '已连接' : '');
      stopBtn.style.display = running ? '' : 'none';
    }

    function addRow(role, cls) {
      hideEmpty();
      var row = document.createElement('div');
      row.className = 'row ' + role;
      var el = document.createElement('div');
      el.className = cls || (role === 'user' ? 'bubble' : 'bubble');
      row.appendChild(el);
      feed.appendChild(row);
      scroll();
      return el;
    }

    function userMsg(text) { addRow('user', 'bubble').textContent = text; }

    function assistantChunk(text) {
      if (!liveAssistant) liveAssistant = addRow('assistant', 'bubble');
      liveAssistant.textContent += text;
      scroll();
    }
    function endAssistant() { liveAssistant = null; }

    function toolStart(id, name, args) {
      var el = addRow('assistant', 'card tool');
      var summary = '';
      var keys = ['command', 'file_path', 'path', 'url', 'pattern', 'query'];
      for (var i = 0; i < keys.length; i++) {
        if (args && typeof args[keys[i]] === 'string') { summary = args[keys[i]]; break; }
      }
      el.innerHTML = '<div class="k">工具 · ' + esc(name) + '</div>';
      if (summary) { var m = document.createElement('div'); m.className = 'mono'; m.textContent = summary; el.appendChild(m); }
      toolEls[id] = el;
      scroll();
    }
    function toolSummary(text) {
      var el = addRow('assistant', 'card tool');
      el.innerHTML = '<div class="k">工具摘要</div><div class="mono"></div>';
      el.querySelector('.mono').textContent = text;
      scroll();
    }
    function sysErr(text) {
      var el = addRow('assistant', 'card err');
      el.innerHTML = '<div class="k">错误</div><div class="mono"></div>';
      el.querySelector('.mono').textContent = text;
      scroll();
    }

    function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;' }[c]; }); }

    // ── approval card ──────────────────────────────────────────────
    function approvalCard(requestId, info) {
      hideEmpty();
      var risk = info.risk || 'medium';
      var row = document.createElement('div');
      row.className = 'row assistant';
      var el = document.createElement('div');
      el.className = 'card approval ' + (risk === 'high' ? 'high' : '');
      el.innerHTML =
        '<div><span class="risk ' + risk + '">' + (risk === 'high' ? '⚠ 高风险' : risk === 'medium' ? '中风险' : '低风险') + '</span></div>' +
        '<div style="margin-top:8px;font-weight:600">' + esc(info.title) + '</div>' +
        '<div class="mono" style="margin-top:6px">' + esc(info.body) + '</div>' +
        '<div class="actions"><button class="approve">批准</button><button class="reject">拒绝</button></div>';
      row.appendChild(el);
      feed.appendChild(row);
      scroll();
      function resolve(decision) {
        send({ type: 'approval.respond', approvalId: requestId, decision: decision, sessionId: currentSession });
        el.querySelector('.actions').remove();
        var r = document.createElement('div'); r.className = 'resolved';
        r.textContent = decision === 'approve' ? '已批准' : '已拒绝';
        el.appendChild(r);
        setRun('running');
      }
      el.querySelector('.approve').onclick = function () { resolve('approve'); };
      el.querySelector('.reject').onclick = function () { resolve('reject'); };
    }

    // ── message router ─────────────────────────────────────────────
    function handle(raw) {
      var msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }

      // a) main-originated server events: { type: ... }
      if (msg.type === 'pair.ok') {
        localStorage.setItem('cs.deviceId', msg.device.id);
        send({ type: 'auth.device', deviceId: msg.device.id, secretHash: getSecret() });
        history.replaceState(null, '', location.pathname);
        return;
      }
      if (msg.type === 'auth.ok') {
        authed = true; sendBtn.disabled = false; logoutBtn.style.display = '';
        devname.textContent = (msg.device && msg.device.name) || '设备';
        setRun('idle'); if (empty) empty.textContent = '已连接,发个任务试试';
        return;
      }
      if (msg.type === 'auth.failed' || msg.type === 'pair.failed') {
        authed = false; sendBtn.disabled = true; setRun('');
        if (empty) { empty.style.display = ''; empty.textContent = msg.message || '认证失败'; }
        if (msg.type === 'auth.failed') localStorage.removeItem('cs.deviceId');
        return;
      }
      if (msg.type === 'chat.accepted') { if (msg.sessionId) { currentSession = msg.sessionId; sidEl.textContent = msg.sessionId; } return; }
      if (msg.type === 'approval.request') { setRun('waiting'); approvalCard(msg.approvalId, { title: msg.title, body: msg.body, risk: msg.risk }); return; }
      if (msg.type === 'error') { sysErr(msg.message || '错误'); return; }

      // ── rooms ────────────────────────────────────────────────────
      if (msg.type === 'room.list.ok') { renderRoomList(msg.rooms || []); return; }
      if (msg.type === 'room.projects.ok') { renderProjects(msg.projects || []); return; }
      if (msg.type === 'room.opened') {
        if (msg.status === 'missing') { sysErr('房间不存在'); }
        return;
      }
      if (msg.type === 'room.history.ok') {
        if (currentRoom && msg.roomId === currentRoom.id) {
          feed.innerHTML = ''; hideEmpty();
          (msg.messages || []).forEach(renderRoomMsg);
          if (msg.latestSeq) roomSeq = msg.latestSeq;
        }
        return;
      }
      if (msg.type === 'room.message') {
        if (currentRoom && msg.roomId === currentRoom.id && msg.msg) {
          renderRoomMsg(msg.msg);
          if (msg.msg.seq) roomSeq = msg.msg.seq;
        }
        return;
      }
      if (msg.type === 'room.closed') { return; }
      if (msg.type === 'room.error') { sysErr(msg.message || '房间错误'); return; }

      // b) mirrored worker→renderer JSON-RPC lines
      if (msg.method === 'agent/streamEvent' && msg.params && msg.params.event) {
        var ev = msg.params.event;
        if (msg.params.sessionId && msg.params.sessionId !== currentSession) {
          currentSession = msg.params.sessionId; sidEl.textContent = currentSession;
        }
        if (ev.type === 'text_delta') { setRun('running'); assistantChunk(ev.text || ''); }
        else if (ev.type === 'assistant_message') { endAssistant(); }
        else if (ev.type === 'tool_use_start' && ev.toolCall) { toolStart(ev.toolCall.id, ev.toolCall.toolName, ev.toolCall.args); }
        else if (ev.type === 'tool_summary') { toolSummary(ev.summary || ''); }
        else if (ev.type === 'turn_complete') { endAssistant(); setRun(ev.reason === 'completed' ? 'completed' : 'idle'); }
        else if (ev.type === 'error') { endAssistant(); setRun('error'); sysErr(ev.error || '运行出错'); }
        return;
      }
      if (msg.method === 'agent/approvalRequest' && msg.params && msg.params.request) {
        var rq = msg.params.request;
        setRun('waiting');
        var summary = '';
        var ks = ['command', 'file_path', 'path', 'url', 'pattern', 'query'];
        for (var i = 0; i < ks.length; i++) { if (rq.args && typeof rq.args[ks[i]] === 'string') { summary = rq.args[ks[i]]; break; } }
        approvalCard(msg.params.requestId, {
          title: (rq.toolName || '操作') + (rq.description ? ' — ' + rq.description : ''),
          body: summary || JSON.stringify(rq.args || {}),
          risk: rq.riskLevel || 'medium',
        });
        return;
      }
    }

    // ── identity / pairing ─────────────────────────────────────────
    function getSecret() {
      var s = localStorage.getItem('cs.deviceSecret');
      if (!s) {
        var b = new Uint8Array(32); crypto.getRandomValues(b);
        s = Array.from(b).map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
        localStorage.setItem('cs.deviceSecret', s);
      }
      return s;
    }
    function getDeviceId() { return localStorage.getItem('cs.deviceId') || ''; }
    function getDeviceName() {
      var n = localStorage.getItem('cs.deviceName');
      if (!n) { n = (navigator.platform || 'Phone') + ' 浏览器'; localStorage.setItem('cs.deviceName', n); }
      return n;
    }

    var pairingToken = new URLSearchParams(location.search).get('pairing');
    var ws, wsReady = false;
    function send(obj) { if (ws && wsReady) ws.send(JSON.stringify(obj)); }

    function connect() {
      ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws');
      ws.onopen = function () {
        wsReady = true;
        if (empty) empty.textContent = '认证中…';
        if (pairingToken) {
          send({ type: 'pair.complete', token: pairingToken, name: getDeviceName(), secretHash: getSecret() });
        } else if (getDeviceId()) {
          send({ type: 'auth.device', deviceId: getDeviceId(), secretHash: getSecret() });
        } else if (empty) {
          empty.textContent = '未配对 — 请从 CodeShell 设置里扫码打开配对链接';
        }
      };
      ws.onmessage = function (e) { handle(e.data); };
      ws.onclose = function () {
        wsReady = false; authed = false; sendBtn.disabled = true; setRun('');
        if (empty) { empty.style.display = ''; empty.textContent = '连接断开,3 秒后重连…'; }
        setTimeout(connect, 3000);
      };
    }

    // ── composer ───────────────────────────────────────────────────
    function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; }
    input.addEventListener('input', autosize);
    function doSend() {
      if (!authed) return;
      var t = input.value.trim(); if (!t) return;
      if (currentRoom) {
        // Room: don't echo locally — main persists + pushes it back via
        // room.message (echoing here too would double the user bubble).
        send({ type: 'room.send', roomId: currentRoom.id, text: t });
      } else {
        userMsg(t);
        send({ type: 'chat.send', text: t, sessionId: currentSession || undefined });
      }
      input.value = ''; autosize(); setRun('running');
    }
    sendBtn.onclick = doSend;
    stopBtn.onclick = function () { send({ type: 'run.stop', sessionId: currentSession || undefined }); setRun('idle'); };
    newSessionBtn.onclick = function () {
      send({ type: 'session.create' });
      feed.innerHTML = ''; liveAssistant = null; toolEls = {};
      hideEmpty();
    };
    logoutBtn.onclick = function () {
      localStorage.removeItem('cs.deviceId'); localStorage.removeItem('cs.deviceSecret');
      location.reload();
    };

    // ── rooms ──────────────────────────────────────────────────────
    function renderRoomMsg(m) {
      if (!m) return;
      hideEmpty();
      if (m.from === 'user' && m.type === 'text') { addRow('user', 'bubble').textContent = m.text || ''; return; }
      if (m.from === 'agent' && m.type === 'text') { assistantChunk(m.text || ''); endAssistant(); return; }
      if (m.from === 'agent' && m.type === 'tool') {
        var el = addRow('assistant', 'card tool');
        el.innerHTML = '<div class="k">工具 · ' + esc(m.tool || '') + '</div>';
        if (m.summary) { var mm = document.createElement('div'); mm.className = 'mono'; mm.textContent = m.summary; el.appendChild(mm); }
        return;
      }
      if (m.from === 'agent' && m.type === 'tool_result') {
        var e2 = addRow('assistant', 'card tool' + (m.isError ? ' err' : ''));
        e2.innerHTML = '<div class="k">工具结果</div><div class="mono"></div>';
        e2.querySelector('.mono').textContent = m.summary || ''; return;
      }
      if (m.type === 'turn_end') { endAssistant(); setRun('completed'); return; }
      if (m.type === 'error') { sysErr(m.text || '错误'); return; }
      if (m.type === 'agent_exit') { sysErr('常驻 CC 已退出'); return; }
    }

    function openRooms() { roomsPanel.style.display = 'flex'; roomCreate.style.display = 'none'; send({ type: 'room.list' }); }
    function closeRooms() { roomsPanel.style.display = 'none'; }

    function renderRoomList(rooms) {
      roomList.innerHTML = '';
      if (!rooms.length) { roomList.innerHTML = '<p class="center">还没有房间,点上方新建</p>'; return; }
      rooms.forEach(function (r) {
        var danger = r.permissionMode === 'bypassPermissions';
        var el = document.createElement('div');
        el.className = 'roomitem';
        el.innerHTML =
          '<div style="flex:1"><div class="nm">' + esc(r.name) +
          ' <span class="mode ' + (danger ? 'danger' : '') + '">' + (danger ? 'dangerous' : r.permissionMode) + '</span>' +
          (r.open ? ' <span class="open">●运行中</span>' : '') +
          '</div><div class="cwd">' + esc(r.cwd) + '</div></div>';
        el.onclick = function () { enterRoom(r); };
        roomList.appendChild(el);
      });
    }

    function enterRoom(r) {
      currentRoom = r; roomSeq = 0;
      ctxLabel.textContent = '房间:'; sidEl.textContent = r.name;
      input.placeholder = '在房间「' + r.name + '」里跟 Claude Code 对话…';
      feed.innerHTML = ''; liveAssistant = null;
      closeRooms();
      send({ type: 'room.open', roomId: r.id });
      send({ type: 'room.history', roomId: r.id, sinceSeq: 0 });
    }

    function leaveRoom() {
      currentRoom = null;
      ctxLabel.textContent = '会话:'; sidEl.textContent = currentSession || '—';
      input.placeholder = '给 CodeShell 发个任务…';
      feed.innerHTML = ''; liveAssistant = null; hideEmpty();
    }

    function renderProjects(projects) {
      projList.innerHTML = '';
      if (!projects.length) { projList.innerHTML = '<p class="center">无最近项目,可在桌面打开一个项目后再来</p>'; return; }
      projects.forEach(function (p) {
        var b = document.createElement('button');
        b.className = 'rowbtn';
        b.innerHTML = '<div class="nm">' + esc(p.name) + '</div><div class="cwd">' + esc(p.path) + '</div>';
        b.onclick = function () {
          send({ type: 'room.create', name: p.name, cwd: p.path });
          roomCreate.style.display = 'none';
        };
        projList.appendChild(b);
      });
    }

    roomsBtn.onclick = openRooms;
    roomsClose.onclick = closeRooms;
    roomNewBtn.onclick = function () { roomCreate.style.display = 'block'; send({ type: 'room.projects' }); };
    // "新建任务" doubles as "leave room → fresh chat" when inside a room.
    newSessionBtn.onclick = function () {
      if (currentRoom) { leaveRoom(); return; }
      send({ type: 'session.create' });
      feed.innerHTML = ''; liveAssistant = null; toolEls = {};
      hideEmpty();
    };

    connect();
  </script>
</body>
</html>`;
}
