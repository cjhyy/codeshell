import React from "react";

/** Only receives an already validated, scoped Host download URL. */
export function CopyDownloadLink({ url }: { url: string }) {
  const [status, setStatus] = React.useState<"idle" | "copied" | "manual">("idle");
  const input = React.useRef<HTMLInputElement>(null);
  const absolute = new URL(url, window.location.href).href;
  React.useEffect(() => {
    if (status === "manual") {
      input.current?.focus();
      input.current?.select();
    }
  }, [status]);
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(absolute);
      setStatus("copied");
    } catch {
      setStatus("manual");
    }
  };
  return (
    <>
      <button onClick={() => void copy()}>
        {status === "copied" ? "已复制地址" : "复制下载地址"}
      </button>
      {status === "manual" && (
        <label className="panel-host-copy-link">
          请长按复制下载地址
          <input ref={input} aria-label="下载地址" value={absolute} readOnly />
        </label>
      )}
    </>
  );
}
