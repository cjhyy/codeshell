import { createInterface } from "node:readline";
import { lstatSync, realpathSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import { installCloudControlConfinement } from "./cloud-control-confinement.ts";

const confinement = installCloudControlConfinement();
const directory = realpathSync(process.argv[2]);
const inside = relative(realpathSync(process.env.HOME), directory);
if (!inside || inside.startsWith("..") || isAbsolute(inside))
  throw new Error("Controller owner fixture requires a private HOME directory.");
const { acquireProjectControllerLock } = await import("../lock.ts");
const lock = acquireProjectControllerLock(directory);
const report = (value) => process.stdout.write(JSON.stringify(value) + "\n");
report({ ready: true, pid: process.pid, ino: lstatSync(directory + ".lock").ino });
try {
  for await (const line of createInterface({ input: process.stdin })) {
    if (line === "check") {
      lock.assertHeld();
      report({ held: true });
    } else if (line === "close") {
      lock.release();
      report({ closed: true });
      break;
    } else throw new Error("Unknown controller owner fixture command.");
  }
} finally {
  lock.release();
  process.stdin.destroy();
  confinement.restore();
}
