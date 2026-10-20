import { describe, expect, test } from "bun:test";
import { MatrixAdapter } from "./matrix.js";

const HOMESERVER = "https://matrix.example";
const ROOM = "!room:matrix.example";

describe("Matrix adapter", () => {
  test("learns its own user id from whoami and ignores its own replies", async () => {
    const result = await runEcho();
    expect(result.requests[0]).toBe("/_matrix/client/v3/account/whoami");
    expect(result.dispatched).toEqual(["@owner:matrix.example"]);
    expect(result.sends).toBe(1);
  });

  test("uses a configured botUserId without asking the homeserver", async () => {
    const result = await runEcho("@bot:matrix.example");
    expect(result.requests).not.toContain("/_matrix/client/v3/account/whoami");
    expect(result.dispatched).toEqual(["@owner:matrix.example"]);
  });
});

/** One owner message, then the homeserver echoes this bot's own room messages back. */
async function runEcho(botUserId?: string) {
  const abort = new AbortController();
  const requests: string[] = [];
  const dispatched: string[] = [];
  let syncs = 0;
  let sends = 0;
  const transport = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(HOMESERVER);
    requests.push(url.pathname);
    if (url.pathname === "/_matrix/client/v3/account/whoami") {
      return Response.json({ user_id: "@bot:matrix.example" });
    }
    if (url.pathname === "/_matrix/client/v3/sync") {
      syncs += 1;
      if (syncs > 3) {
        abort.abort();
        return Response.json({ next_batch: String(syncs) });
      }
      const fromOwner = syncs === 1;
      return Response.json({
        next_batch: String(syncs),
        rooms: {
          join: {
            [ROOM]: {
              timeline: {
                events: [
                  {
                    event_id: `$event-${syncs}`,
                    type: "m.room.message",
                    sender: fromOwner ? "@owner:matrix.example" : "@bot:matrix.example",
                    origin_server_ts: Date.now(),
                    content: { msgtype: "m.text", body: fromOwner ? "hello" : "bot reply" },
                  },
                ],
              },
            },
          },
        },
      });
    }
    expect(init?.method).toBe("PUT");
    sends += 1;
    return Response.json({ event_id: `$sent-${sends}` });
  }) as typeof fetch;
  const adapter = new MatrixAdapter(
    { homeserverUrl: HOMESERVER, accessToken: "token", ...(botUserId ? { botUserId } : {}) },
    transport,
  );
  await adapter.run(async (message) => {
    dispatched.push(message.senderId);
    await adapter.send(message.target, { text: `reply to ${message.text}` });
  }, abort.signal);
  return { requests, dispatched, sends };
}
