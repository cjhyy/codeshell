// Worker entry for Pierre's highlight pool. Vite bundles this module (and the
// grammars it lazy-loads) when ./pierreViews creates it with
// `new Worker(new URL("./pierre.worker.ts", import.meta.url))`.
import "@pierre/diffs/worker/worker.js";
