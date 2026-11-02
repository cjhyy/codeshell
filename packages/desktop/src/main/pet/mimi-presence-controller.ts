import { companionSize } from "../../shared/mimi-companion.js";
import type {
  MimiPresenceMode,
  MimiPresencePatch,
  MimiPresenceSnapshot,
} from "../../shared/mimi-presence.js";
import type { MimiPresenceState, Point } from "./mimi-presence-state.js";

/**
 * One form of Mimi. The contract that makes the two forms mutually exclusive:
 * - `present()` marks the surface as wanted synchronously, before its first await;
 * - `withdraw()` clears that mark and hides the window synchronously;
 * - a surface only ever shows its window while it is marked, so a load, ready
 *   signal or timer that finishes after `withdraw()` cannot show it again.
 */
export interface MimiPresenceSurface {
  /** Resolves once shown; rejects if the surface failed to load or become ready. */
  present(isCurrent: () => boolean): Promise<void>;
  withdraw(): void;
  isVisible(): boolean;
  /** Visual feet of the character in global DIP, when known. */
  feet(): Point | undefined;
  /** Stand at `feet` next time this form is shown (clamped by the surface). */
  placeFeet(feet: Point): void;
}

export interface MimiDockedSurface extends MimiPresenceSurface {
  /** Hide for a computer-use screen capture; returns whether it was visible. */
  setCaptureHidden(hidden: boolean): boolean;
}

export interface MimiMovingSurface extends MimiPresenceSurface {
  setSize(size: number): void;
  /** Play the settings preview on the already presented surface. */
  startPreview(isCurrent: () => boolean): Promise<void>;
  cancelPreview(): void;
}

export interface MimiPresenceControllerOptions {
  initial: MimiPresenceState;
  docked: MimiDockedSurface;
  save(state: MimiPresenceState): Promise<void>;
  onChange(snapshot: MimiPresenceSnapshot): void;
  log?(event: string, data?: Record<string, unknown>): void;
}

const message = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 240) || "未知错误";

/**
 * The single owner of Mimi's desktop presence. Every entry (menus, settings,
 * surface context menus, legacy IPC, preview) goes through `set`/`preview`.
 * Latest request wins: each apply bumps a generation and hides the form that is
 * not wanted before it starts showing the one that is.
 */
export class MimiPresenceController {
  private state: MimiPresenceState;
  private readonly docked: MimiDockedSurface;
  private moving: MimiMovingSurface | undefined;
  private movingUnavailableReason: string | undefined = "正在初始化";
  private movingError: string | undefined;
  private dockedError: string | undefined;
  private started = false;
  private disposed = false;
  private generation = 0;
  private previewToken = 0;
  private previewing = false;
  private shown: MimiPresenceMode | null = null;
  private captureHidden = false;

  constructor(private readonly options: MimiPresenceControllerOptions) {
    this.state = { ...options.initial, size: companionSize(options.initial.size) };
    this.docked = options.docked;
  }

  snapshot(): MimiPresenceSnapshot {
    return {
      visible: this.state.visible,
      mode: this.state.mode,
      size: this.state.size,
      effectiveMode: this.effectiveMode(),
      shown: this.shown,
      movingAvailable: !!this.moving,
      ...(this.moving ? {} : { movingUnavailableReason: this.movingUnavailableReason }),
      ...(this.movingError ? { movingError: this.movingError } : {}),
      ...(this.dockedError ? { dockedError: this.dockedError } : {}),
      previewing: this.previewing,
    };
  }

  persisted(): MimiPresenceState {
    return { ...this.state };
  }

