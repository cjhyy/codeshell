# Mobile Remote Smoke Test

## Preconditions

- CodeShell Electron is running.
- The phone is on the same LAN as the Mac, or the user has a self-managed tunnel
  (SSH / Tailscale / WireGuard). No public relay is provided.
- For `/cc`, Claude Code CLI is installed and logged in.
- For `/codex`, Codex CLI is installed and logged in.

## Steps

1. Open Electron Settings → 手机遥控 (Mobile Remote).
2. Click "开启手机遥控" (Start mobile remote).
3. Open the pairing URL on a phone browser (it is one-time, 10-minute TTL).
4. Pair the device (the phone supplies a name + device secret).
5. Send a normal chat message and confirm a streaming response appears.
6. Send `/cc --safe echo a short status about this repo`.
7. Confirm a Claude Code job starts in safe mode.
8. Send `/cc --dangerous inspect the repo and summarize the package scripts`
   from a NON-trusted workspace and confirm a high-risk approval card appears
   (the job does NOT start until approved).
9. Configure the current workspace as trusted with `defaultMode: dangerous` and
   `autoStartInTrustedWorkspaces: true` (see config below).
10. Send `/cc inspect the repo and summarize the package scripts` and confirm it
    starts in dangerous mode without a high-risk prompt.
11. Revoke the phone device in Electron settings.
12. Refresh the phone page and confirm it cannot reconnect (auth.failed).

## Example config (`~/.code-shell/settings.json`)

```json
{
  "externalAgents": {
    "claudeCode": {
      "command": "claude",
      "defaultMode": "dangerous",
      "dangerousArgs": ["--dangerously-skip-permissions"],
      "trustedWorkspaces": ["/Users/admin/Documents/个人学习/代码学习/codeshell"],
      "autoStartInTrustedWorkspaces": true
    },
    "codex": { "command": "codex", "args": [] }
  }
}
```

## Expected result

The phone can control CodeShell chat, launch external agent jobs, approve
required actions, and cannot reconnect after revocation. Dangerous Claude Code
mode auto-starts ONLY inside a trusted workspace with `autoStartInTrustedWorkspaces`;
everywhere else it requires an explicit high-risk approval on the phone.

## Security invariants exercised

- Remote host is OFF by default; the user must Start it explicitly.
- Host binds to `127.0.0.1` / LAN only — never `0.0.0.0` / public.
- Pairing tokens are single-use and expire (default 10 minutes).
- Unauthenticated WebSocket sockets cannot send chat/approval/run/job events
  and never receive session output.
- All chat and approval routing goes through the existing CodeShell worker
  run/permission path (`AgentBridge.injectWorkerMessage`) — there is no second
  run loop and tool permissions are not bypassed.
- Dangerous-mode args come from config (never a shell string), and external
  agents are spawned via argument arrays so prompt text can't inject flags.

## What is NOT yet automated (manual only)

- Real device pairing from a phone browser (the WS client UI is the minimal v1
  shell in `mobile-ui.ts`; pairing/auth round-trip from a real browser is
  manual).
- Approval-resume of a gated dangerous `/cc` job: v1 surfaces the high-risk
  approval card to the phone but does not yet auto-start the job on approve —
  the user re-issues the command with `--dangerous` from a trusted workspace,
  or approves and re-sends. Wiring approve→start is a follow-up.
- End-to-end streaming of external-agent job output into the phone UI is
  broadcast on the `externalAgent` channel but the minimal mobile UI only
  appends raw lines; a richer job card is Phase 4 polish.
