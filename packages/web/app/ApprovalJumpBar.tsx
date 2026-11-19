import React from "react";
import "./approval-jump-bar.css";

/** Copy for the jump bar: blocking approvals stop the run, async questions do not. */
export function approvalJumpLabel(count: number, blocking: number): string {
  return blocking > 0
    ? `${blocking > 99 ? "99+" : blocking} 项操作等待你确认`
    : `${count > 99 ? "99+" : count} 个问题可稍后回答`;
}

/**
 * Tracks whether the pending-approval cards at the end of the transcript are
 * scrolled out of the message viewport. Without IntersectionObserver (old
 * browsers, unit DOMs) it reports visible, so nothing extra is shown.
 */
export function useApprovalOffscreen(
  root: React.RefObject<HTMLElement | null>,
  target: React.RefObject<HTMLElement | null>,
  active: boolean,
): boolean {
  const [offscreen, setOffscreen] = React.useState(false);
  React.useEffect(() => {
    const node = target.current;
    if (!active || !node || typeof IntersectionObserver === "undefined") {
      setOffscreen(false);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setOffscreen(!entry.isIntersecting);
      },
      { root: root.current, threshold: 0 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [root, target, active]);
  return active && offscreen;
}

/**
 * Compact bar above the composer, like Desktop's: when the conversation is
 * waiting on the user but the cards are scrolled away, one click brings them
 * back and focuses the first actionable control.
 */
export function ApprovalJumpBar({
  count,
  blocking,
  target,
}: {
  count: number;
  blocking: number;
  target: React.RefObject<HTMLElement | null>;
}) {
  const jump = () => {
    const node = target.current;
    if (!node) return;
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    node
      .querySelector<HTMLElement>("textarea, input, button:not([disabled])")
      ?.focus({ preventScroll: true });
  };
  return (
    <div className={`approval-jump${blocking ? " blocking" : ""}`} role="status">
      <span className="approval-jump-dot" aria-hidden="true" />
      <span>{approvalJumpLabel(count, blocking)}</span>
      <button type="button" onClick={jump}>
        查看
      </button>
    </div>
  );
}
