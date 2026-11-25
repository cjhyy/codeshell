import React from "react";

/** Pierre renders through custom elements, shadow roots and resize observers. */
export function pierreSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.customElements !== "undefined" &&
    typeof window.ResizeObserver !== "undefined" &&
    typeof window.IntersectionObserver !== "undefined"
  );
}

interface Props {
  /** Rendered instead of `children` when Pierre is unavailable or throws. */
  fallback: React.ReactNode;
  children: React.ReactNode;
}

interface State {
  failed: boolean;
}

/** Keep one file's rendering failure from taking down the whole panel. */
export class PierreBoundary extends React.Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    window.codeshell?.log?.("pierre.render_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  render(): React.ReactNode {
    if (this.state.failed || !pierreSupported()) return this.props.fallback;
    return this.props.children;
  }
}
