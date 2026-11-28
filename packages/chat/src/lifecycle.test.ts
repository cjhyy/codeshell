import { expect, test } from "bun:test";
import { raceAbort } from "./lifecycle.js";

test("raceAbort removes its abort listener once the promise wins", async () => {
  const controller = new AbortController();
  let listeners = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = ((...args: Parameters<typeof add>) => {
    listeners++;
    add(...args);
  }) as typeof add;
  controller.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
    listeners--;
    remove(...args);
  }) as typeof remove;
  for (let attempt = 0; attempt < 5; attempt++)
    await raceAbort(Promise.resolve(), controller.signal);
  expect(listeners).toBe(0);
  let settled = false;
  const pending = raceAbort(new Promise(() => {}), controller.signal).then(() => {
    settled = true;
  });
  controller.abort();
  await pending;
  expect(settled).toBe(true);
});
