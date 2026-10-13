import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CloudProjectBinding } from "../../shared/project-runtime";
import { useT } from "../i18n";

/** Restore authentication for one existing binding without changing its execution location. */
export function CloudProjectSignIn({
  binding,
  required,
  reconnect,
}: {
  binding: CloudProjectBinding;
  required: boolean;
  reconnect: () => Promise<void>;
}) {
  const { lang } = useT();
  const zh = lang === "zh";
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const live = useRef(false);
  const pending = useRef(false);
  const composing = useRef(false);
  const attempt = useRef(0);
  const identity = [
    binding.id,
    binding.localProjectId,
    binding.origin,
    binding.environmentId,
    binding.remoteProjectId,
  ].join("\n");
  const activeIdentity = useRef(identity);
  activeIdentity.current = identity;
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      attempt.current++;
    };
  }, []);
  useEffect(() => {
    attempt.current++;
    pending.current = false;
    composing.current = false;
    setOpen(false);
    setUsername("");
    setPassword("");
    setBusy(false);
    setError("");
  }, [identity]);

  const changeOpen = (next: boolean) => {
    if (pending.current) return;
    setOpen(next);
    setPassword("");
    setError("");
  };
  const signIn = async () => {
    if (pending.current || composing.current) return;
    const captured = { ...binding };
    const capturedReconnect = reconnect;
    const capturedIdentity = identity;
    const request = ++attempt.current;
    const current = () =>
      live.current && request === attempt.current && activeIdentity.current === capturedIdentity;
    pending.current = true;
    setBusy(true);
    setError("");
    const credentials = { origin: captured.origin, username: username.trim(), password };
    setPassword("");
    try {
      const discovery = await window.codeshell.cloudEnvironment.login(credentials);
      if (!current()) return;
      if (
        discovery.origin !== captured.origin ||
        !discovery.authenticated ||
        discovery.environment?.id !== captured.environmentId ||
        !discovery.projects?.some((project) => project.id === captured.remoteProjectId)
      )
        throw new Error(
          zh
            ? "无法验证当前云端项目，请核对账户和服务后重试。"
            : "The current cloud project could not be verified. Check the account and service, then retry.",
        );
      await capturedReconnect();
      if (current()) setOpen(false);
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (current()) {
        pending.current = false;
        setBusy(false);
        setPassword("");
      }
    }
  };

  return (
    <>
      {required && (
        <Button
          ref={trigger}
          type="button"
          variant="outline"
          size="sm"
          onClick={() => changeOpen(true)}
        >
          {zh ? "重新登录" : "Sign in again"}
        </Button>
      )}
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-md"
          showClose={!busy}
          onEscapeKeyDown={(event) => {
            if (pending.current || composing.current || event.isComposing) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
          }}
        >
          <DialogHeader>
            <DialogTitle>{zh ? "重新登录云端" : "Sign in to cloud again"}</DialogTitle>
            <DialogDescription>
              {binding.environmentName} · {binding.remoteProjectName}
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void signIn();
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)
              )
                event.preventDefault();
            }}
          >
            <div className="grid gap-2">
              <label className="text-sm font-medium" htmlFor={`${id}-origin`}>
                {zh ? "云端服务地址" : "Cloud service address"}
              </label>
              <Input id={`${id}-origin`} value={binding.origin} readOnly />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium" htmlFor={`${id}-username`}>
                {zh ? "用户名" : "Username"}
              </label>
              <Input
                id={`${id}-username`}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                onCompositionStart={() => (composing.current = true)}
                onCompositionEnd={() => (composing.current = false)}
                autoComplete="username"
                disabled={busy}
                required
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium" htmlFor={`${id}-password`}>
                {zh ? "密码" : "Password"}
              </label>
              <Input
                id={`${id}-password`}
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                disabled={busy}
                required
              />
            </div>
            {error && (
              <p role="alert" className="break-words text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => changeOpen(false)}
              >
                {zh ? "取消" : "Cancel"}
              </Button>
              <Button type="submit" disabled={busy || !username.trim() || !password}>
                {busy ? (zh ? "正在登录…" : "Signing in…") : zh ? "登录" : "Sign in"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
