import { useEffect, useRef, useState } from "react";
import { FlaskConical, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LabQueryType } from "../../shared/optimization-lab";
import { useT } from "../i18n";
import { OptimizationLabSummary } from "./OptimizationLabSummary";
import { DatasetEditor } from "./DatasetEditor";
import { datasetDrafts } from "./dataset-drafts";
import type { EvidenceBundle } from "@cjhyy/code-shell-capability-optimization-lab";

interface Discovery {
  skills: Array<{ name: string; source: string; enabled?: boolean }>;
  connections: Array<{
    id: string;
    label: string;
    model: string;
    provider: string;
    eligible: boolean;
    reason?: string;
  }>;
}
export interface LabSnapshot {
  id: string;
  plan: Record<string, any>;
  state: { revision: number; status: string; phase?: string; [key: string]: any };
  estimate?: { maxRequests: number; maxExecutionMs: number; [key: string]: unknown };
  [key: string]: any;
}

const sampleDataset = JSON.stringify(
  {
    schemaVersion: 1,
    title: "Text task examples",
    taskFamily: "summarize",
    cases: Array.from({ length: 6 }, (_, index) => ({
      id: `example-${index + 1}`,
      version: 1,
      sourceGroupId: `source-${index + 1}`,
      provenance: "synthetic",
      caseRole: index === 0 ? "target_failure" : "regression",
      split: index < 3 ? "dev" : "holdout",
      input: `Summarize this independently reviewed example ${index + 1}.`,
      fixtureRefs: [],
      rubric: [
        { id: "quality", text: "Faithful, concise and complete.", requiresHumanGrading: true },
      ],
      hardAssertions: [],
      readiness: "runnable",
      missingEvidence: [],
    })),
  },
  null,
  2,
);
const activeStatuses = new Set([
  "baselining",
  "proposing",
  "screening",
  "final_evaluating",
  "running",
]);

export function OptimizationLabPage(props: { activeProjectId?: string | null }) {
  // A project change remounts all experiment and authorization state before paint.
  return <OptimizationLabProjectPage key={props.activeProjectId ?? "none"} {...props} />;
}

