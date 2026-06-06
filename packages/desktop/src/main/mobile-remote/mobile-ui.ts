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
    <p><button id="send" disabled>Send</button></p>
    <pre id="log"></pre>
  </main>
  <script>
    var log = document.getElementById('log');
    var status = document.getElementById('status');
    var input = document.getElementById('input');
    var send = document.getElementById('send');

    function setStatus(t) { status.textContent = t; }
    function append(line) { log.textContent += line + '\\n'; }

    // Device identity persists across reloads so a paired phone reconnects
    // without re-scanning. The secret is a random per-device shared key sent
    // both at pairing time (stored server-side) and at auth time (compared).
    function getSecret() {
      var s = localStorage.getItem('cs.deviceSecret');
      if (!s) {
        var bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        s = Array.from(bytes).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
        localStorage.setItem('cs.deviceSecret', s);
      }
      return s;
    }
    function getDeviceId() { return localStorage.getItem('cs.deviceId') || ''; }
    function getDeviceName() {
      var n = localStorage.getItem('cs.deviceName');
      if (!n) { n = (navigator.platform || 'Phone') + ' browser'; localStorage.setItem('cs.deviceName', n); }
      return n;
    }

    var pairingToken = new URLSearchParams(location.search).get('pairing');
    var authed = false;
    var wsUrl = location.origin.replace(/^http/, 'ws') + '/ws';
    var ws = new WebSocket(wsUrl);

    ws.onopen = function () {
      setStatus('Connected — authenticating...');
      if (pairingToken) {
        // First time on this phone: complete pairing, then auth follows on pair.ok.
        ws.send(JSON.stringify({ type: 'pair.complete', token: pairingToken, name: getDeviceName(), secretHash: getSecret() }));
      } else if (getDeviceId()) {
        ws.send(JSON.stringify({ type: 'auth.device', deviceId: getDeviceId(), secretHash: getSecret() }));
      } else {
        setStatus('Not paired — open the pairing link from CodeShell settings.');
      }
    };

    ws.onmessage = function (event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { append(event.data); return; }
      if (msg.type === 'pair.ok') {
        // Persist the assigned device id, then authenticate this socket.
        localStorage.setItem('cs.deviceId', msg.device.id);
        ws.send(JSON.stringify({ type: 'auth.device', deviceId: msg.device.id, secretHash: getSecret() }));
        // Drop the one-use pairing token from the URL so a reload re-auths cleanly.
        history.replaceState(null, '', location.pathname);
        return;
      }
      if (msg.type === 'auth.ok') {
        authed = true;
        send.disabled = false;
        setStatus('Authenticated as ' + (msg.device && msg.device.name ? msg.device.name : 'device'));
        return;
      }
      if (msg.type === 'auth.failed' || msg.type === 'pair.failed') {
        setStatus(msg.message || 'Auth failed');
        // A stale device id (e.g. revoked) should not loop — clear it.
        if (msg.type === 'auth.failed') localStorage.removeItem('cs.deviceId');
        return;
      }
      // Any other server event (session stream, approvals, job output) → log.
      append(event.data);
    };

    ws.onclose = function () { authed = false; send.disabled = true; setStatus('Disconnected'); };

    send.onclick = function () {
      if (!authed) { setStatus('Not authenticated yet'); return; }
      var text = input.value.trim();
      if (!text) return;
      ws.send(JSON.stringify({ type: 'chat.send', text: text }));
      append('> ' + text);
      input.value = '';
    };
  </script>
</body>
</html>`;
}
