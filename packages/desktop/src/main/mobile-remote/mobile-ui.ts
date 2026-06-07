export function mobileRemoteHtml(): string {
  return `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#0a0c10" />
  <title>CodeShell Remote</title>
  <style>
    /*
     * "Precision dark console" — an engineering control surface for driving a
     * desktop agent from a phone / iPad. Dark base, one restrained accent
     * (signal teal), monospace for technical payloads, generous touch targets.
     * One stylesheet; the phone gets a single column, the iPad a two-pane
     * layout via the 820px breakpoint. No external fonts/CDN — the device may
     * be on a closed LAN — so everything rides system stacks.
     */
    :root {
      --bg: #0a0c10;
      --bg-elev: #11151c;
      --bg-elev2: #161b24;
      --line: #1f2733;
      --line-soft: #161d27;
      --fg: #e8edf4;
      --fg-dim: #8b97a8;
      --fg-faint: #5c6675;
      --accent: #38e0c8;
      --accent-ink: #042420;
      --accent-soft: #0f2b2a;
      --user: #2b6cff;
      --user-ink: #f4f8ff;
      --ok: #45d483;
      --warn: #f5c451;
      --err: #ff6b6b;
      --danger: #ff8a8a;
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --sans: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", system-ui, sans-serif;
      --radius: 14px;
      --radius-sm: 10px;
      --shadow: 0 8px 30px -12px rgba(0,0,0,.7);
    }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    html, body { margin: 0; height: 100%; }
    body {
      font-family: var(--sans);
      background: var(--bg);
      color: var(--fg);
      height: 100dvh;
      overflow: hidden;
      background-image:
        radial-gradient(120% 80% at 100% 0%, rgba(56,224,200,.05), transparent 60%),
        radial-gradient(100% 60% at 0% 100%, rgba(43,108,255,.05), transparent 55%);
    }

    #app { display: flex; flex-direction: column; height: 100dvh; max-width: 1180px; margin: 0 auto; }

    /* top bar */
    header {
      display: flex; align-items: center; gap: 10px;
      padding: 12px 16px; padding-top: max(12px, env(safe-area-inset-top));
      border-bottom: 1px solid var(--line);
      background: rgba(10,12,16,.82);
      backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    }
    .brand { display: flex; align-items: center; gap: 9px; font-weight: 700; font-size: 15px; letter-spacing: -.01em; }
    .brand .mark {
      width: 22px; height: 22px; border-radius: 6px; flex: none;
      background: linear-gradient(135deg, var(--accent), #1f9d8c);
      box-shadow: 0 0 0 1px rgba(56,224,200,.3), 0 4px 12px -4px rgba(56,224,200,.5);
      display: grid; place-items: center; color: var(--accent-ink); font-size: 13px; font-weight: 900;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-faint); flex: none; transition: background .25s; }
    .dot.ok { background: var(--ok); box-shadow: 0 0 0 3px rgba(69,212,131,.18); }
    .dot.run { background: var(--warn); box-shadow: 0 0 0 3px rgba(245,196,81,.18); animation: pulse 1.1s ease-in-out infinite; }
    .dot.err { background: var(--err); box-shadow: 0 0 0 3px rgba(255,107,107,.2); }
    @keyframes pulse { 50% { opacity: .3; transform: scale(.82); } }
    header .meta { font-size: 11px; color: var(--fg-dim); font-variant-numeric: tabular-nums; }
    header .spacer { flex: 1; }
    .iconbtn {
      border: 1px solid var(--line); background: var(--bg-elev); color: var(--fg-dim);
      border-radius: 9px; padding: 7px 11px; font-size: 12px; font-weight: 600;
      cursor: pointer; transition: border-color .15s, color .15s, background .15s; min-height: 34px;
    }
    .iconbtn:active { background: var(--bg-elev2); }
    .iconbtn:hover { border-color: var(--accent); color: var(--fg); }

    /* context bar */
    .ctxbar {
      display: flex; gap: 10px; align-items: center;
      padding: 9px 16px; border-bottom: 1px solid var(--line-soft);
      font-size: 12px; color: var(--fg-dim); background: var(--bg-elev);
    }
    .ctxbar .label { color: var(--fg-faint); flex: none; }
    .ctxbar .sid {
      color: var(--accent); font-family: var(--mono); font-size: 11.5px;
      max-width: 50vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .ctxbar .spacer { flex: 1; }
    .ctxbar .acts { display: flex; gap: 8px; flex: none; }

    /* body */
    .body { flex: 1; min-height: 0; display: flex; }
    #nav { display: none; }
    main {
      flex: 1; min-height: 0; overflow-y: auto;
      padding: 16px 16px 8px; -webkit-overflow-scrolling: touch; scroll-behavior: smooth;
    }

    /* message rows */
    .row { margin: 10px 0; display: flex; animation: rise .22s ease-out; }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } }
    .row.user { justify-content: flex-end; }
    .bubble {
      max-width: min(86%, 720px); padding: 10px 13px; border-radius: var(--radius);
      font-size: 14.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
    }
    .user .bubble { background: linear-gradient(135deg, var(--user), #1f5be0); color: var(--user-ink); border-bottom-right-radius: 5px; }
    .assistant .bubble { background: var(--bg-elev); border: 1px solid var(--line); border-bottom-left-radius: 5px; }

    .card {
      max-width: min(94%, 720px); background: var(--bg-elev); border: 1px solid var(--line);
      border-radius: var(--radius-sm); padding: 10px 13px; font-size: 13px; box-shadow: var(--shadow);
    }
    .card .k {
      display: flex; align-items: center; gap: 6px;
      color: var(--fg-dim); font-size: 10.5px; text-transform: uppercase;
      letter-spacing: .08em; font-weight: 700; margin-bottom: 6px;
    }
    .card .k::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: var(--accent); flex: none; }
    .card .mono { font-family: var(--mono); font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; color: var(--fg); }
    .tool .k { color: var(--accent); }
    .err { border-color: rgba(255,107,107,.4); }
    .err .k, .err .mono { color: var(--err); }
    .err .k::before { background: var(--err); }
    .sys { color: var(--fg-dim); font-size: 12px; font-style: italic; text-align: center; margin: 12px 0; }

    /* approval card */
    .approval { border-color: rgba(245,196,81,.5); background: linear-gradient(180deg, rgba(245,196,81,.06), transparent), var(--bg-elev); }
    .approval.high { border-color: rgba(255,107,107,.55); background: linear-gradient(180deg, rgba(255,107,107,.08), transparent), var(--bg-elev); }
    .approval .risk { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 800; letter-spacing: .02em; }
    .approval .risk.low { background: var(--accent-soft); color: var(--ok); }
    .approval .risk.medium { background: rgba(245,196,81,.14); color: var(--warn); }
    .approval .risk.high { background: rgba(255,107,107,.16); color: var(--err); }
    .approval .ttl { margin-top: 9px; font-weight: 650; font-size: 14px; }
    .approval .actions { display: flex; gap: 10px; margin-top: 12px; }
    .approval button { flex: 1; padding: 12px; border-radius: var(--radius-sm); border: 0; font-weight: 800; font-size: 14px; cursor: pointer; min-height: 46px; }
    .approval .approve { background: var(--accent); color: var(--accent-ink); }
    .approval .approve:active { filter: brightness(.92); }
    .approval .reject { background: transparent; border: 1px solid var(--line); color: var(--fg); }
    .approval.high .approve { background: var(--err); color: #240909; }
    .approval .resolved { margin-top: 10px; color: var(--fg-dim); font-size: 12.5px; }

    /* composer */
    footer {
      border-top: 1px solid var(--line); background: var(--bg-elev);
      padding: 12px 16px; padding-bottom: max(12px, env(safe-area-inset-bottom));
    }
    .hint { font-size: 11px; color: var(--fg-faint); margin-bottom: 8px; line-height: 1.4; }
    .inputrow { display: flex; gap: 9px; align-items: flex-end; }
    textarea {
      flex: 1; min-height: 46px; max-height: 160px; resize: none;
      border-radius: var(--radius); border: 1px solid var(--line); background: var(--bg);
      color: var(--fg); padding: 12px 14px; font-size: 15px; font-family: inherit; line-height: 1.4;
      transition: border-color .15s;
    }
    textarea:focus { outline: none; border-color: var(--accent); }
    textarea::placeholder { color: var(--fg-faint); }
    .send { border: 0; border-radius: var(--radius); background: var(--accent); color: var(--accent-ink); padding: 0 18px; height: 46px; font-weight: 800; font-size: 14px; cursor: pointer; flex: none; }
    .send:disabled { opacity: .35; }
    .send:not(:disabled):active { filter: brightness(.92); }
    .stop { border: 1px solid var(--err); color: var(--err); background: transparent; border-radius: var(--radius); padding: 0 16px; height: 46px; font-weight: 800; cursor: pointer; flex: none; }

    .center { text-align: center; color: var(--fg-dim); padding: 40px 16px; font-size: 13.5px; line-height: 1.6; }
    .center .big { font-size: 15px; color: var(--fg); font-weight: 600; margin-bottom: 4px; }

    /* rooms overlay / nav */
    .overlay { position: fixed; inset: 0; z-index: 30; display: flex; flex-direction: column; background: var(--bg); padding-top: max(0px, env(safe-area-inset-top)); animation: fade .18s ease-out; }
    @keyframes fade { from { opacity: 0; } }
    .overlay-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
    .overlay-head .title { font-weight: 700; flex: 1; font-size: 15px; }
    .overlay-body { flex: 1; overflow-y: auto; padding: 14px 16px; }
    .rowbtn { display: block; width: 100%; text-align: left; padding: 14px; margin-bottom: 10px; border-radius: var(--radius-sm); border: 1px dashed var(--line); background: var(--bg-elev); color: var(--accent); font-size: 14px; font-weight: 600; cursor: pointer; }
    .roomitem { display: flex; align-items: center; gap: 10px; padding: 13px 14px; margin-bottom: 10px; border-radius: var(--radius-sm); border: 1px solid var(--line); background: var(--bg-elev); cursor: pointer; transition: border-color .15s; }
    .roomitem:hover { border-color: var(--accent); }
    .roomitem.active { border-color: var(--accent); background: var(--accent-soft); }
    .roomitem .nm { font-weight: 650; font-size: 14px; }
    .roomitem .cwd { color: var(--fg-dim); font-size: 11px; word-break: break-all; font-family: var(--mono); margin-top: 2px; }
    .roomitem .mode { font-size: 10px; padding: 2px 7px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-weight: 700; }
    .roomitem .mode.danger { background: rgba(255,107,107,.16); color: var(--danger); }
    .roomitem .open { font-size: 10px; color: var(--ok); font-weight: 700; }
    .section-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--fg-faint); font-weight: 700; margin: 4px 2px 10px; }

    /* iPad / wide: two-pane */
    @media (min-width: 820px) {
      #app { border-left: 1px solid var(--line-soft); border-right: 1px solid var(--line-soft); }
      .ctxbar .acts .wide-hide { display: none; }
      #nav { display: flex; flex-direction: column; width: 280px; flex: none; border-right: 1px solid var(--line); background: var(--bg-elev); overflow-y: auto; }
      #nav .nav-head { padding: 14px 16px 10px; display: flex; align-items: center; gap: 8px; }
      #nav .nav-head .title { font-weight: 700; font-size: 13px; flex: 1; }
      #nav .nav-body { padding: 0 12px 14px; }
      .overlay.as-nav { position: static; inset: auto; z-index: auto; background: transparent; padding-top: 0; animation: none; }
      .overlay.as-nav .overlay-head { display: none; }
      .overlay.as-nav .overlay-body { padding: 0; }
      main { padding: 22px 28px 10px; }
      .bubble, .card { max-width: 680px; }
    }
    @media (min-width: 820px) and (max-width: 1024px) { #nav { width: 240px; } }
  </style>
</head>
<body>
  <div id="app">
    <header>
      <span class="brand"><span class="mark">C</span>CodeShell</span>
      <span id="dot" class="dot"></span>
      <span id="runstate" class="meta"></span>
      <span class="spacer"></span>
      <span id="devname" class="meta"></span>
      <button id="logout" class="iconbtn" style="display:none">退出</button>
    </header>

    <div class="ctxbar">
      <span class="label" id="ctxlabel">会话</span>
      <span id="sid" class="sid">—</span>
      <span class="spacer"></span>
      <span class="acts">
        <button id="roomsbtn" class="iconbtn wide-hide">房间</button>
        <button id="newsession" class="iconbtn">新建任务</button>
      </span>
    </div>

    <div class="body">
      <aside id="nav">
        <div class="nav-head"><span class="title">房间 · 常驻 CC</span>
          <button id="navnew" class="iconbtn">+ 新建</button>
        </div>
        <div class="nav-body" id="navbody"></div>
      </aside>

      <main id="feed">
        <div id="empty" class="center"><div class="big">正在连接…</div>等待与 CodeShell 建立通道</div>
      </main>
    </div>

    <div id="roomspanel" class="overlay" style="display:none">
      <div class="overlay-head">
        <span class="title">房间 · 常驻 Claude Code</span>
        <button id="roomsclose" class="iconbtn">关闭</button>
      </div>
      <div class="overlay-body">
        <button id="roomnew" class="rowbtn">+ 新建房间</button>
        <div id="roomlist"></div>
        <div id="roomcreate" style="display:none">
          <p class="section-label">选择项目目录(常驻 CC 在此目录干活)</p>
          <div id="projlist"></div>
        </div>
      </div>
    </div>

    <footer>
      <div class="hint">普通任务直接发;需要上下文持续的常驻 Claude Code 会话请用「房间」。</div>
      <div class="inputrow">
        <textarea id="input" rows="1" placeholder="给 CodeShell 发个任务…"></textarea>
        <button id="stop" class="stop" style="display:none">停止</button>
        <button id="send" class="send" disabled>发送</button>
      </div>
    </footer>
  </div>

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
    var navBody = document.getElementById('navbody');
    var navNewBtn = document.getElementById('navnew');

    var wideMq = window.matchMedia('(min-width: 820px)');
    var roomsOverlayBody = roomsPanel.querySelector('.overlay-body');

    var authed = false;
    var currentSession = null;
    var currentRoom = null;
    var roomSeq = 0;
    var running = false;
    var liveAssistant = null;
    var toolEls = {};
    var lastRooms = [];

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
      el.className = cls || 'bubble';
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

    function approvalCard(requestId, info) {
      hideEmpty();
      var risk = info.risk || 'medium';
      var row = document.createElement('div');
      row.className = 'row assistant';
      var el = document.createElement('div');
      el.className = 'card approval ' + (risk === 'high' ? 'high' : '');
      el.innerHTML =
        '<div><span class="risk ' + risk + '">' + (risk === 'high' ? '⚠ 高风险' : risk === 'medium' ? '● 中风险' : '● 低风险') + '</span></div>' +
        '<div class="ttl">' + esc(info.title) + '</div>' +
        '<div class="mono" style="margin-top:6px">' + esc(info.body) + '</div>' +
        '<div class="actions"><button class="approve">批准</button><button class="reject">拒绝</button></div>';
      row.appendChild(el);
      feed.appendChild(row);
      scroll();
      function resolve(decision) {
        send({ type: 'approval.respond', approvalId: requestId, decision: decision, sessionId: currentSession });
        el.querySelector('.actions').remove();
        var r = document.createElement('div'); r.className = 'resolved';
        r.textContent = decision === 'approve' ? '✓ 已批准' : '✕ 已拒绝';
        el.appendChild(r);
        setRun('running');
      }
      el.querySelector('.approve').onclick = function () { resolve('approve'); };
      el.querySelector('.reject').onclick = function () { resolve('reject'); };
    }

    function handle(raw) {
      var msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }

      if (msg.type === 'pair.ok') {
        localStorage.setItem('cs.deviceId', msg.device.id);
        send({ type: 'auth.device', deviceId: msg.device.id, secretHash: getSecret() });
        history.replaceState(null, '', location.pathname);
        return;
      }
      if (msg.type === 'auth.ok') {
        authed = true; sendBtn.disabled = false; logoutBtn.style.display = '';
        devname.textContent = (msg.device && msg.device.name) || '设备';
        setRun('idle');
        if (empty) empty.innerHTML = '<div class="big">已连接</div>发个任务试试,或在「房间」里开常驻会话';
        if (wideMq.matches) openRooms();
        return;
      }
      if (msg.type === 'auth.failed' || msg.type === 'pair.failed') {
        authed = false; sendBtn.disabled = true; setRun('');
        if (empty) { empty.style.display = ''; empty.innerHTML = '<div class="big">' + esc(msg.message || '认证失败') + '</div>'; }
        if (msg.type === 'auth.failed') localStorage.removeItem('cs.deviceId');
        return;
      }
      if (msg.type === 'chat.accepted') { if (msg.sessionId) { currentSession = msg.sessionId; sidEl.textContent = msg.sessionId; } return; }
      if (msg.type === 'approval.request') { setRun('waiting'); approvalCard(msg.approvalId, { title: msg.title, body: msg.body, risk: msg.risk }); return; }
      if (msg.type === 'error') { sysErr(msg.message || '错误'); return; }

      if (msg.type === 'room.list.ok') { renderRoomList(msg.rooms || []); return; }
      if (msg.type === 'room.projects.ok') { renderProjects(msg.projects || []); return; }
      if (msg.type === 'room.opened') { if (msg.status === 'missing') { sysErr('房间不存在'); } return; }
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

      if (msg.method === 'agent/streamEvent' && msg.params && msg.params.event) {
        var ev = msg.params.event;
        if (msg.params.sessionId && msg.params.sessionId !== currentSession) {
          currentSession = msg.params.sessionId; if (!currentRoom) sidEl.textContent = currentSession;
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
        if (empty) empty.innerHTML = '<div class="big">认证中…</div>';
        if (pairingToken) {
          send({ type: 'pair.complete', token: pairingToken, name: getDeviceName(), secretHash: getSecret() });
        } else if (getDeviceId()) {
          send({ type: 'auth.device', deviceId: getDeviceId(), secretHash: getSecret() });
        } else if (empty) {
          empty.innerHTML = '<div class="big">未配对</div>请从 CodeShell 桌面端「设置 → 远程」扫码打开配对链接';
        }
      };
      ws.onmessage = function (e) { handle(e.data); };
      ws.onclose = function () {
        wsReady = false; authed = false; sendBtn.disabled = true; setRun('');
        if (empty) { empty.style.display = ''; empty.innerHTML = '<div class="big">连接断开</div>3 秒后自动重连…'; }
        setTimeout(connect, 3000);
      };
    }

    function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; }
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && wideMq.matches) { e.preventDefault(); doSend(); }
    });
    function doSend() {
      if (!authed) return;
      var t = input.value.trim(); if (!t) return;
      if (currentRoom) {
        send({ type: 'room.send', roomId: currentRoom.id, text: t });
      } else {
        userMsg(t);
        send({ type: 'chat.send', text: t, sessionId: currentSession || undefined });
      }
      input.value = ''; autosize(); setRun('running');
    }
    sendBtn.onclick = doSend;
    stopBtn.onclick = function () { send({ type: 'run.stop', sessionId: currentSession || undefined }); setRun('idle'); };
    logoutBtn.onclick = function () {
      localStorage.removeItem('cs.deviceId'); localStorage.removeItem('cs.deviceSecret');
      location.reload();
    };

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

    function syncRoomsPlacement() {
      if (wideMq.matches) {
        roomsPanel.style.display = 'none';
        roomsPanel.classList.add('as-nav');
        if (roomsOverlayBody.parentElement !== navBody) navBody.appendChild(roomsOverlayBody);
      } else {
        roomsPanel.classList.remove('as-nav');
        if (roomsOverlayBody.parentElement !== roomsPanel) roomsPanel.appendChild(roomsOverlayBody);
      }
    }
    function openRooms() {
      if (wideMq.matches) { syncRoomsPlacement(); roomCreate.style.display = 'none'; send({ type: 'room.list' }); return; }
      roomsPanel.style.display = 'flex'; roomCreate.style.display = 'none'; send({ type: 'room.list' });
    }
    function closeRooms() { if (!wideMq.matches) roomsPanel.style.display = 'none'; }

    function renderRoomList(rooms) {
      lastRooms = rooms;
      roomList.innerHTML = '';
      if (!rooms.length) { roomList.innerHTML = '<p class="center">还没有房间,点上方新建</p>'; return; }
      rooms.forEach(function (r) {
        var danger = r.permissionMode === 'bypassPermissions';
        var active = currentRoom && currentRoom.id === r.id;
        var el = document.createElement('div');
        el.className = 'roomitem' + (active ? ' active' : '');
        el.innerHTML =
          '<div style="flex:1;min-width:0"><div class="nm">' + esc(r.name) +
          ' <span class="mode ' + (danger ? 'danger' : '') + '">' + (danger ? 'dangerous' : esc(r.permissionMode)) + '</span>' +
          (r.open ? ' <span class="open">●运行中</span>' : '') +
          '</div><div class="cwd">' + esc(r.cwd) + '</div></div>';
        el.onclick = function () { enterRoom(r); };
        roomList.appendChild(el);
      });
    }

    function enterRoom(r) {
      currentRoom = r; roomSeq = 0;
      ctxLabel.textContent = '房间'; sidEl.textContent = r.name;
      input.placeholder = '在房间「' + r.name + '」里跟 Claude Code 对话…';
      feed.innerHTML = ''; liveAssistant = null;
      closeRooms();
      renderRoomList(lastRooms);
      send({ type: 'room.open', roomId: r.id });
      send({ type: 'room.history', roomId: r.id, sinceSeq: 0 });
    }

    function leaveRoom() {
      currentRoom = null;
      ctxLabel.textContent = '会话'; sidEl.textContent = currentSession || '—';
      input.placeholder = '给 CodeShell 发个任务…';
      feed.innerHTML = ''; liveAssistant = null; hideEmpty();
      renderRoomList(lastRooms);
    }

    function renderProjects(projects) {
      projList.innerHTML = '';
      if (!projects.length) { projList.innerHTML = '<p class="center">无最近项目,可在桌面打开一个项目后再来</p>'; return; }
      projects.forEach(function (p) {
        var b = document.createElement('button');
        b.className = 'rowbtn';
        b.innerHTML = '<div class="nm">' + esc(p.name) + '</div><div class="cwd">' + esc(p.path) + '</div>';
        b.onclick = function () { send({ type: 'room.create', name: p.name, cwd: p.path }); roomCreate.style.display = 'none'; };
        projList.appendChild(b);
      });
    }

    roomsBtn.onclick = openRooms;
    roomsClose.onclick = closeRooms;
    function startRoomCreate() { roomCreate.style.display = 'block'; send({ type: 'room.projects' }); }
    roomNewBtn.onclick = startRoomCreate;
    navNewBtn.onclick = startRoomCreate;
    newSessionBtn.onclick = function () {
      if (currentRoom) { leaveRoom(); return; }
      send({ type: 'session.create' });
      feed.innerHTML = ''; liveAssistant = null; toolEls = {};
      hideEmpty();
    };

    if (wideMq.addEventListener) wideMq.addEventListener('change', function () { syncRoomsPlacement(); if (authed) send({ type: 'room.list' }); });
    syncRoomsPlacement();

    connect();
  </script>
</body>
</html>`;
}
