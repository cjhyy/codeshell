import React from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "../i18n";
import type { RendererConfigurationTarget } from "../../preload/types";
import type {
  ProfilePluginExportPreview,
  ProfilePluginExportSelection,
} from "../../shared/profile-plugin-export";

const EMPTY: ProfilePluginExportSelection = {
  componentIds: [],
  textFileIds: [],
  includeInstruction: false,
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Advanced Settings export only. Plain text review never renders or executes Markdown. */
export function ProfilePluginExportReview({
  name,
  target,
  onClose,
  onExported,
}: {
  name: string;
  target: RendererConfigurationTarget;
  onClose: () => void;
  onExported: (directoryName: string) => void;
}) {
  const { t } = useT();
  const key = `settingsX.digitalHumans.pluginExport`;
  const [selection, setSelection] = React.useState(EMPTY);
  const [preview, setPreview] = React.useState<ProfilePluginExportPreview | null>(null);
  const [accepted, setAccepted] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const generation = React.useRef(0);
  const token = React.useRef<string | null>(null);
  const targetKey = JSON.stringify(target);

  const load = async (next: ProfilePluginExportSelection) => {
    const current = ++generation.current;
    if (token.current)
      void window.codeshell.cancelProfilePluginExport(token.current).catch(() => {});
    token.current = null;
    setSelection(next);
    setAccepted(false);
    setBusy(true);
    setError(null);
    try {
      const result = await window.codeshell.previewProfilePluginExport(name, target, next);
      if (current !== generation.current) {
        void window.codeshell.cancelProfilePluginExport(result.reviewToken).catch(() => {});
        return;
      }
      token.current = result.reviewToken;
      setPreview(result);
    } catch (caught) {
      if (current === generation.current) setError(message(caught));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  React.useLayoutEffect(() => {
    setPreview(null);
    setSelection(EMPTY);
    setAccepted(false);
    void load(EMPTY);
    return () => {
      generation.current++;
      if (token.current)
        void window.codeshell.cancelProfilePluginExport(token.current).catch(() => {});
      token.current = null;
    };
    // Context changes cancel the private review. A refreshed object with the same
    // stable identity must not restart review on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, targetKey]);

  const toggle = (field: "componentIds" | "textFileIds", id: string, checked: boolean) => {
    const next = {
      ...selection,
      [field]: checked
        ? [...selection[field], id]
        : selection[field].filter((value) => value !== id),
    };
    if (field === "componentIds" && !checked) {
      const removed = new Set(
        preview?.components.find((item) => item.id === id)?.textFiles.map((file) => file.id),
      );
      next.textFileIds = next.textFileIds.filter((value) => !removed.has(value));
    }
    void load(next);
  };
  const save = async () => {
    if (!preview?.canExport || !accepted || busy || error || token.current !== preview.reviewToken)
      return;
    const current = generation.current;
    setBusy(true);
    setError(null);
    try {
      const result = await window.codeshell.commitProfilePluginExport(
        preview.reviewToken,
        target,
        true,
      );
      if (current !== generation.current) return;
      token.current = null;
      if (!result.canceled) onExported(result.directoryName);
      onClose();
    } catch (caught) {
      if (current === generation.current) {
        setError(message(caught));
        setAccepted(false);
        token.current = null;
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {error ? (
        <p role="alert" className="text-sm text-status-err">
          {error}
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t(`${key}.working`)}
        </p>
      ) : null}
      {preview ? (
        <>
          <fieldset disabled={busy} className="space-y-3">
            <legend className="text-sm font-medium">{t(`${key}.components`)}</legend>
            {preview.components.length === 0 ? (
              <p className="text-sm">{t(`${key}.empty`)}</p>
            ) : null}
            {preview.components.map((component) => (
              <div key={component.id} className="rounded border border-border p-3 text-sm">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={selection.componentIds.includes(component.id)}
                    disabled={Boolean(component.blocked) && !component.selected}
                    onChange={(event) => toggle("componentIds", component.id, event.target.checked)}
                  />
                  <span>
                    {component.kind}: {component.name} → {component.exportName} (
                    {component.source ?? "unavailable"})
                  </span>
                </label>
                {component.blocked ? (
                  <p role="note" className="mt-1 text-status-err">
                    {component.blocked}
                  </p>
                ) : null}
                {component.textFiles.length ? (
                  <div className="mt-2 space-y-1 pl-5">
                    <p className="text-xs text-muted-foreground">{t(`${key}.support`)}</p>
                    {component.textFiles.map((file) => (
                      <label key={file.id} className="flex gap-2">
                        <input
                          type="checkbox"
                          checked={selection.textFileIds.includes(file.id)}
                          onChange={(event) => toggle("textFileIds", file.id, event.target.checked)}
                        />
                        {file.path}
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={selection.includeInstruction}
                onChange={(event) =>
                  void load({ ...selection, includeInstruction: event.target.checked })
                }
              />
              {t(`${key}.instruction`)}
            </label>
          </fieldset>
          <div className="space-y-2 text-sm">
            <p className="font-medium">{t(`${key}.losses`)}</p>
            <ul className="list-disc space-y-1 pl-5">
              {preview.losses.map((loss) => (
                <li key={loss}>{loss}</li>
              ))}
            </ul>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">
              {t(`${key}.files`, { count: preview.files.length, bytes: preview.totalBytes })}
            </p>
            {preview.files.map((file) => (
              <details key={file.path} className="rounded border border-border p-2 text-xs">
                <summary className="cursor-pointer break-all">
                  {file.path} · {file.bytes} B · SHA-256 {file.sha256}
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">
                  {file.text}
                </pre>
              </details>
            ))}
          </div>
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={accepted}
              disabled={busy || !preview.canExport || Boolean(error)}
              onChange={(event) => setAccepted(event.target.checked)}
            />
            {t(`${key}.accept`)}
          </label>
        </>
      ) : null}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {t(`${key}.cancel`)}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void load(selection)}>
          {t(`${key}.refresh`)}
        </Button>
        <Button
          disabled={
            busy ||
            !preview?.canExport ||
            !accepted ||
            Boolean(error) ||
            token.current !== preview?.reviewToken
          }
          onClick={() => void save()}
        >
          {t(`${key}.save`)}
        </Button>
      </DialogFooter>
    </div>
  );
}

export function ProfilePluginExportDialog(props: Parameters<typeof ProfilePluginExportReview>[0]) {
  const { t } = useT();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {t("settingsX.digitalHumans.pluginExport.title", { name: props.name })}
          </DialogTitle>
          <DialogDescription>
            {t("settingsX.digitalHumans.pluginExport.description")}
          </DialogDescription>
        </DialogHeader>
        <ProfilePluginExportReview {...props} />
      </DialogContent>
    </Dialog>
  );
}
