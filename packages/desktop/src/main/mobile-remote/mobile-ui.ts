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
     * desktop agent from a phone / iPad. v2 refines: a consistent 4px spacing
     * scale, tool cards keyed by an inline-SVG icon + a monospace code block,
     * a richer room rail (status pip + pulse + selected state), and structured
     * empty/connection states. One stylesheet; phone = single column, iPad =
     * two-pane at the 820px breakpoint. No external fonts/CDN (closed-LAN safe).
     */
    :root {
      --bg: #0a0c10;
      --bg-elev: #11151c;
      --bg-elev2: #161b24;
      --bg-code: #0c1118;
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
      /* 4px spacing scale */
      --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 20px; --s6: 24px;
      --radius: 14px; --radius-sm: 10px; --radius-xs: 7px;
      --shadow: 0 10px 34px -14px rgba(0,0,0,.75);
      --shadow-sm: 0 2px 8px -3px rgba(0,0,0,.5);
    }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    html, body { margin: 0; height: 100%; }
    body {
      font-family: var(--sans);
      background: var(--bg); color: var(--fg);
      height: 100dvh; overflow: hidden;
      font-size: 14px; line-height: 1.5;
      -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
      background-image:
        radial-gradient(130% 90% at 100% -10%, rgba(56,224,200,.055), transparent 55%),
        radial-gradient(110% 70% at 0% 110%, rgba(43,108,255,.05), transparent 55%);
    }
    svg { display: block; }
    .ico { width: 15px; height: 15px; flex: none; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }

    #app { display: flex; flex-direction: column; height: 100dvh; max-width: 1180px; margin: 0 auto; }

    /* ── top bar ─────────────────────────────────────────────────────── */
    header {
      display: flex; align-items: center; gap: var(--s3);
      padding: var(--s3) var(--s4); padding-top: max(var(--s3), env(safe-area-inset-top));
      border-bottom: 1px solid var(--line);
      background: rgba(10,12,16,.82); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
    }
    .brand { display: flex; align-items: center; gap: var(--s2); font-weight: 700; font-size: 15px; letter-spacing: -.01em; }
    .brand .mark {
      width: 23px; height: 23px; border-radius: 7px; flex: none;
      background: linear-gradient(140deg, var(--accent), #1f9d8c);
      box-shadow: 0 0 0 1px rgba(56,224,200,.3), 0 5px 14px -5px rgba(56,224,200,.55);
      display: grid; place-items: center; color: var(--accent-ink); font-size: 13px; font-weight: 900;
    }
    /* status badge (replaces bare dot+text) */
    .status { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; color: var(--fg-dim); padding: 3px 9px 3px 7px; border-radius: 999px; border: 1px solid var(--line); background: var(--bg-elev); }
    .status .pip { width: 7px; height: 7px; border-radius: 50%; background: var(--fg-faint); transition: background .25s; }
    .status.ok .pip { background: var(--ok); box-shadow: 0 0 0 3px rgba(69,212,131,.16); }
    .status.run { border-color: rgba(245,196,81,.4); color: var(--warn); }
    .status.run .pip { background: var(--warn); animation: pulse 1.1s ease-in-out infinite; }
    .status.wait { border-color: rgba(245,196,81,.4); color: var(--warn); }
    .status.wait .pip { background: var(--warn); }
    .status.err { border-color: rgba(255,107,107,.45); color: var(--err); }
    .status.err .pip { background: var(--err); }
    @keyframes pulse { 50% { opacity: .35; transform: scale(.78); } }
    header .spacer { flex: 1; }
    header .meta { font-size: 11px; color: var(--fg-faint); font-variant-numeric: tabular-nums; }
    .iconbtn {
      display: inline-flex; align-items: center; gap: 5px;
      border: 1px solid var(--line); background: var(--bg-elev); color: var(--fg-dim);
      border-radius: 9px; padding: 7px 11px; font-size: 12px; font-weight: 600;
      cursor: pointer; transition: border-color .15s, color .15s, background .15s; min-height: 34px;
    }
    .iconbtn:active { background: var(--bg-elev2); }
    .iconbtn:hover { border-color: var(--accent); color: var(--fg); }

    /* ── context bar ─────────────────────────────────────────────────── */
    .ctxbar {
      display: flex; gap: var(--s3); align-items: center;
      padding: var(--s2) var(--s4); border-bottom: 1px solid var(--line-soft);
      font-size: 12px; color: var(--fg-dim); background: var(--bg-elev);
    }
    .ctxbar .label { color: var(--fg-faint); flex: none; display: inline-flex; align-items: center; gap: 5px; }
    .ctxbar .sid { color: var(--accent); font-family: var(--mono); font-size: 11.5px; max-width: 46vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ctxbar .spacer { flex: 1; }
    .ctxbar .acts { display: flex; gap: var(--s2); flex: none; }

    /* ── body ────────────────────────────────────────────────────────── */
    .body { flex: 1; min-height: 0; display: flex; }
    #nav { display: none; }
    main { flex: 1; min-height: 0; overflow-y: auto; padding: var(--s4) var(--s4) var(--s2); -webkit-overflow-scrolling: touch; scroll-behavior: smooth; }

    /* ── message rows ────────────────────────────────────────────────── */
    .row { margin: var(--s3) 0; display: flex; animation: rise .22s ease-out; }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } }
    .row.user { justify-content: flex-end; }
    .bubble { max-width: min(85%, 680px); padding: 10px 14px; border-radius: var(--radius); font-size: 14.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
    .user .bubble { background: linear-gradient(135deg, var(--user), #1f5be0); color: var(--user-ink); border-bottom-right-radius: 5px; box-shadow: var(--shadow-sm); }
    .assistant .bubble { background: var(--bg-elev); border: 1px solid var(--line); border-bottom-left-radius: 5px; }

    /* ── tool / system / error cards ─────────────────────────────────── */
    .card { max-width: min(94%, 680px); background: var(--bg-elev); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 10px 12px; font-size: 13px; box-shadow: var(--shadow-sm); }
    .card .k { display: flex; align-items: center; gap: 7px; color: var(--fg-dim); font-size: 12px; font-weight: 650; }
    .card .k .ico { width: 14px; height: 14px; color: var(--accent); }
    .card .k .nm { font-family: var(--mono); font-size: 12px; color: var(--fg); }
    .tool .k .nm { color: var(--accent); }
    .code { margin-top: 8px; background: var(--bg-code); border: 1px solid var(--line-soft); border-radius: var(--radius-xs); padding: 8px 10px; font-family: var(--mono); font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; color: #cdd6e3; overflow-x: auto; }
    .code .prompt { color: var(--accent); user-select: none; }
    .err { border-color: rgba(255,107,107,.42); background: linear-gradient(180deg, rgba(255,107,107,.05), transparent), var(--bg-elev); }
    .err .k { color: var(--err); } .err .k .ico { color: var(--err); }
    .err .code { color: #ffc9c9; border-color: rgba(255,107,107,.25); }
    .sys { color: var(--fg-dim); font-size: 12px; font-style: italic; text-align: center; margin: var(--s3) 0; }

    /* ── approval card ───────────────────────────────────────────────── */
    .approval { border-color: rgba(245,196,81,.5); background: linear-gradient(180deg, rgba(245,196,81,.07), transparent 60%), var(--bg-elev); }
    .approval.high { border-color: rgba(255,107,107,.55); background: linear-gradient(180deg, rgba(255,107,107,.09), transparent 60%), var(--bg-elev); }
    .approval .risk { display: inline-flex; align-items: center; gap: 6px; padding: 4px 11px; border-radius: 999px; font-size: 11px; font-weight: 800; letter-spacing: .02em; }
    .approval .risk .ico { width: 13px; height: 13px; }
    .approval .risk.low { background: var(--accent-soft); color: var(--ok); }
    .approval .risk.medium { background: rgba(245,196,81,.15); color: var(--warn); }
    .approval .risk.high { background: rgba(255,107,107,.16); color: var(--err); }
    .approval .ttl { margin-top: 10px; font-weight: 650; font-size: 14px; }
    .approval .actions { display: flex; gap: var(--s3); margin-top: var(--s3); }
    .approval button { flex: 1; padding: 12px; border-radius: var(--radius-sm); border: 0; font-weight: 800; font-size: 14px; cursor: pointer; min-height: 47px; }
    .approval .approve { background: var(--accent); color: var(--accent-ink); }
    .approval .approve:active { filter: brightness(.92); }
    .approval .reject { background: transparent; border: 1px solid var(--line); color: var(--fg); }
    .approval.high .approve { background: var(--err); color: #240909; }
    .approval .resolved { margin-top: 10px; color: var(--fg-dim); font-size: 12.5px; display: inline-flex; align-items: center; gap: 6px; }

    /* ── composer ────────────────────────────────────────────────────── */
    footer { border-top: 1px solid var(--line); background: var(--bg-elev); padding: var(--s3) var(--s4); padding-bottom: max(var(--s3), env(safe-area-inset-bottom)); }
    .hint { font-size: 11px; color: var(--fg-faint); margin-bottom: var(--s2); line-height: 1.45; }
    .inputrow { display: flex; gap: var(--s2); align-items: flex-end; }
    textarea { flex: 1; min-height: 47px; max-height: 160px; resize: none; border-radius: var(--radius); border: 1px solid var(--line); background: var(--bg); color: var(--fg); padding: 13px 14px; font-size: 15px; font-family: inherit; line-height: 1.4; transition: border-color .15s, box-shadow .15s; }
    textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(56,224,200,.12); }
    textarea::placeholder { color: var(--fg-faint); }
    .send { display: inline-flex; align-items: center; gap: 6px; border: 0; border-radius: var(--radius); background: var(--accent); color: var(--accent-ink); padding: 0 18px; height: 47px; font-weight: 800; font-size: 14px; cursor: pointer; flex: none; }
    .send:disabled { opacity: .35; }
    .send:not(:disabled):active { filter: brightness(.92); }
    .stop { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--err); color: var(--err); background: transparent; border-radius: var(--radius); padding: 0 15px; height: 47px; font-weight: 800; cursor: pointer; flex: none; }

    /* ── empty / connection state cards ──────────────────────────────── */
    .empty-wrap { height: 100%; display: flex; align-items: center; justify-content: center; padding: var(--s5); }
    .estate { max-width: 340px; text-align: center; }
    .estate .glyph { width: 56px; height: 56px; margin: 0 auto var(--s4); border-radius: 16px; display: grid; place-items: center; background: var(--bg-elev); border: 1px solid var(--line); color: var(--accent); box-shadow: var(--shadow); }
    .estate .glyph .ico { width: 26px; height: 26px; stroke-width: 1.6; }
    .estate.spin .glyph { animation: float 2.4s ease-in-out infinite; }
    @keyframes float { 50% { transform: translateY(-5px); } }
    .estate h2 { font-size: 17px; font-weight: 700; margin: 0 0 var(--s2); }
    .estate p { font-size: 13px; color: var(--fg-dim); line-height: 1.6; margin: 0; }
    .estate.warn .glyph { color: var(--warn); border-color: rgba(245,196,81,.4); }
    .estate.err .glyph { color: var(--err); border-color: rgba(255,107,107,.4); }

    /* ── rooms overlay / nav rail ────────────────────────────────────── */
    .overlay { position: fixed; inset: 0; z-index: 30; display: flex; flex-direction: column; background: var(--bg); padding-top: max(0px, env(safe-area-inset-top)); animation: fade .18s ease-out; }
    @keyframes fade { from { opacity: 0; } }
    .overlay-head { display: flex; align-items: center; gap: var(--s3); padding: var(--s4); border-bottom: 1px solid var(--line); }
    .overlay-head .title { font-weight: 700; flex: 1; font-size: 15px; }
    .overlay-body { flex: 1; overflow-y: auto; padding: var(--s4); }
    .rowbtn { display: flex; align-items: center; gap: var(--s2); width: 100%; text-align: left; padding: 13px; margin-bottom: var(--s3); border-radius: var(--radius-sm); border: 1px dashed var(--line); background: var(--bg-elev); color: var(--accent); font-size: 14px; font-weight: 600; cursor: pointer; }
    .rowbtn:hover { border-color: var(--accent); }
    .rowbtn .meta { color: var(--fg-faint); font-weight: 500; font-size: 11px; font-family: var(--mono); }
    .rowbtn.col { flex-direction: column; align-items: flex-start; gap: 2px; }
    .roomitem { display: flex; align-items: center; gap: var(--s3); padding: 12px 13px; margin-bottom: var(--s3); border-radius: var(--radius-sm); border: 1px solid var(--line); background: var(--bg-elev); cursor: pointer; transition: border-color .15s, background .15s; }
    .roomitem:hover { border-color: var(--accent); }
    .roomitem.active { border-color: var(--accent); background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent); }
    .roomitem .rpip { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--fg-faint); }
    .roomitem .rpip.open { background: var(--ok); box-shadow: 0 0 0 3px rgba(69,212,131,.18); animation: pulse 1.4s ease-in-out infinite; }
    .roomitem .rmain { flex: 1; min-width: 0; }
    .roomitem .nm { font-weight: 650; font-size: 14px; display: flex; align-items: center; gap: 7px; }
    .roomitem .cwd { color: var(--fg-dim); font-size: 11px; word-break: break-all; font-family: var(--mono); margin-top: 2px; opacity: .8; }
    .roomitem .mode { font-size: 9.5px; padding: 2px 7px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-weight: 700; letter-spacing: .02em; flex: none; }
    .roomitem .mode.danger { background: rgba(255,107,107,.16); color: var(--danger); }
    .section-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: .09em; color: var(--fg-faint); font-weight: 700; margin: var(--s1) 2px var(--s3); }

    /* ── iPad / wide: two-pane ───────────────────────────────────────── */
    @media (min-width: 820px) {
      #app { border-left: 1px solid var(--line-soft); border-right: 1px solid var(--line-soft); }
      .ctxbar .acts .wide-hide { display: none; }
      #nav { display: flex; flex-direction: column; width: 286px; flex: none; border-right: 1px solid var(--line); background: var(--bg-elev); overflow-y: auto; }
      #nav .nav-head { padding: var(--s4) var(--s4) var(--s3); display: flex; align-items: center; gap: var(--s2); }
      #nav .nav-head .title { font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--fg-dim); flex: 1; display: flex; align-items: center; gap: 7px; }
      #nav .nav-head .title .ico { width: 14px; height: 14px; color: var(--accent); }
      #nav .nav-body { padding: 0 var(--s3) var(--s4); }
      .overlay.as-nav { position: static; inset: auto; z-index: auto; background: transparent; padding-top: 0; animation: none; }
      .overlay.as-nav .overlay-head { display: none; }
      .overlay.as-nav .overlay-body { padding: 0; }
      main { padding: var(--s6) 28px var(--s3); }
      .bubble, .card { max-width: 660px; }
    }
    @media (min-width: 820px) and (max-width: 1024px) { #nav { width: 248px; } }
  </style>
</head>
<body>
  <div id="app">
    <header>
      <span class="brand"><span class="mark">C</span>CodeShell</span>
      <span id="statusbadge" class="status"><span class="pip"></span><span id="runstate">连接中</span></span>
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
        <div class="nav-head">
          <span class="title"><svg class="ico" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>房间 · 常驻 CC</span>
          <button id="navnew" class="iconbtn">+ 新建</button>
        </div>
        <div class="nav-body" id="navbody"></div>
      </aside>

      <main id="feed">
        <div id="empty" class="empty-wrap"></div>
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
    var statusBadge = document.getElementById('statusbadge');
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

    // ── inline SVG icon set (no external assets) ───────────────────
    var ICONS = {
      search: '<path d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3"/>',
      edit:   '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
      file:   '<path d="M14 3v5h5M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>',
      term:   '<path d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM7 9l3 3-3 3M13 15h4"/>',
      folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
      globe:  '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/>',
      web:    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/>',
      cog:    '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
      warn:   '<path d="M12 3l9 16H3zM12 10v4M12 17.5v.5"/>',
      plug:   '<path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5"/>',
      link:   '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
      spark:  '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
      send:   '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
      square: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
      rooms:  '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
    };
    function icon(name, cls) {
      return '<svg class="ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24">' + (ICONS[name] || ICONS.cog) + '</svg>';
    }
    function toolIcon(name) {
      var n = String(name || '').toLowerCase();
      if (n.indexOf('grep') >= 0 || n.indexOf('search') >= 0 || n === 'glob') return 'search';
      if (n.indexOf('edit') >= 0 || n.indexOf('write') >= 0 || n.indexOf('patch') >= 0 || n.indexOf('notebook') >= 0) return 'edit';
      if (n.indexOf('read') >= 0 || n.indexOf('view') >= 0) return 'file';
      if (n.indexOf('bash') >= 0 || n.indexOf('shell') >= 0 || n.indexOf('exec') >= 0) return 'term';
      if (n.indexOf('web') >= 0 || n.indexOf('fetch') >= 0) return 'web';
      if (n.indexOf('ls') >= 0 || n.indexOf('dir') >= 0 || n.indexOf('folder') >= 0) return 'folder';
      return 'cog';
    }

    function showEmpty(kind, title, body) {
      empty.style.display = '';
      feed.querySelectorAll('.row').forEach(function (r) { /* keep messages out of empty wrap */ });
      var g = kind === 'spin' ? 'spark' : kind === 'warn' ? 'plug' : kind === 'err' ? 'link' : 'spark';
      empty.innerHTML =
        '<div class="estate ' + kind + '"><div class="glyph">' + icon(g) + '</div>' +
        '<h2>' + esc(title) + '</h2><p>' + body + '</p></div>';
    }
    function hideEmpty() { if (empty) { empty.style.display = 'none'; empty.innerHTML = ''; } }
    function scroll() { feed.scrollTop = feed.scrollHeight; }

    function setRun(state) {
      running = (state === 'running');
      var cls = state === 'running' ? 'run' : state === 'waiting' ? 'wait' : state === 'error' ? 'err' : authed ? 'ok' : '';
      statusBadge.className = 'status ' + cls;
      runstate.textContent =
        state === 'running' ? '运行中' :
        state === 'waiting' ? '等待审批' :
        state === 'completed' ? '已完成' :
        state === 'error' ? '出错' : (authed ? '已连接' : '连接中');
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

    // tool card: icon + name header, args/command in a code block
    function toolCard(name, payload, isResult, isError) {
      var el = addRow('assistant', 'card tool' + (isError ? ' err' : ''));
      var label = isResult ? '工具结果' : '工具';
      el.innerHTML = '<div class="k">' + icon(toolIcon(name)) + '<span>' + label + '</span>' + (name ? ' · <span class="nm">' + esc(name) + '</span>' : '') + '</div>';
      if (payload) {
        var c = document.createElement('div'); c.className = 'code';
        var isCmd = String(name || '').toLowerCase().indexOf('bash') >= 0;
        if (isCmd) { c.innerHTML = '<span class="prompt">$ </span>'; c.appendChild(document.createTextNode(payload)); }
        else c.textContent = payload;
        el.appendChild(c);
      }
      return el;
    }
    function toolStart(id, name, args) {
      var summary = '';
      var keys = ['command', 'file_path', 'path', 'url', 'pattern', 'query'];
      for (var i = 0; i < keys.length; i++) { if (args && typeof args[keys[i]] === 'string') { summary = args[keys[i]]; break; } }
      toolEls[id] = toolCard(name, summary, false, false);
      scroll();
    }
    function toolSummary(text) { toolCard('', text, true, false); scroll(); }
    function sysErr(text) {
      var el = addRow('assistant', 'card err');
      el.innerHTML = '<div class="k">' + icon('warn') + '<span>错误</span></div>';
      var c = document.createElement('div'); c.className = 'code'; c.textContent = text; el.appendChild(c);
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
        '<div><span class="risk ' + risk + '">' + (risk === 'high' ? icon('warn') + '高风险' : risk === 'medium' ? '中风险' : '低风险') + '</span></div>' +
        '<div class="ttl">' + esc(info.title) + '</div>' +
        '<div class="code">' + esc(info.body) + '</div>' +
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
        showEmpty('spin', '已连接', '发个任务试试,或在「房间」里开常驻 Claude Code 会话。');
        if (wideMq.matches) openRooms();
        return;
      }
      if (msg.type === 'auth.failed' || msg.type === 'pair.failed') {
        authed = false; sendBtn.disabled = true; setRun('');
        showEmpty('err', msg.type === 'pair.failed' ? '配对失败' : '认证失败', esc(msg.message || '请重新从桌面端扫码配对。'));
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
          clearFeed();
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
      showEmpty('spin', '正在连接…', '等待与 CodeShell 建立通道');
      ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws');
      ws.onopen = function () {
        wsReady = true;
        showEmpty('spin', '认证中…', '正在校验设备身份');
        if (pairingToken) {
          send({ type: 'pair.complete', token: pairingToken, name: getDeviceName(), secretHash: getSecret() });
        } else if (getDeviceId()) {
          send({ type: 'auth.device', deviceId: getDeviceId(), secretHash: getSecret() });
        } else {
          showEmpty('warn', '未配对', '请在 CodeShell 桌面端打开<br>「设置 → 远程」,扫码或打开配对链接。');
        }
      };
      ws.onmessage = function (e) { handle(e.data); };
      ws.onclose = function () {
        wsReady = false; authed = false; sendBtn.disabled = true; setRun('');
        showEmpty('err', '连接断开', '3 秒后自动重连…');
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

    // Clear only message rows (keep the empty wrapper element in the DOM).
    function clearFeed() {
      feed.querySelectorAll('.row').forEach(function (r) { r.remove(); });
      liveAssistant = null; toolEls = {};
    }

    function renderRoomMsg(m) {
      if (!m) return;
      hideEmpty();
      if (m.from === 'user' && m.type === 'text') { addRow('user', 'bubble').textContent = m.text || ''; return; }
      if (m.from === 'agent' && m.type === 'text') { assistantChunk(m.text || ''); endAssistant(); return; }
      if (m.from === 'agent' && m.type === 'tool') { toolCard(m.tool || '', m.summary || '', false, false); return; }
      if (m.from === 'agent' && m.type === 'tool_result') { toolCard(m.tool || '', m.summary || '', true, !!m.isError); return; }
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
      if (!rooms.length) { roomList.innerHTML = '<p class="section-label" style="text-align:center;margin-top:18px">还没有房间,点上方新建</p>'; return; }
      rooms.forEach(function (r) {
        var danger = r.permissionMode === 'bypassPermissions';
        var active = currentRoom && currentRoom.id === r.id;
        var el = document.createElement('div');
        el.className = 'roomitem' + (active ? ' active' : '');
        el.innerHTML =
          '<span class="rpip ' + (r.open ? 'open' : '') + '"></span>' +
          '<div class="rmain"><div class="nm">' + esc(r.name) +
          '<span class="mode ' + (danger ? 'danger' : '') + '">' + (danger ? 'dangerous' : esc(r.permissionMode)) + '</span></div>' +
          '<div class="cwd">' + esc(r.cwd) + '</div></div>';
        el.onclick = function () { enterRoom(r); };
        roomList.appendChild(el);
      });
    }

    function enterRoom(r) {
      currentRoom = r; roomSeq = 0;
      ctxLabel.textContent = '房间'; sidEl.textContent = r.name;
      input.placeholder = '在房间「' + r.name + '」里跟 Claude Code 对话…';
      clearFeed();
      closeRooms();
      renderRoomList(lastRooms);
      send({ type: 'room.open', roomId: r.id });
      send({ type: 'room.history', roomId: r.id, sinceSeq: 0 });
    }

    function leaveRoom() {
      currentRoom = null;
      ctxLabel.textContent = '会话'; sidEl.textContent = currentSession || '—';
      input.placeholder = '给 CodeShell 发个任务…';
      clearFeed();
      showEmpty('spin', '新会话', '发个任务试试。');
      renderRoomList(lastRooms);
    }

    function renderProjects(projects) {
      projList.innerHTML = '';
      if (!projects.length) { projList.innerHTML = '<p class="section-label" style="text-align:center">无最近项目,可在桌面打开一个项目后再来</p>'; return; }
      projects.forEach(function (p) {
        var b = document.createElement('button');
        b.className = 'rowbtn col';
        b.innerHTML = '<div>' + esc(p.name) + '</div><div class="meta">' + esc(p.path) + '</div>';
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
      clearFeed();
      showEmpty('spin', '新会话', '发个任务试试。');
    };

    if (wideMq.addEventListener) wideMq.addEventListener('change', function () { syncRoomsPlacement(); if (authed) send({ type: 'room.list' }); });
    syncRoomsPlacement();

    connect();
  </script>
</body>
</html>`;
}
