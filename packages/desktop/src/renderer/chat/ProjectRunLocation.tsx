import React, { useId, useRef, useState } from "react";
import { Check, ChevronDown, Cloud, Loader2, Monitor } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CloudEnvironmentDiscovery } from "../../shared/cloud-environment";
import type { CloudProjectBinding } from "../../shared/project-runtime";
import { useT } from "../i18n/I18nProvider";
import { projectLabel, type TrackedProject } from "../projects";

interface Props {
  project: TrackedProject | null;
  bindings: CloudProjectBinding[];
  selectedBinding: CloudProjectBinding | null;
  loading?: boolean;
  disabled?: boolean;
  onSelect: (bindingId: string | null) => Promise<void>;
}

/** A project selects a native execution target. Credentials stay in Main's isolated session. */
export function ProjectRunLocation({
  project,
  bindings,
  selectedBinding,
  loading = false,
  disabled = false,
  onSelect,
}: Props) {
  const { t } = useT();
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pendingActionRef = useRef<(() => void) | null>(null);
  const workingRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [address, setAddress] = useState(selectedBinding?.origin ?? bindings[0]?.origin ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [discovery, setDiscovery] = useState<CloudEnvironmentDiscovery | null>(null);
  const [remoteProjectId, setRemoteProjectId] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const label = selectedBinding ? t("chat.runLocation.cloud") : t("chat.runLocation.thisComputer");
  const configureCloud = () => {
    setAddress(selectedBinding?.origin ?? bindings[0]?.origin ?? "");
    setDiscovery(null);
    setPassword("");
    setError("");
    setDialogOpen(true);
  };
  const act = async (operation: () => Promise<void>) => {
    if (workingRef.current || disabled) return;
    workingRef.current = true;
    setWorking(true);
    setError("");
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setDialogOpen(true);
    } finally {
      workingRef.current = false;
      setWorking(false);
      setPassword("");
    }
  };
  const closeThenAct = (action: () => void) => {
    pendingActionRef.current = action;
    setMenuOpen(false);
  };
  const inspect = async () => {
    const api = window.codeshell.cloudEnvironment;
    const result =
      discovery && !discovery.authenticated
        ? await api.login({ origin: discovery.origin, username: username.trim(), password })
        : await api.discover({ origin: address.trim() });
    setDiscovery(result);
    setAddress(result.origin);
    setRemoteProjectId(result.projects?.[0]?.id ?? "");
    if (!result.initialized) throw new Error(t("chat.runLocation.uninitialized"));
  };
  const submit = async () => {
    if (!project) return;
    if (!discovery?.authenticated || !discovery.environment) {
      await inspect();
      return;
    }
    if (!remoteProjectId) return;
    const binding = await window.codeshell.cloudEnvironment.bind({
      localProjectId: project.id,
      origin: discovery.origin,
      environmentId: discovery.environment.id,
      remoteProjectId,
    });
    await onSelect(binding.id);
    setDialogOpen(false);
  };

  return (
    <>
      <DropdownMenu
        open={menuOpen}
        onOpenChange={(next) => {
          if (next) pendingActionRef.current = null;
          setMenuOpen(next);
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 disabled:pointer-events-none disabled:opacity-50"
            disabled={disabled || loading || working || !project}
            aria-label={t("chat.runLocation.current", { label })}
            title={
              selectedBinding
                ? `${selectedBinding.environmentName} · ${selectedBinding.remoteProjectName}`
                : t("chat.runLocation.current", { label })
            }
          >
            {loading || working ? (
              <Loader2 size={12} className="animate-spin" />
            ) : selectedBinding ? (
              <Cloud size={12} />
            ) : (
              <Monitor size={12} />
            )}
            <span>{label}</span>
            <ChevronDown size={12} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          className="w-64 rounded-xl p-1.5"
          onCloseAutoFocus={(event) => {
            const action = pendingActionRef.current;
            if (!action) return;
            pendingActionRef.current = null;
            event.preventDefault();
            triggerRef.current?.focus({ preventScroll: true });
            action();
          }}
        >
          <DropdownMenuLabel>{t("chat.runLocation.title")}</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => closeThenAct(() => void act(() => onSelect(null)))}>
            <Monitor size={14} aria-hidden />
            <span className="flex-1">{t("chat.runLocation.thisComputer")}</span>
            {!selectedBinding && <Check size={14} aria-hidden />}
          </DropdownMenuItem>
          {bindings.map((binding) => (
            <DropdownMenuItem
              key={binding.id}
              onSelect={() => closeThenAct(() => void act(() => onSelect(binding.id)))}
            >
              <Cloud size={14} className="shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block">{t("chat.runLocation.cloud")}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {binding.environmentName} · {binding.remoteProjectName}
                </span>
              </span>
              {selectedBinding?.id === binding.id && <Check size={14} aria-hidden />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => closeThenAct(configureCloud)}>
            <Cloud size={14} aria-hidden />
            {t("chat.runLocation.connectCloud")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={dialogOpen}
        onOpenChange={(next) => {
          if (!workingRef.current) {
            setDialogOpen(next);
            if (!next) setPassword("");
          }
        }}
      >
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-md"
          showClose={!working}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus({ preventScroll: true });
          }}
          onEscapeKeyDown={(event) => {
            if (workingRef.current) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("chat.runLocation.dialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("chat.runLocation.dialogDescription", {
                name: project ? projectLabel(project) : "",
              })}
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void act(submit);
            }}
          >
            <div className="grid gap-2">
              <label className="text-sm font-medium" htmlFor={`${id}-address`}>
                {t("chat.runLocation.address")}
              </label>
              <Input
                id={`${id}-address`}
                value={address}
                onChange={(event) => {
                  setAddress(event.target.value);
                  setDiscovery(null);
                  setError("");
                }}
                placeholder="https://cloud.example.com"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={working}
              />
            </div>
            {discovery?.initialized && !discovery.authenticated && (
              <>
                <div className="grid gap-2">
                  <label htmlFor={`${id}-user`}>{t("chat.runLocation.username")}</label>
                  <Input
                    id={`${id}-user`}
                    autoComplete="username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    disabled={working}
                  />
                </div>
                <div className="grid gap-2">
                  <label htmlFor={`${id}-password`}>{t("chat.runLocation.password")}</label>
                  <Input
                    id={`${id}-password`}
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    disabled={working}
                  />
                </div>
              </>
            )}
            {discovery?.authenticated && (
              <div className="grid gap-2">
                <label htmlFor={`${id}-project`}>{t("chat.runLocation.existingProject")}</label>
                <select
                  id={`${id}-project`}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={remoteProjectId}
                  onChange={(event) => setRemoteProjectId(event.target.value)}
                  disabled={working}
                >
                  {(discovery.projects ?? []).map((remote) => (
                    <option key={remote.id} value={remote.id}>
                      {remote.name}
                    </option>
                  ))}
                </select>
                {!discovery.projects?.length && (
                  <p className="text-sm text-muted-foreground">
                    {t("chat.runLocation.noProjects")}
                  </p>
                )}
              </div>
            )}
            {error && (
              <p role="alert" className="break-words text-sm text-status-err">
                {error}
              </p>
            )}
            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={working}
                onClick={() => {
                  setDialogOpen(false);
                  setPassword("");
                }}
              >
                {t("misc.dialog.cancel")}
              </Button>
              <Button
                type="submit"
                disabled={
                  working || !address.trim() || (discovery?.authenticated && !remoteProjectId)
                }
              >
                {working && <Loader2 size={14} className="animate-spin" aria-hidden />}
                {discovery?.authenticated
                  ? t("chat.runLocation.useCloud")
                  : discovery?.initialized
                    ? t("chat.runLocation.signIn")
                    : t("chat.runLocation.connect")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
