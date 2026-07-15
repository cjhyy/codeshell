import React from "react";
import {
  Brain,
  Check,
  GitFork,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  UsersRound,
} from "lucide-react";
import type { DigitalHumanTeam, DigitalHumanTeamMode } from "@cjhyy/code-shell-pet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useT } from "../i18n";
import { DigitalHumanEditorDialog } from "./DigitalHumanEditorDialog";
import type {
  DigitalHumanCatalogEntry,
  DigitalHumanProfileEntry,
  DigitalHumanSelection,
  DigitalHumanSkillEntry,
} from "./types";

interface Props {
  activeProjectPath: string | null;
  onUse: (selection: DigitalHumanSelection) => void;
}

function capabilityCount(profile: DigitalHumanProfileEntry): number {
  return (
    profile.plugins.length + profile.skills.length + profile.mcp.length + profile.agents.length
  );
}

function modeKey(mode: DigitalHumanTeamMode): "auto" | "divide" | "compare" {
  return mode;
}

export function DigitalHumansView({ activeProjectPath, onUse }: Props) {
  const { t } = useT();
  const [profiles, setProfiles] = React.useState<DigitalHumanProfileEntry[]>([]);
  const [catalog, setCatalog] = React.useState<DigitalHumanCatalogEntry[]>([]);
  const [teams, setTeams] = React.useState<DigitalHumanTeam[]>([]);
  const [availableSkills, setAvailableSkills] = React.useState<DigitalHumanSkillEntry[]>([]);
  const [query, setQuery] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [teamDialogOpen, setTeamDialogOpen] = React.useState(false);
  const [editor, setEditor] = React.useState<{ profile?: DigitalHumanProfileEntry } | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const [nextProfiles, nextCatalog, nextTeams, nextSkills] = await Promise.all([
        window.codeshell.listProfiles(activeProjectPath ?? undefined),
        window.codeshell.listProfileCatalog(),
        window.codeshell.listDigitalHumanTeams(),
        window.codeshell.listSkills(activeProjectPath ?? "/", { includeDisabled: true }),
      ]);
      setProfiles(nextProfiles);
      setCatalog(nextCatalog);
      setTeams(nextTeams);
      setAvailableSkills(nextSkills);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [activeProjectPath]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = (profile: { name: string; label: string; description?: string }) =>
    !normalizedQuery ||
    [profile.name, profile.label, profile.description ?? ""].some((value) =>
      value.toLocaleLowerCase().includes(normalizedQuery),
    );
  const profileByName = new Map(profiles.map((profile) => [profile.name, profile]));

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="border-b border-border/70 px-6 py-5">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <UsersRound size={18} aria-hidden="true" />
              </span>
              <h1 className="text-xl font-semibold tracking-tight">{t("digitalHumans.title")}</h1>
            </div>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              {t("digitalHumans.subtitle")}
            </p>
          </div>
          <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
            <Button size="sm" onClick={() => setEditor({})}>
              <Plus size={14} aria-hidden="true" />
              {t("digitalHumans.editor.create")}
            </Button>
            <div className="relative w-full sm:w-72">
              <Search
                size={15}
                className="pointer-events-none absolute left-3 top-2.5 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-9"
                placeholder={t("digitalHumans.search")}
              />
            </div>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto w-full max-w-6xl">
          {error ? (
            <div className="mb-4 rounded-md border border-status-err/30 bg-status-err/5 px-3 py-2 text-sm text-status-err">
              {error}
            </div>
          ) : null}
          <Tabs defaultValue="market">
            <TabsList>
              <TabsTrigger value="market">{t("digitalHumans.tabs.market")}</TabsTrigger>
              <TabsTrigger value="mine">{t("digitalHumans.tabs.mine")}</TabsTrigger>
              <TabsTrigger value="teams">{t("digitalHumans.tabs.teams")}</TabsTrigger>
            </TabsList>

            <TabsContent value="market" className="mt-5">
              <div className="mb-4 flex items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
                <Sparkles size={14} className="shrink-0 text-primary" aria-hidden="true" />
                {t("digitalHumans.marketHint")}
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {catalog.filter(matches).map((entry) => (
                  <CatalogCard
                    key={entry.name}
                    entry={entry}
                    busy={busy === `install:${entry.name}`}
                    onInstall={() =>
                      void run(`install:${entry.name}`, () =>
                        window.codeshell.installCatalogProfile(entry.name),
                      )
                    }
                    onUse={() => onUse({ kind: "single", id: entry.name, label: entry.label })}
                  />
                ))}
              </div>
            </TabsContent>

            <TabsContent value="mine" className="mt-5">
              {profiles.length === 0 ? (
                <EmptyState
                  Icon={Brain}
                  title={t("digitalHumans.empty.title")}
                  description={t("digitalHumans.empty.description")}
                />
              ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {profiles.filter(matches).map((profile) => (
                    <ProfileCard
                      key={profile.name}
                      profile={profile}
                      hasProject={Boolean(activeProjectPath)}
                      busy={busy === `profile:${profile.name}`}
                      onUse={() =>
                        onUse({ kind: "single", id: profile.name, label: profile.label })
                      }
                      onEdit={() => setEditor({ profile })}
                      onToggleDefault={() => {
                        if (!activeProjectPath) return;
                        void run(`profile:${profile.name}`, () =>
                          profile.active
                            ? window.codeshell.deactivateProfile(activeProjectPath)
                            : window.codeshell.activateProfile(activeProjectPath, profile.name),
                        );
                      }}
                    />
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="teams" className="mt-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-medium">{t("digitalHumans.team.title")}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("digitalHumans.team.description")}
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => setTeamDialogOpen(true)}
                  disabled={profiles.length < 2}
                >
                  <Plus size={14} aria-hidden="true" />
                  {t("digitalHumans.team.create")}
                </Button>
              </div>
              {teams.length === 0 ? (
                <EmptyState
                  Icon={GitFork}
                  title={t("digitalHumans.team.emptyTitle")}
                  description={
                    profiles.length < 2
                      ? t("digitalHumans.team.needMembers")
                      : t("digitalHumans.team.emptyDescription")
                  }
                />
              ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {teams
                    .filter((team) =>
                      matches({ name: team.id, label: team.name, description: team.description }),
                    )
                    .map((team) => (
                      <TeamCard
                        key={team.id}
                        team={team}
                        memberLabels={team.members.map(
                          (member) => profileByName.get(member)?.label ?? member,
                        )}
                        deleting={busy === `delete-team:${team.id}`}
                        onUse={() =>
                          onUse({
                            kind: "team",
                            id: team.id,
                            label: team.name,
                            members: team.members,
                            mode: team.mode,
                          })
                        }
                        onDelete={() =>
                          void run(`delete-team:${team.id}`, () =>
                            window.codeshell.deleteDigitalHumanTeam(team.id),
                          )
                        }
                      />
                    ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <DigitalHumanEditorDialog
        open={editor !== null}
        profile={editor?.profile}
        existingIds={profiles.map((profile) => profile.name)}
        skills={availableSkills}
        busy={busy === "save-profile"}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
        onSave={(profile) =>
          void run("save-profile", async () => {
            await window.codeshell.saveProfile(profile);
            setEditor(null);
          })
        }
      />

      <TeamDialog
        open={teamDialogOpen}
        profiles={profiles}
        busy={busy === "save-team"}
        onOpenChange={setTeamDialogOpen}
        onSave={(team) =>
          void run("save-team", async () => {
            await window.codeshell.saveDigitalHumanTeam(team);
            setTeamDialogOpen(false);
          })
        }
      />
    </section>
  );
}

function CatalogCard({
  entry,
  busy,
  onInstall,
  onUse,
}: {
  entry: DigitalHumanCatalogEntry;
  busy: boolean;
  onInstall: () => void;
  onUse: () => void;
}) {
  const { t } = useT();
  return (
    <Card className="flex min-h-56 flex-col">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-base">{entry.label}</CardTitle>
          {entry.installed ? (
            <Badge variant="success">
              <Check size={11} className="mr-1" aria-hidden="true" />
              {t("digitalHumans.installed")}
            </Badge>
          ) : null}
        </div>
        <p className="text-sm leading-5 text-muted-foreground">{entry.description}</p>
      </CardHeader>
      <CardContent className="flex flex-1 flex-wrap content-start gap-1.5">
        {entry.tags.map((tag) => (
          <Badge key={tag} variant="secondary">
            {tag}
          </Badge>
        ))}
      </CardContent>
      <CardFooter className="gap-2">
        {entry.installed ? (
          <Button size="sm" onClick={onUse}>
            {t("digitalHumans.use")}
          </Button>
        ) : (
          <Button size="sm" onClick={onInstall} disabled={busy}>
            {busy ? t("digitalHumans.installing") : t("digitalHumans.install")}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

function ProfileCard({
  profile,
  hasProject,
  busy,
  onUse,
  onEdit,
  onToggleDefault,
}: {
  profile: DigitalHumanProfileEntry;
  hasProject: boolean;
  busy: boolean;
  onUse: () => void;
  onEdit: () => void;
  onToggleDefault: () => void;
}) {
  const { t } = useT();
  const count = capabilityCount(profile);
  return (
    <Card className="flex min-h-56 flex-col">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-base">{profile.label}</CardTitle>
          {profile.active ? <Badge variant="accent">{t("digitalHumans.current")}</Badge> : null}
        </div>
        <p className="text-sm leading-5 text-muted-foreground">
          {profile.description ?? t("digitalHumans.noDescription")}
        </p>
      </CardHeader>
      <CardContent className="flex flex-1 flex-wrap content-start gap-1.5">
        <Badge variant="secondary">{profile.basePreset}</Badge>
        {count > 0 ? (
          <Badge variant="secondary">{t("digitalHumans.capabilityCount", { count })}</Badge>
        ) : null}
        {profile.portableMemory ? (
          <Badge variant="secondary">{t("digitalHumans.portableMemory")}</Badge>
        ) : null}
      </CardContent>
      <CardFooter className="flex-wrap gap-2">
        <Button size="sm" onClick={onUse}>
          {t("digitalHumans.use")}
        </Button>
        <Button size="sm" variant="outline" onClick={onEdit}>
          <Pencil size={13} aria-hidden="true" />
          {t("digitalHumans.editor.edit")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onToggleDefault}
          disabled={!hasProject || busy}
          title={!hasProject ? t("digitalHumans.pickProject") : undefined}
        >
          {profile.active ? t("digitalHumans.clearDefault") : t("digitalHumans.setProjectDefault")}
        </Button>
      </CardFooter>
    </Card>
  );
}

function TeamCard({
  team,
  memberLabels,
  deleting,
  onUse,
  onDelete,
}: {
  team: DigitalHumanTeam;
  memberLabels: string[];
  deleting: boolean;
  onUse: () => void;
  onDelete: () => void;
}) {
  const { t } = useT();
  return (
    <Card className="flex min-h-52 flex-col">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-base">{team.name}</CardTitle>
          <Badge variant="info">{t(`digitalHumans.team.mode.${modeKey(team.mode)}`)}</Badge>
        </div>
        <p className="text-sm leading-5 text-muted-foreground">
          {team.description ?? t("digitalHumans.team.defaultDescription")}
        </p>
      </CardHeader>
      <CardContent className="flex flex-1 flex-wrap content-start gap-1.5">
        {memberLabels.map((label) => (
          <Badge key={label} variant="secondary">
            {label}
          </Badge>
        ))}
      </CardContent>
      <CardFooter className="justify-between gap-2">
        <Button size="sm" onClick={onUse}>
          <Sparkles size={14} aria-hidden="true" />
          {t("digitalHumans.team.use")}
        </Button>
        <Button size="icon" variant="ghost" onClick={onDelete} disabled={deleting}>
          <Trash2 size={14} aria-hidden="true" />
          <span className="sr-only">{t("digitalHumans.team.delete")}</span>
        </Button>
      </CardFooter>
    </Card>
  );
}

function TeamDialog({
  open,
  profiles,
  busy,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  profiles: DigitalHumanProfileEntry[];
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (team: DigitalHumanTeam) => void;
}) {
  const { t } = useT();
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [mode, setMode] = React.useState<DigitalHumanTeamMode>("auto");
  const [members, setMembers] = React.useState<Set<string>>(() => new Set());

  React.useEffect(() => {
    if (open) return;
    setName("");
    setDescription("");
    setMode("auto");
    setMembers(new Set());
  }, [open]);

  const toggleMember = (id: string) => {
    setMembers((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("digitalHumans.team.dialogTitle")}</DialogTitle>
          <DialogDescription>{t("digitalHumans.team.dialogDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="digital-human-team-name">{t("digitalHumans.team.name")}</Label>
            <Input
              id="digital-human-team-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("digitalHumans.team.namePlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="digital-human-team-description">
              {t("digitalHumans.team.descriptionLabel")}
            </Label>
            <Input
              id="digital-human-team-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("digitalHumans.team.descriptionPlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("digitalHumans.team.modeLabel")}</Label>
            <Select value={mode} onValueChange={(value) => setMode(value as DigitalHumanTeamMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("digitalHumans.team.mode.auto")}</SelectItem>
                <SelectItem value="divide">{t("digitalHumans.team.mode.divide")}</SelectItem>
                <SelectItem value="compare">{t("digitalHumans.team.mode.compare")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>{t("digitalHumans.team.members")}</Label>
            <div className="grid max-h-52 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
              {profiles.map((profile) => {
                const selected = members.has(profile.name);
                return (
                  <Button
                    key={profile.name}
                    type="button"
                    variant="outline"
                    className={cn(
                      "h-auto justify-start px-3 py-2",
                      selected && "border-primary/50 bg-primary/5",
                    )}
                    onClick={() => toggleMember(profile.name)}
                  >
                    <span
                      className={cn(
                        "flex h-4 w-4 items-center justify-center rounded border border-border",
                        selected && "border-primary bg-primary text-primary-foreground",
                      )}
                    >
                      {selected ? <Check size={11} aria-hidden="true" /> : null}
                    </span>
                    <span className="truncate">{profile.label}</span>
                  </Button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("digitalHumans.team.memberCount", { count: members.size })}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!name.trim() || members.size < 2 || busy}
            onClick={() =>
              onSave({
                id: `team-${Date.now().toString(36)}`,
                name: name.trim(),
                ...(description.trim() ? { description: description.trim() } : {}),
                members: [...members],
                mode,
              })
            }
          >
            {busy ? t("digitalHumans.team.saving") : t("digitalHumans.team.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmptyState({
  Icon,
  title,
  description,
}: {
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <Card>
      <CardContent className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Icon size={20} aria-hidden="true" />
        </span>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}
