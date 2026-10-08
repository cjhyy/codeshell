import { useState } from "react";
import type {
  DatasetValidation,
  HardAssertion,
} from "@cjhyy/code-shell-capability-optimization-lab";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n";
import {
  changeAssertionKind,
  createEditableCase,
  duplicateEditableCase,
  newAssertion,
  newRubric,
  parseEditableDataset,
  serializeEditableDataset,
  summarizeEditableDataset,
  type EditableCase,
} from "./dataset-editor";

const inputClass = "w-full rounded-md border bg-background px-3 py-2 text-sm";
const testId = (id: string) => `optimization-lab-${id}`;

function TextList({
  label,
  values,
  onChange,
  id,
  limit,
}: {
  label: string;
  values: string[];
  onChange(values: string[]): void;
  id: string;
  limit: number;
}) {
  const { t } = useT();
  return (
    <fieldset className="space-y-2 rounded-md border p-3">
      <legend className="px-1 text-sm">{label}</legend>
      {values.map((value, index) => (
        <div className="flex items-center gap-2" key={index}>
          <textarea
            rows={1}
            aria-label={`${label} ${index + 1}`}
            data-testid={testId(`${id}-${index}`)}
            className={inputClass}
            value={value}
            onChange={(event) =>
              onChange(values.map((item, i) => (i === index ? event.target.value : item)))
            }
          />
          <Button
            type="button"
            variant="outline"
            aria-label={`${t("optimizationLab.editor.remove")} ${label} ${index + 1}`}
            data-testid={testId(`${id}-${index}-remove`)}
            onClick={() => onChange(values.filter((_, i) => i !== index))}
          >
            {t("optimizationLab.editor.remove")}
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        data-testid={testId(`${id}-add`)}
        disabled={values.length >= limit}
        onClick={() => onChange([...values, ""])}
      >
        {t("optimizationLab.editor.add")}
      </Button>
    </fieldset>
  );
}

function AssertionEditor({
  value,
  onChange,
  id,
}: {
  value: HardAssertion;
  onChange(value: HardAssertion): void;
  id: string;
}) {
  const { t } = useT();
  const scalarType = value.value === null ? "null" : typeof value.value;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span>{t("optimizationLab.editor.criterionId")}</span>
          <input
            className={inputClass}
            data-testid={testId(`${id}-id`)}
            value={value.id}
            onChange={(event) => onChange({ ...value, id: event.target.value })}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span>{t("optimizationLab.editor.assertionKind")}</span>
          <select
            className={inputClass}
            data-testid={testId(`${id}-kind`)}
            value={value.kind}
            onChange={(event) =>
              onChange(changeAssertionKind(value, event.target.value as HardAssertion["kind"]))
            }
          >
            <option value="contains">{t("optimizationLab.editor.contains")}</option>
            <option value="not_contains">{t("optimizationLab.editor.notContains")}</option>
            <option value="json_field_equals">{t("optimizationLab.editor.jsonFieldEquals")}</option>
          </select>
        </label>
      </div>
      {value.kind === "json_field_equals" && (
        <>
          <TextList
            label={t("optimizationLab.editor.jsonPath")}
            values={value.path}
            id={`${id}-path`}
            limit={8}
            onChange={(path) => onChange({ ...value, path })}
          />
          <label className="block space-y-1 text-sm">
            <span>{t("optimizationLab.editor.valueType")}</span>
            <select
              className={inputClass}
              data-testid={testId(`${id}-value-type`)}
              value={scalarType}
              onChange={(event) =>
                onChange({
                  ...value,
                  value: ({ string: "", number: 0, boolean: false, null: null } as const)[
                    event.target.value as "string" | "number" | "boolean" | "null"
                  ],
                })
              }
            >
              <option value="string">{t("optimizationLab.editor.string")}</option>
              <option value="number">{t("optimizationLab.editor.number")}</option>
              <option value="boolean">{t("optimizationLab.editor.boolean")}</option>
              <option value="null">null</option>
            </select>
          </label>
        </>
      )}
      {typeof value.value === "string" ? (
        <label className="block space-y-1 text-sm">
          <span>{t("optimizationLab.editor.assertionValue")}</span>
          <textarea
            className={`${inputClass} min-h-20`}
            data-testid={testId(`${id}-value`)}
            value={value.value}
            onChange={(event) => onChange({ ...value, value: event.target.value })}
          />
        </label>
      ) : typeof value.value === "number" ? (
        <label className="block space-y-1 text-sm">
          <span>{t("optimizationLab.editor.assertionValue")}</span>
          <input
            className={inputClass}
            type="number"
            step="any"
            data-testid={testId(`${id}-value`)}
            value={value.value}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next)) onChange({ ...value, value: next });
            }}
          />
        </label>
      ) : typeof value.value === "boolean" ? (
        <label className="block space-y-1 text-sm">
          <span>{t("optimizationLab.editor.assertionValue")}</span>
          <select
            className={inputClass}
            data-testid={testId(`${id}-value`)}
            value={String(value.value)}
            onChange={(event) => onChange({ ...value, value: event.target.value === "true" })}
          >
            <option value="false">false</option>
            <option value="true">true</option>
          </select>
        </label>
      ) : (
        <p className="text-sm text-muted-foreground">{t("optimizationLab.editor.nullValue")}</p>
      )}
    </div>
  );
}

