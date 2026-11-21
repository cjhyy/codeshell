// Playwright serializes this function into the fixture's Electron Main. Install
// before reloading the workbench so its negotiated port uses the fixture reads.
// Unregistered requests and all lifecycle traffic still reach the real Host.
export function installWorkbenchReadFixture({ BrowserWindow, MessageChannelMain }) {
  const frame = BrowserWindow.getAllWindows()[0].webContents.mainFrame;
  const proto = Object.getPrototypeOf(frame);
  const post = proto.postMessage;
  const reads = new Map();
  globalThis.__workbenchFixtureReads = reads;
  proto.postMessage = function (channel, message, ports) {
    if (channel !== "desktop-host:port" || ports?.length !== 1) return post.apply(this, arguments);
    const [host] = ports;
    const { port1: client, port2: page } = new MessageChannelMain();
    const forward = ({ data, ports: transferred }) => host.postMessage(data, transferred);
    client.on("message", async (event) => {
      const req = event.data;
      const read = req?.jsonrpc === "2.0" && req.id != null && reads.get(req.method);
      if (!read) return forward(event);
      try {
        const result = await read(req.params, () => forward(event));
        if (result !== undefined) client.postMessage({ jsonrpc: "2.0", id: req.id, result });
      } catch (error) {
        client.postMessage({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32603, message: String(error.message || error) },
        });
      }
    });
    host.on("message", ({ data, ports: transferred }) => client.postMessage(data, transferred));
    host.once("close", () => client.close());
    client.once("close", () => host.close());
    host.start();
    client.start();
    return post.call(this, channel, message, [page]);
  };
}
