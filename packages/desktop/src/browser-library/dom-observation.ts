/** These functions run in the target frame. Keep them self-contained. */
export function collectPageNodes({
  mode,
  cap,
  mediaLimits,
  seenMedia = [],
}: {
  mode: "interactive" | "media";
  cap: number;
  mediaLimits?: Record<"link" | "image" | "video", number>;
  seenMedia?: string[];
}) {
  const nodes: Element[] = [];
  const metadata: Array<{
    role: string;
    name: string;
    value?: string;
    sensitive?: boolean;
    kind?: "link" | "image" | "video";
    url?: string;
  }> = [];
  let truncated = false;
  const seen = new Set(seenMedia);
  const counts = { link: 0, image: 0, video: 0 };
  const interactiveRoles = new Set([
    "button",
    "link",
    "textbox",
    "searchbox",
    "checkbox",
    "radio",
    "combobox",
    "listbox",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "switch",
    "slider",
    "option",
    "spinbutton",
  ]);
  const selector =
    mode === "media"
      ? "a[href],img,video,video source"
      : "a[href],button,input:not([type=hidden]),textarea,select,summary,[contenteditable],[role],[tabindex],canvas";
  const clean = (text: string | null | undefined) =>
    (text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const visit = (root: Document | ShadowRoot) => {
    for (const element of root.querySelectorAll("*")) {
      if (nodes.length >= cap) {
        truncated = true;
        return;
      }
      if (element.matches(selector)) {
        if (mode === "media") {
          const kind =
            element instanceof HTMLAnchorElement
              ? "link"
              : element instanceof HTMLImageElement
                ? "image"
                : "video";
          const rawUrl =
            element instanceof HTMLAnchorElement
              ? element.href
              : element instanceof HTMLImageElement
                ? element.currentSrc || element.src
                : (element as HTMLMediaElement).currentSrc || (element as HTMLMediaElement).src;
          if (rawUrl && !/^javascript:/i.test(rawUrl)) {
            // Retain an image handle/ref without serializing an inline response
            // body into the tool output. A bounded content id keeps distinct
            // inline images distinct when extraction deduplicates URLs.
            let url = rawUrl;
            if (/^data:/i.test(rawUrl)) {
              let hash = 2166136261;
              for (let index = 0; index < rawUrl.length; index++) {
                hash = Math.imul(hash ^ rawUrl.charCodeAt(index), 16777619);
              }
              const mime = rawUrl.slice(5, 85).split(/[;,]/)[0] || "text/plain";
              url = `inline:${mime};id=${(hash >>> 0).toString(16)}`;
            }
            const key = `${kind}:${url}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (counts[kind] >= (mediaLimits?.[kind] ?? Math.floor(cap / 3))) {
              truncated = true;
              continue;
            }
            counts[kind]++;
            nodes.push(element);
            metadata.push({
              kind,
              url,
              role: kind,
              name: clean(element instanceof HTMLImageElement ? element.alt : element.textContent),
            });
          }
        } else {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          if (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          ) {
            const tag = element.localName;
            const input = element instanceof HTMLInputElement ? element : undefined;
            const editable = element instanceof HTMLElement && element.isContentEditable;
            const editingHost = editable && !element.parentElement?.isContentEditable;
            const explicitRole = element.getAttribute("role")?.trim().split(/\s+/)[0];
            const nativeControl = element.matches(
              "a[href],button,input:not([type=hidden]),textarea,select,summary,canvas",
            );
            const focusable = element instanceof HTMLElement && element.tabIndex >= 0;
            if (
              !nativeControl &&
              !editingHost &&
              !focusable &&
              !interactiveRoles.has(explicitRole ?? "")
            ) {
              if (element.shadowRoot) visit(element.shadowRoot);
              continue;
            }
            const role =
              (interactiveRoles.has(explicitRole ?? "") ? explicitRole : undefined) ||
              (tag === "a"
                ? "link"
                : tag === "select"
                  ? "combobox"
                  : tag === "textarea" || editingHost
                    ? "textbox"
                    : input
                      ? ["checkbox", "radio", "range"].includes(input.type)
                        ? input.type === "range"
                          ? "slider"
                          : input.type
                        : ["button", "submit", "reset", "image"].includes(input.type)
                          ? "button"
                          : "textbox"
                      : tag === "canvas"
                        ? "canvas"
                        : "button");
            const labelled = element
              .getAttribute("aria-labelledby")
              ?.split(/\s+/)
              .map((id) => root.getElementById(id)?.textContent ?? "")
              .join(" ");
            const form =
              element instanceof HTMLInputElement ||
              element instanceof HTMLTextAreaElement ||
              element instanceof HTMLSelectElement
                ? element
                : undefined;
            const name = clean(
              element.getAttribute("aria-label") ||
                labelled ||
                (form?.labels
                  ? Array.from(form.labels)
                      .map((label) => label.textContent)
                      .join(" ")
                  : "") ||
                element.getAttribute("placeholder") ||
                element.getAttribute("title") ||
                (element as HTMLElement).innerText ||
                element.textContent,
            );
            const sensitive =
              input?.type === "password" ||
              /password|密码/i.test(name) ||
              /^(current-password|new-password|one-time-code|cc-number|cc-csc)$/.test(
                element.getAttribute("autocomplete") ?? "",
              );
            nodes.push(element);
            metadata.push({
              role,
              name,
              ...(sensitive ? { sensitive: true } : form ? { value: clean(form.value) } : {}),
            });
          }
        }
      }
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(document);
  return { nodes, metadata, truncated };
}

/** Cross-origin frame contents are read through their own Puppeteer Frame. */
export function readFrameText(): string {
  const roots: Array<Document | ShadowRoot> = [document];
  const text: string[] = [];
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index]!;
    const content =
      root instanceof Document
        ? (root.querySelector("main,article,[role=main]") ?? root.body)
        : root;
    if (content) {
      // A detached clone avoids modifying the actual page or copying input values.
      const clone = document.createElement("div");
      for (const child of content.childNodes) clone.appendChild(child.cloneNode(true));
      clone
        .querySelectorAll("p,div,li,br,h1,h2,h3,tr,section")
        .forEach((node) => node.prepend("\n"));
      clone
        .querySelectorAll("script,style,noscript,nav,header,footer,aside,svg")
        .forEach((node) => node.remove());
      text.push(clone.textContent ?? "");
    }
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  return text.join("\n");
}
