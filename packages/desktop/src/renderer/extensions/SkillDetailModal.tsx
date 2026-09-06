import { useEffect, useRef, useState } from "react";
import { Markdown } from "../Markdown";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { skillBaseDir } from "./skillBaseDir";
import { useT } from "../i18n/I18nProvider";
import type { RendererConfigurationTarget } from "../../preload/types";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

interface Props {
  name: string;
  configurationTarget: RendererConfigurationTarget;
  filePath: string;
  source: string;
  onClose: () => void;
}

export function SkillDetailModal({ name, configurationTarget, filePath, source, onClose }: Props) {
  const { t } = useT();
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );

  useEffect(() => {
    let alive = true;
    setBody(null);
    setError(null);
    window.codeshell
      .readSkillBody(configurationTarget, filePath)
      .then((t) => {
        if (alive) setBody(t);
      })
      .catch((e) => {
        if (alive) setError(String(e?.message ?? e));
      });
    return () => {
      alive = false;
    };
  }, [configurationTarget, filePath]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showClose={false}
        className="flex max-h-[85vh] w-[calc(100%-2rem)] max-w-2xl flex-col gap-0 overflow-hidden rounded-2xl p-0"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          openerRef.current?.focus();
        }}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-border/70 bg-muted/20 px-5 py-4">
          <div className="min-w-0 flex-1">
            <DialogTitle className="break-words text-base leading-6">{name}</DialogTitle>
            <DialogDescription className="mt-1 text-xs">{source}</DialogDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 rounded-lg"
            onClick={onClose}
            aria-label={t("ext.skillDetail.close")}
          >
            <X size={16} />
          </Button>
        </header>
        <div className="min-h-0 overflow-y-auto p-5">
          {error ? (
            <div className="text-sm text-muted-foreground">
              {t("ext.skillDetail.readFailed", { error })}
            </div>
          ) : body === null ? (
            <div className="text-sm text-muted-foreground">{t("ext.common.loading")}</div>
          ) : (
            <Markdown text={body} cwd={skillBaseDir(filePath)} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
