import { expect, test } from "bun:test";
import { MatrixAdapter } from "../../../packages/chat/src/matrix.ts";

async function runEcho(botUserId?: string) {
  const abort = new AbortController();
  const dispatched: string[] = [];
  let syncs = 0, sends = 0;
  const transport: typeof fetch = async (request, init) => {
    const url = new URL(String(request));
    expect(url.origin).toBe("https://fixture.invalid");
    if (url.pathname.endsWith("/sync")) {
      syncs++;
      // A real homeserver returns a user's input followed by this bot's room messages.
      if (syncs > 3 || (botUserId && syncs === 3)) {
        abort.abort();
        return Response.json({ next_batch: String(syncs), rooms: {} });
      }
      return Response.json({ next_batch: String(syncs), rooms: { join: { "!room:fixture.invalid": { timeline: { events: [{
        event_id: `$event-${syncs}`, type: "m.room.message",
        sender: syncs === 1 ? "@owner:fixture.invalid" : "@bot:fixture.invalid",
        origin_server_ts: Date.now(), content: { msgtype: "m.text", body: syncs === 1 ? "hello" : "echo from bot" },
      }] } } } } });
    }
    expect(init?.method).toBe("PUT");
    sends++;
    return Response.json({ event_id: `$sent-${sends}` });
  };
  const adapter = new MatrixAdapter({ homeserverUrl: "https://fixture.invalid", accessToken: "fake-fixture-token", ...(botUserId ? { botUserId } : {}) }, transport);
  await adapter.run(async (message) => {
    dispatched.push(message.senderId);
    await adapter.send(message.target, { text: `reply to ${message.text}` });
  }, abort.signal);
  return { dispatched, sends };
}

test("optional Matrix botUserId omitted: adapter consumes its own replies repeatedly", async () => {
  const observed = await runEcho();
  expect(observed.dispatched).toEqual(["@owner:fixture.invalid", "@bot:fixture.invalid", "@bot:fixture.invalid"]);
  expect(observed.sends).toBe(3);
  console.log("AUDIT Matrix optional botUserId omitted: own replies dispatch and trigger further sends");
});

test("configured Matrix botUserId excludes own replies", async () => {
  const observed = await runEcho("@bot:fixture.invalid");
  expect(observed.dispatched).toEqual(["@owner:fixture.invalid"]);
  expect(observed.sends).toBe(1);
});
