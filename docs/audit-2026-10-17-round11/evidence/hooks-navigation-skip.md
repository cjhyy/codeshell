# Static navigation failure (tool-output transcription)

The first caller search mistakenly supplied three paths that had not appeared in the inventory. The command returned exit 2. This is a transcription of the tool response, not a raw process log:

```text
rg: packages/core/src/extension.ts: No such file or directory (os error 2)
rg: packages/core/src/engine/goal-run-controller.ts: No such file or directory (os error 2)
rg: packages/core/src/engine/hook-wiring.ts: No such file or directory (os error 2)
packages/core/src/index.ts:262:export { HookRegistry } from "./hooks/registry.js";
packages/core/src/engine/engine.ts:53:import { HookRegistry } from "../hooks/registry.js";
packages/core/src/engine/engine.ts:344:  private hooks: HookRegistry;
packages/core/src/engine/engine.ts:462:   * HookRegistry, so a second run must not enter until the first has completed
packages/core/src/engine/engine.ts:584:        this.hooks.register(
packages/core/src/engine/engine.ts:595:   * Re-apply settings.hooks onto the live HookRegistry after a settings
packages/core/src/engine/engine.ts:764:      this.hooks = new HookRegistry();
packages/core/src/engine/engine.ts:790:        this.lifetime.own(this.hooks.register(hook.event, hook.handler, hook.priority, hook.name));
packages/core/src/engine/engine.ts:793:        this.lifetime.own(this.hooks.register(hook.event, hook.handler, hook.priority, hook.name));
packages/core/src/engine/engine.ts:887:    const dispose = this.hooks.register("on_stop", handler, 0, "goal-stop");
packages/core/src/engine/engine.ts:3381:    // know about HookRegistry — the buffer is the seam).
packages/core/src/engine/engine.ts:3697:  getHookRegistry(): HookRegistry {
```

The nonexistent extension/controller/wiring directions are skipped. No alternate-path search, product run, fixture repair or retry was performed for them. The already inventoried registry and index source remain independent inputs; no product test had been launched by this failed navigation.
