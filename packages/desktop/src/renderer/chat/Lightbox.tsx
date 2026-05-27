import React, { useEffect } from "react";

/** Pure decision so the close behavior is unit-testable without a DOM. */
export function shouldCloseOnKey(key: string): boolean {
  return key === "Escape";
}

/**
 * Full-screen image viewer. Click the backdrop or press Escape to close.
 * Mirrors ConfirmDialog's overlay pattern (backdrop mousedown dismiss,
 * inner mousedown stops propagation) so a click on the image itself
 * doesn't close.
 */
export function Lightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldCloseOnKey(e.key)) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="lightbox-backdrop" onMouseDown={onClose}>
      <img
        className="lightbox-image"
        src={src}
        alt={alt}
        onMouseDown={(e) => e.stopPropagation()}
      />
      <button
        type="button"
        className="lightbox-close"
        aria-label="关闭"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}
