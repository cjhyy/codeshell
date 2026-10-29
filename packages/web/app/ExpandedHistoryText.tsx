import React from "react";
import { HistoryDetailBody } from "./HistoryDetailBody.js";
import type { HistoryDetailLoader } from "./workbench-types.js";

/** Only explicitly referenced oversized text is shortened; ordinary messages remain complete. */
export function ExpandedHistoryText({
  text,
  reference,
  scope,
  load,
  reload,
  children,
}: {
  text: string;
  reference?: string;
  scope: string;
  load?: HistoryDetailLoader;
  reload?: () => void;
  children: (text: string) => React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  if (!reference) return <>{children(text)}</>;
  const preview = children(text);
  return (
    <>
      {!open && preview}
      <details
        className="message-full-text"
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>{open ? "收起完整内容" : "展开完整内容"}</summary>
        {open && (
          <HistoryDetailBody
            key={`${scope}:${reference}`}
            reference={reference}
            load={load}
            reload={reload}
            preview={preview}
          >
            {(detail) => children(detail?.text ?? text)}
          </HistoryDetailBody>
        )}
      </details>
    </>
  );
}