  /**
   * Begin presenting once both forms are known. Before this neither form is
   * shown, so startup can never flash both.
   */
  start(moving: { surface?: MimiMovingSurface; unavailableReason?: string }): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    this.moving = moving.surface;
    this.movingUnavailableReason = moving.surface
      ? undefined
      : (moving.unavailableReason ?? "当前环境不支持移动模式");
    this.moving?.setSize(this.state.size);
    this.started = true;
    return this.apply();
  }

  set(patch: MimiPresencePatch): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const next = { ...this.state };
    if (patch.visible !== undefined) next.visible = patch.visible;
    if (patch.mode !== undefined) next.mode = patch.mode;
    if (patch.size !== undefined) next.size = companionSize(patch.size);
    // Asking for a form again is the retry for its failure.
    if (patch.visible === true) this.dockedError = undefined;
    if (patch.visible === true && next.mode === "moving") this.movingError = undefined;
    if (patch.mode === "moving") this.movingError = undefined;
    if (patch.mode === "docked") this.dockedError = undefined;
    // A preview walks around; its position is not where the user left Mimi.
    const wasShown = this.previewing ? null : this.shown;
    this.state = next;
    if (patch.size !== undefined) this.moving?.setSize(next.size);
    // Any explicit request ends a preview; the request is what the user wants now.
    this.endPreviewSilently();
    this.carryPosition(wasShown);
    this.persist();
    return this.apply();
  }

  /** Retry a failed form without changing preferences. */
  retry(): Promise<boolean> {
    this.movingError = undefined;
    this.dockedError = undefined;
    return this.apply();
  }

  async preview(): Promise<void> {
    if (this.disposed) throw new Error("Mimi 已关闭");
    const moving = this.moving;
    if (!moving) throw new Error(this.movingUnavailableReason ?? "当前环境不支持移动模式");
    this.endPreviewSilently();
    const token = ++this.previewToken;
    this.movingError = undefined;
    this.previewing = true;
    const isCurrent = () => token === this.previewToken && this.previewing && !this.disposed;
    const shown = await this.apply();
    // Superseded by a newer request or preview: that request owns the outcome.
    if (token !== this.previewToken || this.disposed) return;
    if (!shown || this.shown !== "moving" || !this.previewing) {
      this.previewing = false;
      this.emit();
      throw new Error(this.movingError ?? "角色尚未准备好");
    }
    try {
      await moving.startPreview(isCurrent);
    } catch (error) {
      if (token !== this.previewToken || this.disposed) return;
      this.endPreviewSilently();
      await this.apply();
      throw error;
    }
  }

  /** The moving surface finished playing the preview. */
  previewEnded(): void {
    if (!this.previewing) return;
    this.previewing = false;
    this.previewToken++;
    void this.apply();
  }

  /** A surface failed after it was shown (renderer crash, lost window). */
  surfaceFailed(mode: MimiPresenceMode, error: unknown): void {
    if (this.disposed) return;
    this.options.log?.("mimi_presence_surface_failed", { mode, error: message(error) });
    if (mode === "moving") {
      this.movingError = message(error);
      this.endPreviewSilently();
      this.moving?.withdraw();
    } else {
      this.dockedError = message(error);
      this.docked.withdraw();
    }
    if (this.shown === mode) this.shown = null;
    // Moving falls back to docked; a failed docked form stays hidden until retried.
    if (mode === "moving") void this.apply();
    else this.emit();
  }

  /** Called by a surface when the user dragged it somewhere. */
  rememberAnchor(mode: MimiPresenceMode, anchor: Point | undefined): void {
    const key = mode === "docked" ? "dockedAnchor" : "movingAnchor";
    const current = this.state[key];
    if (current?.x === anchor?.x && current?.y === anchor?.y) return;
    const next = { ...this.state };
    if (anchor) next[key] = { x: Math.round(anchor.x), y: Math.round(anchor.y) };
    else delete next[key];
    this.state = next;
    this.persist();
  }

  anchor(mode: MimiPresenceMode): Point | undefined {
    const value = mode === "docked" ? this.state.dockedAnchor : this.state.movingAnchor;
    return value ? { ...value } : undefined;
  }

  /**
   * A computer-use capture is about to happen (true) or finished (false). Only
   * the docked form needs this; the moving surface hides itself for captures.
   */
  setCaptureActive(active: boolean): boolean {
    if (this.captureHidden === active) return false;
    this.captureHidden = active;
    return this.docked.setCaptureHidden(active);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.endPreviewSilently();
    this.docked.withdraw();
    this.moving?.withdraw();
    this.shown = null;
    await this.options.save(this.persisted()).catch(() => {});
  }

  private effectiveMode(): MimiPresenceMode {
    return this.state.mode === "moving" && this.moving && !this.movingError ? "moving" : "docked";
  }

  private target(): MimiPresenceMode | null {
    if (!this.started || this.disposed) return null;
    if (this.previewing && this.moving) return "moving";
    return this.state.visible ? this.effectiveMode() : null;
  }

  private surface(mode: MimiPresenceMode): MimiPresenceSurface | undefined {
    return mode === "docked" ? this.docked : this.moving;
  }

  private endPreviewSilently(): void {
    if (!this.previewing) return;
    this.previewing = false;
    this.previewToken++;
    this.moving?.cancelPreview();
  }

  /** Keep Mimi standing where she is when the presented form changes. */
  private carryPosition(from: MimiPresenceMode | null): void {
    const to = this.state.visible ? this.effectiveMode() : null;
    if (!from || !to || from === to) return;
    const feet = this.surface(from)?.feet();
    if (feet) this.surface(to)?.placeFeet(feet);
  }

  private persist(): void {
    void this.options.save(this.persisted()).catch((error) => {
      this.options.log?.("mimi_presence_save_failed", { error: message(error) });
    });
  }

  private emit(): void {
    if (!this.disposed) this.options.onChange(this.snapshot());
  }

  /** Resolves true when the wanted form (or none) is presented for this generation. */
  private async apply(): Promise<boolean> {
    const generation = ++this.generation;
    const target = this.target();
    // Hide before show: whatever is not wanted is withdrawn synchronously first.
    for (const mode of ["docked", "moving"] as const) {
      if (mode !== target) this.surface(mode)?.withdraw();
    }
    if (this.shown !== target) this.shown = null;
    if (!target) {
      this.emit();
      return true;
    }
    const surface = this.surface(target)!;
    const isCurrent = () => generation === this.generation && this.target() === target;
    this.emit();
    try {
      await surface.present(isCurrent);
    } catch (error) {
      if (generation !== this.generation || this.disposed) return false;
      if (this.target() !== target) surface.withdraw();
      if (target === "moving") {
        this.movingError = message(error);
        this.options.log?.("mimi_presence_moving_failed", { error: this.movingError });
        surface.withdraw();
        // A failed preview returns to the previous form; preview() reports it.
        this.previewing = false;
        void this.apply();
        return false;
      }
      this.dockedError = message(error);
      this.options.log?.("mimi_presence_docked_failed", { error: this.dockedError });
      surface.withdraw();
      this.emit();
      return false;
    }
    if (!isCurrent()) {
      // A newer request owns the surfaces now. Never leave an unwanted form up.
      if (this.target() !== target) surface.withdraw();
      return false;
    }
    this.shown = target;
    this.emit();
    return true;
  }
}
