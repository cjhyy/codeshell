import { Button } from "@ui/button";

/**
 * Top-level mobile app. Phase 0 is a scaffold placeholder that proves the
 * shared shadcn components (@ui) + the renderer token system resolve and
 * render in a plain browser bundle. The connection state machine
 * (pairing → auth → chat/rooms) lands in Phase 1.
 */
export function App() {
  return (
    <div className="grid min-h-dvh place-items-center bg-background text-foreground">
      <div className="flex flex-col items-center gap-3">
        <div className="grid size-10 place-items-center rounded-lg bg-primary font-black text-primary-foreground">
          C
        </div>
        <h1 className="text-lg font-semibold tracking-tight">CodeShell Remote</h1>
        <p className="text-sm text-muted-foreground">脚手架就绪 · shadcn 复用通过</p>
        <Button>开始</Button>
      </div>
    </div>
  );
}