export function DatasetEditor({
  value,
  onChange,
  validation,
  disabled = false,
}: {
  value: string;
  onChange(text: string): void;
  validation?: DatasetValidation | null;
  disabled?: boolean;
}) {
  const { t } = useT();
  const [mode, setMode] = useState<"form" | "json">("form");
  const [expandedCase, setExpandedCase] = useState(0);
  const parsed = parseEditableDataset(value);
  const dataset = parsed.ok ? parsed.dataset : null;
  const summary = dataset ? summarizeEditableDataset(dataset) : null;
  const emit = (next: NonNullable<typeof dataset>) => onChange(serializeEditableDataset(next));
  const updateCase = (index: number, patch: Partial<EditableCase>) => {
    if (dataset)
      emit({
        ...dataset,
        cases: dataset.cases.map((item, i) => (i === index ? { ...item, ...patch } : item)),
      });
  };
  const caseIssues = (index: number) =>
    validation?.issues.filter((issue) =>
      issue.caseId
        ? issue.caseId === dataset?.cases[index]?.id
        : issue.message.startsWith(`cases.${index}.`),
    ) ?? [];
  const issues =
    validation?.issues.filter((issue) => {
      if (mode === "json" || !dataset) return true;
      if (issue.caseId) return !dataset.cases.some((item) => item.id === issue.caseId);
      const index = /^cases\.(\d+)\./.exec(issue.message)?.[1];
      return index === undefined || !dataset.cases[Number(index)];
    }) ?? [];
  const textField = (
    index: number,
    key: "id" | "sourceGroupId" | "input" | "expected",
    label: string,
    multiline = false,
  ) => {
    const attributes = {
      className: `${inputClass}${multiline ? " min-h-24" : ""}`,
      "data-testid": testId(`case-${index}-${key}`),
      value: dataset!.cases[index]![key] ?? "",
      onChange: (event: { target: { value: string } }) =>
        updateCase(index, { [key]: event.target.value }),
    };
    return (
      <label className="block space-y-1 text-sm">
        <span>{label}</span>
        {multiline || key === "sourceGroupId" ? (
          <textarea rows={multiline ? 3 : 1} {...attributes} />
        ) : (
          <input {...attributes} />
        )}
      </label>
    );
  };
  const choice = (
    index: number,
    key: "provenance" | "caseRole" | "split" | "readiness",
    label: string,
    options: Array<[string, string]>,
  ) => (
    <label className="space-y-1 text-sm">
      <span>{label}</span>
      <select
        className={inputClass}
        data-testid={testId(`case-${index}-${key}`)}
        value={dataset!.cases[index]![key]}
        onChange={(event) => updateCase(index, { [key]: event.target.value })}
      >
        {options.map(([option, title]) => (
          <option key={option} value={option}>
            {title}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="space-y-3" data-testid={testId("dataset-editor")}>
      <div
        className="flex flex-wrap items-center gap-2"
        role="group"
        aria-label={t("optimizationLab.editor.mode")}
      >
        <Button
          type="button"
          variant={mode === "form" ? "default" : "outline"}
          data-testid={testId("dataset-form")}
          disabled={disabled}
          aria-pressed={mode === "form"}
          onClick={() => setMode("form")}
        >
          {t("optimizationLab.editor.form")}
        </Button>
        <Button
          type="button"
          variant={mode === "json" ? "default" : "outline"}
          data-testid={testId("dataset-json")}
          disabled={disabled}
          aria-pressed={mode === "json"}
          onClick={() => setMode("json")}
        >
          {t("optimizationLab.editor.json")}
        </Button>
      </div>
      {!parsed.ok && (
        <p
          role="alert"
          data-testid={testId("dataset-unsupported")}
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
        >
          {t(`optimizationLab.editor.unsupported.${parsed.reason}`)} ({parsed.path}){" "}
          {t("optimizationLab.editor.fixJson")}
        </p>
      )}
      {mode === "json" || !dataset ? (
        <textarea
          data-testid={testId("dataset")}
          aria-label={t("optimizationLab.dataset")}
          className={`${inputClass} min-h-64 font-mono text-xs`}
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <fieldset disabled={disabled} className="space-y-4" data-testid={testId("dataset-fields")}>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span>{t("optimizationLab.editor.title")}</span>
              <textarea
                rows={1}
                className={inputClass}
                data-testid={testId("dataset-title")}
                value={dataset.title}
                onChange={(event) => emit({ ...dataset, title: event.target.value })}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span>{t("optimizationLab.editor.taskFamily")}</span>
              <textarea
                rows={1}
                className={inputClass}
                data-testid={testId("dataset-task-family")}
                value={dataset.taskFamily}
                onChange={(event) => emit({ ...dataset, taskFamily: event.target.value })}
              />
            </label>
          </div>
          <p className="text-sm text-muted-foreground" data-testid={testId("dataset-counts")}>
            {t("optimizationLab.devCases")}: {summary!.dev} · {t("optimizationLab.holdoutCases")}:{" "}
            {summary!.holdout} · {t("optimizationLab.sourceGroups")}: {summary!.sourceGroups}
          </p>
          {summary!.runnableHoldoutGroups > 0 && summary!.runnableHoldoutGroups < 3 && (
            <p
              role="status"
              className="text-sm text-amber-600"
              data-testid={testId("dataset-exploratory")}
            >
              {t("optimizationLab.editor.exploratory")}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {t("optimizationLab.editor.validationHelp")}
          </p>
          {dataset.cases.map((item, index) => (
            <details
              key={index}
              open={index === expandedCase}
              className="rounded-lg border p-3"
              data-testid={testId(`case-${index}`)}
              onToggle={(event) => {
                if (event.currentTarget.open) setExpandedCase(index);
              }}
            >
              <summary
                className="cursor-pointer text-sm font-medium"
                data-testid={testId(`case-${index}-summary`)}
              >
                {t("optimizationLab.editor.case")} {index + 1}: {item.id}
                {caseIssues(index).length > 0 && (
                  <span className="ml-2 text-destructive">({caseIssues(index).length})</span>
                )}
              </summary>
              {index === expandedCase && (
                <div className="mt-3 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-medium">
                      {t("optimizationLab.editor.case")} {index + 1}: {item.id}
                    </h3>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        data-testid={testId(`case-${index}-duplicate`)}
                        disabled={dataset.cases.length >= 200}
                        onClick={() => {
                          setExpandedCase(dataset.cases.length);
                          emit({
                            ...dataset,
                            cases: [...dataset.cases, duplicateEditableCase(dataset, index)],
                          });
                        }}
                      >
                        {t("optimizationLab.editor.duplicate")}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        data-testid={testId(`case-${index}-remove`)}
                        onClick={() => {
                          setExpandedCase(Math.max(0, index - 1));
                          emit({ ...dataset, cases: dataset.cases.filter((_, i) => i !== index) });
                        }}
                      >
                        {t("optimizationLab.editor.remove")}
                      </Button>
                    </div>
                  </div>
                  {caseIssues(index).length > 0 && (
                    <ul className="space-y-1 text-sm" data-testid={testId(`case-${index}-issues`)}>
                      {caseIssues(index).map((issue, i) => (
                        <li
                          key={i}
                          className={
                            issue.level === "error" ? "text-destructive" : "text-amber-600"
                          }
                        >
                          {issue.message}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="grid gap-3 sm:grid-cols-3">
                    {textField(index, "id", t("optimizationLab.editor.caseId"))}
                    <label className="space-y-1 text-sm">
                      <span>{t("optimizationLab.editor.version")}</span>
                      <input
                        className={inputClass}
                        type="number"
                        min={1}
                        step={1}
                        data-testid={testId(`case-${index}-version`)}
                        value={item.version}
                        onChange={(event) => {
                          const version = Number(event.target.value);
                          if (Number.isFinite(version)) updateCase(index, { version });
                        }}
                      />
                    </label>
                    {textField(index, "sourceGroupId", t("optimizationLab.editor.sourceGroup"))}
                    {choice(index, "provenance", t("optimizationLab.editor.provenance"), [
                      ["real", t("optimizationLab.editor.real")],
                      ["synthetic", t("optimizationLab.editor.synthetic")],
                    ])}
                    {choice(index, "caseRole", t("optimizationLab.editor.role"), [
                      ["target_failure", t("optimizationLab.editor.targetFailure")],
                      ["regression", t("optimizationLab.editor.regression")],
                    ])}
                    {choice(index, "split", t("optimizationLab.editor.split"), [
                      ["dev", t("optimizationLab.devCases")],
                      ["holdout", t("optimizationLab.holdoutCases")],
                    ])}
                    {choice(index, "readiness", t("optimizationLab.editor.readiness"), [
                      ["analysis_only", t("optimizationLab.editor.analysisOnly")],
                      ["runnable", t("optimizationLab.editor.runnable")],
                    ])}
                  </div>
                  {textField(index, "input", t("optimizationLab.editor.input"), true)}
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      data-testid={testId(`case-${index}-expected-enabled`)}
                      checked={Object.hasOwn(item, "expected")}
                      onChange={(event) => {
                        const next = { ...item };
                        if (event.target.checked) next.expected = "";
                        else delete next.expected;
                        emit({
                          ...dataset,
                          cases: dataset.cases.map((entry, i) => (i === index ? next : entry)),
                        });
                      }}
                    />
                    {t("optimizationLab.editor.hasExpected")}
                  </label>
                  {Object.hasOwn(item, "expected") &&
                    textField(index, "expected", t("optimizationLab.editor.expected"), true)}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <TextList
                      label={t("optimizationLab.editor.fixtures")}
                      values={item.fixtureRefs ?? []}
                      id={`case-${index}-fixtureRefs`}
                      limit={32}
                      onChange={(fixtureRefs) => updateCase(index, { fixtureRefs })}
                    />
                    <TextList
                      label={t("optimizationLab.editor.missingEvidence")}
                      values={item.missingEvidence ?? []}
                      id={`case-${index}-missingEvidence`}
                      limit={32}
                      onChange={(missingEvidence) => updateCase(index, { missingEvidence })}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("optimizationLab.editor.fixturesHelp")}
                  </p>
                  <fieldset className="space-y-3 rounded-md border p-3">
                    <legend className="px-1 text-sm">{t("optimizationLab.editor.rubric")}</legend>
                    {(item.rubric ?? []).map((rubric, ruleIndex) => (
                      <div key={ruleIndex} className="space-y-2 rounded-md bg-muted/40 p-3">
                        <label className="block space-y-1 text-sm">
                          <span>{t("optimizationLab.editor.criterionId")}</span>
                          <input
                            className={inputClass}
                            data-testid={testId(`case-${index}-rubric-${ruleIndex}-id`)}
                            value={rubric.id}
                            onChange={(event) =>
                              updateCase(index, {
                                rubric: item.rubric!.map((rule, i) =>
                                  i === ruleIndex ? { ...rule, id: event.target.value } : rule,
                                ),
                              })
                            }
                          />
                        </label>
                        <label className="block space-y-1 text-sm">
                          <span>{t("optimizationLab.editor.rubricText")}</span>
                          <textarea
                            className={inputClass}
                            data-testid={testId(`case-${index}-rubric-${ruleIndex}-text`)}
                            value={rubric.text}
                            onChange={(event) =>
                              updateCase(index, {
                                rubric: item.rubric!.map((rule, i) =>
                                  i === ruleIndex ? { ...rule, text: event.target.value } : rule,
                                ),
                              })
                            }
                          />
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            data-testid={testId(`case-${index}-rubric-${ruleIndex}-human`)}
                            checked={rubric.requiresHumanGrading}
                            onChange={(event) =>
                              updateCase(index, {
                                rubric: item.rubric!.map((rule, i) =>
                                  i === ruleIndex
                                    ? { ...rule, requiresHumanGrading: event.target.checked }
                                    : rule,
                                ),
                              })
                            }
                          />
                          {t("optimizationLab.editor.humanGrading")}
                        </label>
                        <Button
                          type="button"
                          variant="outline"
                          data-testid={testId(`case-${index}-rubric-${ruleIndex}-remove`)}
                          onClick={() =>
                            updateCase(index, {
                              rubric: item.rubric!.filter((_, i) => i !== ruleIndex),
                            })
                          }
                        >
                          {t("optimizationLab.editor.remove")}
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      data-testid={testId(`case-${index}-rubric-add`)}
                      disabled={(item.rubric?.length ?? 0) >= 16}
                      onClick={() =>
                        updateCase(index, { rubric: [...(item.rubric ?? []), newRubric(item)] })
                      }
                    >
                      {t("optimizationLab.editor.addRubric")}
                    </Button>
                  </fieldset>
                  <fieldset className="space-y-3 rounded-md border p-3">
                    <legend className="px-1 text-sm">
                      {t("optimizationLab.editor.assertions")}
                    </legend>
                    {(item.hardAssertions ?? []).map((assertion, ruleIndex) => (
                      <div key={ruleIndex} className="space-y-2 rounded-md bg-muted/40 p-3">
                        <AssertionEditor
                          value={assertion}
                          id={`case-${index}-assertion-${ruleIndex}`}
                          onChange={(next) =>
                            updateCase(index, {
                              hardAssertions: item.hardAssertions!.map((rule, i) =>
                                i === ruleIndex ? next : rule,
                              ),
                            })
                          }
                        />
                        <Button
                          type="button"
                          variant="outline"
                          data-testid={testId(`case-${index}-assertion-${ruleIndex}-remove`)}
                          onClick={() =>
                            updateCase(index, {
                              hardAssertions: item.hardAssertions!.filter(
                                (_, i) => i !== ruleIndex,
                              ),
                            })
                          }
                        >
                          {t("optimizationLab.editor.remove")}
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      data-testid={testId(`case-${index}-assertion-add`)}
                      disabled={(item.hardAssertions?.length ?? 0) >= 16}
                      onClick={() =>
                        updateCase(index, {
                          hardAssertions: [...(item.hardAssertions ?? []), newAssertion(item)],
                        })
                      }
                    >
                      {t("optimizationLab.editor.addAssertion")}
                    </Button>
                  </fieldset>
                </div>
              )}
            </details>
          ))}
          <Button
            type="button"
            variant="outline"
            data-testid={testId("case-add")}
            disabled={dataset.cases.length >= 200}
            onClick={() => {
              setExpandedCase(dataset.cases.length);
              emit({ ...dataset, cases: [...dataset.cases, createEditableCase(dataset)] });
            }}
          >
            {t("optimizationLab.editor.addCase")}
          </Button>
        </fieldset>
      )}
      {issues.length > 0 && (
        <ul className="space-y-1 text-sm" data-testid={testId("dataset-issues")}>
          {issues.map((issue, i) => (
            <li key={i} className={issue.level === "error" ? "text-destructive" : "text-amber-600"}>
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
