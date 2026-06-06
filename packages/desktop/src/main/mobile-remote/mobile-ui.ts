export function mobileRemoteHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CodeShell Mobile Remote</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; background: #0b0f17; color: #e5e7eb; }
    main { max-width: 720px; margin: 0 auto; padding: 20px; }
    textarea { width: 100%; min-height: 96px; border-radius: 12px; border: 1px solid #374151; background: #111827; color: #fff; padding: 12px; box-sizing: border-box; }
    button { border: 0; border-radius: 999px; background: #60a5fa; color: #06111f; padding: 10px 16px; font-weight: 700; }
    pre { white-space: pre-wrap; background: #111827; border-radius: 12px; padding: 12px; }
    .danger { color: #fca5a5; font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <h1>CodeShell Mobile Remote</h1>
    <p id="status">Connecting...</p>
    <textarea id="input" placeholder="Send a task, /cc task, /cc --safe task, /cc --dangerous task, or /codex task"></textarea>
    <p><button id="send">Send</button></p>
    <pre id="log"></pre>
  </main>
  <script>
    const log = document.getElementById('log');
    const status = document.getElementById('status');
    const input = document.getElementById('input');
    const send = document.getElementById('send');
    const wsUrl = location.origin.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => { status.textContent = 'Connected'; ws.send(JSON.stringify({ type: 'hello.mobile' })); };
    ws.onmessage = (event) => { log.textContent += event.data + '\\n'; };
    ws.onclose = () => { status.textContent = 'Disconnected'; };
    send.onclick = () => { ws.send(JSON.stringify({ type: 'chat.send', text: input.value })); input.value = ''; };
  </script>
</body>
</html>`;
}