function OptimizationLabProjectPage({ activeProjectId }: { activeProjectId?: string | null }) {
  const { t } = useT();
  const [enabled, setEnabled] = useState(false);
  const [discovery, setDiscovery] = useState<Discovery>({ skills: [], connections: [] });
  const [experiments, setExperiments] = useState<any[]>([]);
  const [skillName, setSkillName] = useState("");
  const [targetId, setTargetId] = useState("");
  const [optimizerId, setOptimizerId] = useState("");
  const [datasetText, setDatasetText] = useState(
    () => (activeProjectId && datasetDrafts.get(activeProjectId)) ?? sampleDataset,
  );
  const [validation, setValidation] = useState<any>(null);
  const [evidenceIds, setEvidenceIds] = useState("");
  const [evidencePreview, setEvidencePreview] = useState<{
    previewId: string;
    bundle: EvidenceBundle;
  } | null>(null);
  const [trialSource, setTrialSource] = useState<{
    id: string;
    hash: string;
    bodyHash: string;
    body: string;
    model: string;
  } | null>(null);
  const [objective, setObjective] = useState<"quality" | "cost">("quality");
  const [limits, setLimits] = useState({
    maxRequests: 32,
    maxExecutionMs: 600_000,
    maxOutputTokens: 2048,
    timeoutMs: 30_000,
    maxCandidates: 1,
  });
  const [maxEstimatedTokens, setMaxTokens] = useState("");
  const [maxFee, setMaxFee] = useState("");
  const [expiryMinutes, setExpiryMinutes] = useState(60);
  const [authorizationRequests, setAuthorizationRequests] = useState(32);
  const [authorizationExecutionMs, setAuthorizationExecutionMs] = useState(600_000);
  const [snapshot, setSnapshot] = useState<LabSnapshot | null>(null);
  const [report, setReport] = useState<{ hash: string; markdown: string; json: unknown } | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const datasetRevision = useRef(0);
  const editDataset = (text: string) => {
    datasetRevision.current++;
    setDatasetText(text);
    setValidation(null);
    if (activeProjectId) datasetDrafts.set(activeProjectId, text);
  };
  const errorMessage = (failure: unknown) => {
    const message = String(failure);
    return /(?:unknown|unsupported|not registered).*optimization_lab_|optimization_lab_.*(?:unknown|unsupported|not registered)/i.test(
      message,
    )
      ? t("optimizationLab.restartRequired")
      : message;
  };
  const target = activeProjectId ? { projectId: activeProjectId } : null;
  useEffect(() => {
    if (!snapshot) return;
    setAuthorizationRequests(
      snapshot.grant?.maxRequests ?? snapshot.estimate?.maxRequests ?? limits.maxRequests,
    );
    setAuthorizationExecutionMs(
      snapshot.grant?.maxExecutionMs ?? snapshot.estimate?.maxExecutionMs ?? limits.maxExecutionMs,
    );
  }, [snapshot?.id, snapshot?.grant?.revision]);
  const query = async <T,>(
    type: LabQueryType,
    params: Record<string, unknown> = {},
  ): Promise<T> => {
    if (!target) return Promise.reject(new Error(t("optimizationLab.selectProject")));
    const current = epoch.current;
    const result = await window.codeshell.optimizationLab.query<T>(type, { target, ...params });
    if (current !== epoch.current) throw new Error("Project changed");
    return result;
  };
  const run = async (action: () => Promise<void>) => {
    const current = epoch.current;
    setPending(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      if (current === epoch.current) setError(errorMessage(failure));
    } finally {
      if (current === epoch.current) setPending(false);
    }
  };
  const loadList = async () => {
    const result = await query<any>("list");
    setExperiments(Array.isArray(result) ? result : (result.experiments ?? []));
  };
  useEffect(() => {
    const current = ++epoch.current;
    setSnapshot(null);
    setReport(null);
    setValidation(null);
    setError("");
    setPending(false);
    void window.codeshell
      .getSettings("user")
      .then((settings) => {
        const on =
          (settings?.featureFlags as Record<string, boolean> | undefined)?.optimization_lab ===
          true;
        if (current !== epoch.current) return;
        setEnabled(on);
        if (!on || !activeProjectId) return;
        setPending(true);
        return Promise.all([
          window.codeshell.optimizationLab.query<Discovery>("discover", {
            target: { projectId: activeProjectId },
          }),
          window.codeshell.optimizationLab.query<any>("list", {
            target: { projectId: activeProjectId },
          }),
        ]).then(([found, saved]) => {
          if (current !== epoch.current) return;
          setDiscovery(found);
          setSkillName(found.skills[0]?.name ?? "");
          const first = found.connections.find((connection) => connection.eligible)?.id ?? "";
          setTargetId(first);
          setOptimizerId(first);
          setExperiments(Array.isArray(saved) ? saved : (saved.experiments ?? []));
        });
      })
      .catch((failure) => {
        if (current === epoch.current) setError(errorMessage(failure));
      })
      .finally(() => {
        if (current === epoch.current) setPending(false);
      });
    return () => {
      epoch.current++;
    };
  }, [activeProjectId]);
  useEffect(() => {
    if (!snapshot || !target || !activeStatuses.has(snapshot.state.status)) return;
    const current = epoch.current;
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void window.codeshell.optimizationLab
        .query<LabSnapshot>("status", { target, id: snapshot.id })
        .then((next) => {
          if (current === epoch.current) setSnapshot(next);
        })
        .catch((failure) => {
          if (current === epoch.current) setError(errorMessage(failure));
        })
        .finally(() => {
          inFlight = false;
        });
    }, 1200);
    return () => clearInterval(timer);
  }, [activeProjectId, snapshot?.id, snapshot?.state.status]);
  const act = (type: "start" | "continue" | "stop" | "revoke") =>
    run(async () => {
      if (!snapshot) return;
      const next = await query<LabSnapshot>(type, {
        id: snapshot.id,
        expectedRevision: snapshot.state.revision,
        operationId:
          type === "start"
            ? (snapshot.grant?.startOperationId ?? crypto.randomUUID())
            : crypto.randomUUID(),
      });
      setSnapshot(next);
      setReport(null);
      await loadList();
    });
  const inputClass = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  const field = (key: keyof typeof limits, label: string) => (
    <label className="space-y-1 text-sm" key={key}>
      <span>{label}</span>
      <input
        data-testid={`optimization-lab-${key}`}
        className={inputClass}
        type="number"
        min={1}
        step={1}
        value={limits[key]}
        onChange={(event) =>
          setLimits((current) => ({ ...current, [key]: Number(event.target.value) }))
        }
      />
    </label>
  );
  if (!enabled) return <div className="p-6">{t("optimizationLab.disabled")}</div>;
  if (!target) return <div className="p-6">{t("optimizationLab.selectProject")}</div>;
  const status = snapshot?.state.status ?? "draft";
  const running = activeStatuses.has(status);
  const waiting = status.startsWith("awaiting_");
  const hasGrading = Boolean(snapshot?.state.data?.templateRef) || waiting;
  const hasReport = Boolean(snapshot?.state.data?.reportRef);
  return (
    <div data-testid="optimization-lab-page" className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <FlaskConical size={22} />
              {t("optimizationLab.title")}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">{t("optimizationLab.subtitle")}</p>
          </div>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              void run(async () => {
                await loadList();
                if (snapshot) setSnapshot(await query("get", { id: snapshot.id }));
              })
            }
          >
            <RefreshCw size={14} />
            {t("optimizationLab.refresh")}
          </Button>
        </div>
        {error && (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
          >
            {error}
          </p>
        )}
        <section className="rounded-xl border p-4 space-y-3">
          <h2 className="font-medium">{t("optimizationLab.saved")}</h2>
          <select
            data-testid="optimization-lab-saved"
            className={inputClass}
            value={snapshot?.id ?? ""}
            disabled={pending}
            onChange={(event) => {
              const id = event.target.value;
              void run(async () => {
                setReport(null);
                setSnapshot(id ? await query("get", { id }) : null);
              });
            }}
          >
            <option value="">{t("optimizationLab.newExperiment")}</option>
            {experiments.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title ?? item.id} · {item.status ?? item.state?.status}
              </option>
            ))}
          </select>
        </section>
        {!snapshot && (
          <section className="rounded-xl border p-4 space-y-4">
            <h2 className="font-medium">{t("optimizationLab.materials")}</h2>
            {trialSource && (
              <div
                className="rounded-md bg-muted p-3 text-sm space-y-2"
                data-testid="optimization-lab-trial-source"
              >
                <p>{t("optimizationLab.fixedTrialHelp")}</p>
                <p>
                  {trialSource.model} · {trialSource.hash}
                </p>
                <details>
                  <summary>{t("optimizationLab.fixedBody")}</summary>
                  <pre className="whitespace-pre-wrap max-h-64 overflow-auto">
                    {trialSource.body}
                  </pre>
                </details>
                <Button variant="outline" disabled={pending} onClick={() => setTrialSource(null)}>
                  {t("optimizationLab.normalExperiment")}
                </Button>
              </div>
            )}
            {!trialSource && (
              <div className="grid gap-4 sm:grid-cols-3">
                <label className="space-y-1 text-sm">
                  <span>{t("optimizationLab.skill")}</span>
                  <select
                    data-testid="optimization-lab-skill"
                    className={inputClass}
                    value={skillName}
                    disabled={Boolean(trialSource)}
                    onChange={(e) => setSkillName(e.target.value)}
                  >
                    {discovery.skills.map((skill) => (
                      <option key={skill.name} value={skill.name}>
                        {skill.name} · {skill.source}
                      </option>
                    ))}
                  </select>
                </label>
                {[
                  {
                    label: t("optimizationLab.target"),
                    id: "target-connection",
                    value: targetId,
                    set: setTargetId,
                  },
                  {
                    label: t("optimizationLab.optimizer"),
                    id: "optimizer-connection",
                    value: optimizerId,
                    set: setOptimizerId,
                  },
                ].map((item) => (
                  <label key={item.id} className="space-y-1 text-sm">
                    <span>{item.label}</span>
                    <select
                      data-testid={`optimization-lab-${item.id}`}
                      className={inputClass}
                      value={item.value}
                      disabled={Boolean(trialSource)}
                      onChange={(e) => item.set(e.target.value)}
                    >
                      {discovery.connections.map((connection) => (
                        <option
                          key={connection.id}
                          value={connection.id}
                          disabled={!connection.eligible}
                        >
                          {connection.label} · {connection.model}
                          {connection.reason ? ` (${connection.reason})` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}
            {discovery.connections
              .filter((item) => !item.eligible)
              .map((item) => (
                <p className="text-xs text-muted-foreground" key={item.id}>
                  {item.label}: {item.reason}
                </p>
              ))}
            <p className="text-sm text-muted-foreground">{t("optimizationLab.datasetHelp")}</p>
            <div className="rounded-md border p-3 space-y-3">
              <label className="block text-sm space-y-1">
                <span>{t("optimizationLab.evidenceIds")}</span>
                <textarea
                  data-testid="optimization-lab-evidence-ids"
                  className={inputClass}
                  value={evidenceIds}
                  disabled={pending}
                  onChange={(event) => {
                    setEvidenceIds(event.target.value);
                    setEvidencePreview(null);
                  }}
                />
              </label>
              <p className="text-xs text-muted-foreground">{t("optimizationLab.evidenceHelp")}</p>
              <Button
                data-testid="optimization-lab-preview-evidence"
                variant="outline"
                disabled={pending || !evidenceIds.trim()}
                onClick={() =>
                  void run(async () => {
                    const current = epoch.current;
                    const preview = await window.codeshell.optimizationLab.previewEvidence({
                      target,
                      runIds: evidenceIds.split(/\s+/).filter(Boolean),
                    });
                    if (current === epoch.current) setEvidencePreview(preview);
                  })
                }
              >
                {t("optimizationLab.previewEvidence")}
              </Button>
              {evidencePreview && (
                <div data-testid="optimization-lab-evidence-preview" className="space-y-2">
                  <p className="text-sm">{t("optimizationLab.evidenceReview")}</p>
                  <pre className="max-h-80 overflow-auto text-xs whitespace-pre-wrap">
                    {JSON.stringify(evidencePreview.bundle, null, 2)}
                  </pre>
                  <Button
                    data-testid="optimization-lab-import-evidence"
                    disabled={pending}
                    onClick={() =>
                      void run(async () => {
                        const current = epoch.current;
                        const revision = datasetRevision.current;
                        const imported = await window.codeshell.optimizationLab.importEvidence({
                          target,
                          previewId: evidencePreview.previewId,
                          bundleHash: evidencePreview.bundle.bundleHash,
                        });
                        if (!imported || current !== epoch.current) return;
                        if (revision !== datasetRevision.current)
                          throw new Error(t("optimizationLab.evidenceDraftChanged"));
                        const dataset = JSON.parse(datasetText);
                        if (!Array.isArray(dataset.cases)) throw new Error("Invalid draft cases");
                        const ids = new Set(dataset.cases.map((item: any) => item.id));
                        for (const item of imported.cases) {
                          let id = item.id,
                            suffix = 1;
                          while (ids.has(id)) id = `${item.id}-${suffix++}`;
                          ids.add(id);
                          dataset.cases.push({ ...item, id });
                        }
                        editDataset(JSON.stringify(dataset, null, 2));
                        setEvidencePreview(null);
                      })
                    }
                  >
                    {t("optimizationLab.importEvidence")}
                  </Button>
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                data-testid="optimization-lab-import-dataset"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    const current = epoch.current;
                    const text = await window.codeshell.optimizationLab.importDataset({ target });
                    if (text !== null && current === epoch.current) editDataset(text);
                  })
                }
              >
                {t("optimizationLab.importDataset")}
              </Button>
              <Button
                data-testid="optimization-lab-export-dataset"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    await window.codeshell.optimizationLab.exportDataset({
                      target,
                      text: datasetText,
                    });
                  })
                }
              >
                {t("optimizationLab.exportDataset")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("optimizationLab.draftHelp")}</p>
            <DatasetEditor
              value={datasetText}
              onChange={editDataset}
              validation={validation}
              disabled={pending}
            />
            <Button
              data-testid="optimization-lab-validate"
              variant="outline"
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  const dataset = JSON.parse(datasetText);
                  const revision = datasetRevision.current;
                  const valid = await query<any>("validate_dataset", { dataset });
                  if (revision !== datasetRevision.current) return;
                  setValidation(valid);
                  if (valid.ok) {
                    const frozen = await query("freeze_dataset", { dataset });
                    if (revision === datasetRevision.current) setValidation({ ...valid, frozen });
                  }
                })
              }
            >
              {t("optimizationLab.validateFreeze")}
            </Button>
            {validation && (
              <pre
                data-testid="optimization-lab-validation"
                className="max-h-48 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap"
              >
                {JSON.stringify(validation, null, 2)}
              </pre>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              {field("maxRequests", t("optimizationLab.maxRequests"))}
              {field("maxExecutionMs", t("optimizationLab.maxExecution"))}
              {field("maxOutputTokens", t("optimizationLab.maxOutput"))}
              {field("timeoutMs", t("optimizationLab.timeout"))}
              <label className="space-y-1 text-sm">
                <span>{t("optimizationLab.candidates")}</span>
                <select
                  className={inputClass}
                  value={limits.maxCandidates}
                  disabled={Boolean(trialSource)}
                  onChange={(e) =>
                    setLimits((current) => ({ ...current, maxCandidates: Number(e.target.value) }))
                  }
                >
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                </select>
              </label>
              <label className="space-y-1 text-sm">
                <span>{t("optimizationLab.objective")}</span>
                <select
                  className={inputClass}
                  value={objective}
                  onChange={(e) => setObjective(e.target.value as "quality" | "cost")}
                >
                  <option value="quality">{t("optimizationLab.quality")}</option>
                  <option value="cost">{t("optimizationLab.cost")}</option>
                </select>
              </label>
            </div>
            <Button
              data-testid="optimization-lab-prepare"
              disabled={pending || (!trialSource && (!skillName || !targetId || !optimizerId))}
              onClick={() =>
                void run(async () => {
                  const prepared = await query<LabSnapshot>(
                    trialSource ? "prepare_trial" : "prepare",
                    {
                      dataset: JSON.parse(datasetText),
                      ...(trialSource
                        ? { sourceExperimentId: trialSource.id, candidateHash: trialSource.hash }
                        : {
                            skillName,
                            targetConnectionId: targetId,
                            optimizerConnectionId: optimizerId,
                          }),
                      objective,
                      limits: { ...limits, repeats: 1 },
                    },
                  );
                  setSnapshot(prepared);
                  await loadList();
                })
              }
            >
              {t(trialSource ? "optimizationLab.prepareTrial" : "optimizationLab.prepare")}
            </Button>
          </section>
        )}
        {snapshot && (
          <>
            <section className="rounded-xl border p-4 space-y-3">
              <h2 className="font-medium">{t("optimizationLab.frozenPlan")}</h2>
              <OptimizationLabSummary snapshot={snapshot} />
              {!running && hasReport && snapshot.candidates?.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    {t("optimizationLab.fixedTrialHelp")}
                  </p>
                  {snapshot.candidates.map((candidate: any) => (
                    <div key={candidate.hash} className="rounded-md border p-3 space-y-2 text-sm">
                      <p>{candidate.explanation}</p>
                      <p className="break-all text-xs">{candidate.hash}</p>
                      <Button
                        data-testid="optimization-lab-try-candidate"
                        disabled={pending}
                        variant="outline"
                        onClick={() => {
                          setTrialSource({
                            id: snapshot.id,
                            hash: candidate.hash,
                            bodyHash: candidate.bodyHash,
                            body: candidate.body,
                            model: `${snapshot.plan.connections.target.connectionId} / ${snapshot.plan.connections.target.modelId}`,
                          });
                          setSnapshot(null);
                          setReport(null);
                          setValidation(null);
                          setEvidencePreview(null);
                        }}
                      >
                        {t("optimizationLab.tryCandidate")}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <section className="rounded-xl border p-4 space-y-4">
              <h2 className="font-medium">{t("optimizationLab.authorization")}</h2>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="space-y-1 text-sm">
                  <span>{t("optimizationLab.maxRequests")}</span>
                  <input
                    data-testid="optimization-lab-authorization-requests"
                    className={inputClass}
                    type="number"
                    min={1}
                    step={1}
                    value={authorizationRequests}
                    onChange={(e) => setAuthorizationRequests(Number(e.target.value))}
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span>{t("optimizationLab.maxExecution")}</span>
                  <input
                    data-testid="optimization-lab-authorization-execution"
                    className={inputClass}
                    type="number"
                    min={1}
                    step={1}
                    value={authorizationExecutionMs}
                    onChange={(e) => setAuthorizationExecutionMs(Number(e.target.value))}
                  />
                </label>

                <label className="space-y-1 text-sm">
                  <span>{t("optimizationLab.tokenThreshold")}</span>
                  <input
                    data-testid="optimization-lab-token-threshold"
                    className={inputClass}
                    type="number"
                    min={1}
                    value={maxEstimatedTokens}
                    placeholder={t("optimizationLab.unknown")}
                    onChange={(e) => setMaxTokens(e.target.value)}
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span>{t("optimizationLab.feeThreshold")}</span>
                  <input
                    data-testid="optimization-lab-fee-threshold"
                    className={inputClass}
                    type="number"
                    min={0.000001}
                    step="any"
                    value={maxFee}
                    placeholder={t("optimizationLab.unknown")}
                    onChange={(e) => setMaxFee(e.target.value)}
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span>{t("optimizationLab.expiry")}</span>
                  <input
                    className={inputClass}
                    type="number"
                    min={1}
                    value={expiryMinutes}
                    onChange={(e) => setExpiryMinutes(Number(e.target.value))}
                  />
                </label>
              </div>
              <Button
                data-testid="optimization-lab-authorize"
                variant="outline"
                disabled={
                  pending || running || ["report_ready", "cancelled", "failed"].includes(status)
                }
                onClick={() =>
                  void run(async () => {
                    const current = epoch.current;
                    const next = await window.codeshell.optimizationLab.authorize({
                      target,
                      id: snapshot.id,
                      expectedRevision: snapshot.state.revision,
                      planHash: snapshot.plan.planHash,
                      operationId: crypto.randomUUID(),
                      expiresAt: new Date(Date.now() + expiryMinutes * 60_000).toISOString(),
                      limits: {
                        maxRequests: authorizationRequests,
                        maxExecutionMs: authorizationExecutionMs,
                        maxEstimatedTokens: maxEstimatedTokens ? Number(maxEstimatedTokens) : null,
                        maxEstimatedCostUsd: maxFee ? Number(maxFee) : null,
                      },
                    });
                    if (next && current === epoch.current) setSnapshot(next as LabSnapshot);
                  })
                }
              >
                {t("optimizationLab.authorize")}
              </Button>
              <p className="text-sm text-muted-foreground">{t("optimizationLab.authorizeHelp")}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  data-testid="optimization-lab-start"
                  disabled={pending || status !== "authorized"}
                  onClick={() => void act("start")}
                >
                  {t("optimizationLab.start")}
                </Button>
                <Button
                  data-testid="optimization-lab-continue"
                  disabled={
                    pending || !(waiting || ["interrupted", "budget_exhausted"].includes(status))
                  }
                  onClick={() => void act("continue")}
                >
                  {t("optimizationLab.continue")}
                </Button>
                <Button
                  data-testid="optimization-lab-stop"
                  variant="outline"
                  disabled={pending || !(running || waiting)}
                  onClick={() => void act("stop")}
                >
                  {t("optimizationLab.stop")}
                </Button>
                <Button
                  data-testid="optimization-lab-revoke"
                  variant="outline"
                  disabled={
                    pending ||
                    ["draft", "ready", "report_ready", "cancelled", "failed"].includes(status)
                  }
                  onClick={() => void act("revoke")}
                >
                  {t("optimizationLab.revoke")}
                </Button>
              </div>
            </section>
            <section className="rounded-xl border p-4 space-y-3">
              <h2 className="font-medium">{t("optimizationLab.gradingReport")}</h2>
              <p className="text-sm text-muted-foreground">{t("optimizationLab.gradingHelp")}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  data-testid="optimization-lab-export-grading"
                  variant="outline"
                  disabled={pending || running || !hasGrading}
                  onClick={() =>
                    void run(async () => {
                      await window.codeshell.optimizationLab.exportFile({
                        target,
                        id: snapshot.id,
                        kind: "grading",
                      });
                    })
                  }
                >
                  {t("optimizationLab.exportGrading")}
                </Button>
                <Button
                  data-testid="optimization-lab-import-grading"
                  variant="outline"
                  disabled={pending || running || !hasGrading}
                  onClick={() =>
                    void run(async () => {
                      const current = epoch.current;
                      const next = await window.codeshell.optimizationLab.importGrading({
                        target,
                        id: snapshot.id,
                        expectedRevision: snapshot.state.revision,
                      });
                      if (next && current === epoch.current) {
                        setSnapshot(next as LabSnapshot);
                        setReport(null);
                      }
                    })
                  }
                >
                  {t("optimizationLab.importGrading")}
                </Button>
                <Button
                  data-testid="optimization-lab-open-report"
                  variant="outline"
                  disabled={pending || running || !hasReport}
                  onClick={() =>
                    void run(async () => {
                      setReport(await query("report", { id: snapshot.id }));
                    })
                  }
                >
                  {t("optimizationLab.openReport")}
                </Button>
              </div>
              {report && (
                <>
                  <p className="break-all font-mono text-xs">{report.hash}</p>
                  <pre
                    data-testid="optimization-lab-report"
                    className="max-h-[36rem] overflow-auto rounded-md bg-muted p-4 text-xs whitespace-pre-wrap"
                  >
                    {report.markdown}
                  </pre>
                  <div className="flex gap-2">
                    {(["report-markdown", "report-json"] as const).map((kind) => (
                      <Button
                        key={kind}
                        variant="outline"
                        disabled={pending}
                        onClick={() =>
                          void run(async () => {
                            await window.codeshell.optimizationLab.exportFile({
                              target,
                              id: snapshot.id,
                              kind,
                            });
                          })
                        }
                      >
                        {kind === "report-json" ? "JSON" : "Markdown"}
                      </Button>
                    ))}
                  </div>
                </>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
