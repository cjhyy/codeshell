import { expect, mock, spyOn, test } from "bun:test";
import { recentRead } from "./composerGlobalReads";

test("session switches share a pending or recent read and can retry failed or expired reads", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(0);
  try {
    const pending = Promise.withResolvers<number>();
    const load = mock(() => pending.promise);
    const read = recentRead(load);
    const initial = read();
    clock.mockReturnValue(75_000);
    expect(read()).toBe(initial);
    pending.resolve(1);
    expect(await read()).toBe(1);
    expect(read()).toBe(initial);
    clock.mockReturnValue(135_000);
    load.mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce(2);
    await expect(read()).rejects.toThrow("unavailable");
    expect(await read()).toBe(2);
    expect(load).toHaveBeenCalledTimes(3);
  } finally {
    clock.mockRestore();
  }
});
