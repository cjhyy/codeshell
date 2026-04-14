/**
 * Application state — session, cost, model, and feature state.
 *
 * Upgraded from no-op stubs to working implementations for the
 * functions that Code Shell's components and services actually call.
 * Functions used only by restored-src's deep internals (analytics
 * sinks, GrowthBook, etc.) remain lightweight stubs.
 */

// ─── Types ──────────────────────────────────────────────────────────

export type AttributedCounter = { add(value: number, attrs?: Record<string, string>): void };
export type ChannelEntry = { name: string; enabled: boolean };

// ─── Session / CWD ──────────────────────────────────────────────────

let _sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let _originalCwd = process.cwd();
let _projectRoot = process.cwd();
let _isNonInteractive = false;
let _sessionTrustAccepted = false;

export function getSessionId(): string { return _sessionId; }
export function switchSession(id: string): void { _sessionId = id; }
export function getOriginalCwd(): string { return _originalCwd; }
export function setOriginalCwd(cwd: string): void { _originalCwd = cwd; }
export function getProjectRoot(): string { return _projectRoot; }
export function setProjectRoot(root: string): void { _projectRoot = root; }
export function getCwdState(): { originalCwd: string; projectRoot: string } {
  return { originalCwd: _originalCwd, projectRoot: _projectRoot };
}
export function getIsInteractive(): boolean { return !_isNonInteractive; }
export function getIsNonInteractiveSession(): boolean { return _isNonInteractive; }
export function setIsNonInteractive(v: boolean): void { _isNonInteractive = v; }
export function getClientType(): string { return "cli"; }
export function getSessionTrustAccepted(): boolean { return _sessionTrustAccepted; }
export function setSessionTrustAccepted(v: boolean): void { _sessionTrustAccepted = v; }

// ─── Interaction tracking ───────────────────────────────────────────

let _lastInteractionTime = Date.now();
let _scrollDraining = false;

export function updateLastInteractionTime(): void { _lastInteractionTime = Date.now(); }
export function getLastInteractionTime(): number { return _lastInteractionTime; }
export function flushInteractionTime(): void { /* no telemetry sink */ }
export function markScrollActivity(): void { _scrollDraining = true; }
export function getIsScrollDraining(): boolean { return _scrollDraining; }
export function waitForScrollIdle(): Promise<void> {
  _scrollDraining = false;
  return Promise.resolve();
}

// ─── Model management ──────────────────────────────────────────────

let _modelOverride: string | null = null;
let _initialModel = "";
let _modelStrings: Record<string, string> = {};

export function getMainLoopModelOverride(): string | null { return _modelOverride; }
export function setMainLoopModelOverride(m: string | null): void { _modelOverride = m; }
export function getInitialMainLoopModel(): string { return _initialModel; }
export function setInitialMainLoopModel(m: string): void { _initialModel = m; }
export function setModelStrings(key: string, value: string): void { _modelStrings[key] = value; }
export function getModelStrings(key: string): string | undefined { return _modelStrings[key]; }

// ─── Token / cost tracking ──────────────────────────────────────────

let _totalInputTokens = 0;
let _totalOutputTokens = 0;
let _turnOutputTokens = 0;
let _turnOutputSnapshot = 0;
let _budgetContinuationCount = 0;
let _currentTurnBudget = Infinity;
let _hasUnknownModelCost = false;

// Per-model usage tracking
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requestCount: number;
}
const _modelUsage = new Map<string, ModelUsage>();

export function addToModelUsage(model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0): void {
  const existing = _modelUsage.get(model) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requestCount: 0 };
  existing.inputTokens += input;
  existing.outputTokens += output;
  existing.cacheReadTokens += cacheRead;
  existing.cacheWriteTokens += cacheWrite;
  existing.requestCount++;
  _modelUsage.set(model, existing);
}
export function getModelUsage(): Map<string, ModelUsage> { return _modelUsage; }

// API timing
let _totalAPIDurationMs = 0;
export function addAPIDuration(ms: number): void { _totalAPIDurationMs += ms; }
export function getTotalAPIDurationMs(): number { return _totalAPIDurationMs; }

// Code line changes
let _linesAdded = 0;
let _linesRemoved = 0;
export function addLinesChanged(added: number, removed: number): void { _linesAdded += added; _linesRemoved += removed; }
export function getLinesAdded(): number { return _linesAdded; }
export function getLinesRemoved(): number { return _linesRemoved; }

interface CostState {
  totalInputTokens: number;
  totalOutputTokens: number;
}

export function getTotalInputTokens(): number { return _totalInputTokens; }
export function getTotalOutputTokens(): number { return _totalOutputTokens; }
export function addInputTokens(n: number): void { _totalInputTokens += n; }
export function addOutputTokens(n: number): void { _totalOutputTokens += n; _turnOutputTokens += n; }
export function getCurrentTurnTokenBudget(): number { return _currentTurnBudget; }
export function setCurrentTurnTokenBudget(n: number): void { _currentTurnBudget = n; }
export function getTurnOutputTokens(): number { return _turnOutputTokens - _turnOutputSnapshot; }
export function getBudgetContinuationCount(): number { return _budgetContinuationCount; }
export function incrementBudgetContinuation(): void { _budgetContinuationCount++; }
export function snapshotOutputTokensForTurn(): void { _turnOutputSnapshot = _turnOutputTokens; }
export function setHasUnknownModelCost(v = true): void { _hasUnknownModelCost = v; }
export function getHasUnknownModelCost(): boolean { return _hasUnknownModelCost; }

export function resetCostState(): void {
  _totalInputTokens = 0;
  _totalOutputTokens = 0;
  _turnOutputTokens = 0;
  _turnOutputSnapshot = 0;
  _budgetContinuationCount = 0;
  _currentTurnBudget = Infinity;
  _hasUnknownModelCost = false;
}

export function setCostStateForRestore(state: unknown): void {
  if (state && typeof state === "object") {
    const s = state as Partial<CostState>;
    if (typeof s.totalInputTokens === "number") _totalInputTokens = s.totalInputTokens;
    if (typeof s.totalOutputTokens === "number") _totalOutputTokens = s.totalOutputTokens;
  }
}

// ─── Turn duration tracking ─────────────────────────────────────────

let _turnHookDurationMs = 0;
let _turnHookCount = 0;
let _turnToolDurationMs = 0;
let _turnToolCount = 0;
let _turnClassifierDurationMs = 0;
let _turnClassifierCount = 0;

export function getTurnHookDurationMs(): number { return _turnHookDurationMs; }
export function getTurnHookCount(): number { return _turnHookCount; }
export function addTurnHookDuration(ms: number): void { _turnHookDurationMs += ms; _turnHookCount++; }
export function resetTurnHookDuration(): void { _turnHookDurationMs = 0; _turnHookCount = 0; }

export function getTurnToolDurationMs(): number { return _turnToolDurationMs; }
export function getTurnToolCount(): number { return _turnToolCount; }
export function addTurnToolDuration(ms: number): void { _turnToolDurationMs += ms; _turnToolCount++; }
export function resetTurnToolDuration(): void { _turnToolDurationMs = 0; _turnToolCount = 0; }

export function getTurnClassifierDurationMs(): number { return _turnClassifierDurationMs; }
export function getTurnClassifierCount(): number { return _turnClassifierCount; }
export function addTurnClassifierDuration(ms: number): void { _turnClassifierDurationMs += ms; _turnClassifierCount++; }
export function resetTurnClassifierDuration(): void { _turnClassifierDurationMs = 0; _turnClassifierCount = 0; }

// ─── Telemetry counters ─────────────────────────────────────────────

const noopCounter: AttributedCounter = { add() {} };
export function getSessionCounter(): AttributedCounter { return noopCounter; }
export function getLocCounter(): AttributedCounter { return noopCounter; }
export function getPrCounter(): AttributedCounter { return noopCounter; }
export function getCommitCounter(): AttributedCounter { return noopCounter; }
export function getCodeEditToolDecisionCounter(): AttributedCounter { return noopCounter; }
export function getActiveTimeCounter(): AttributedCounter { return noopCounter; }
export function setMeter(_meter: unknown): void { /* no OTel meter */ }
export function getEventLogger(): { emit(_name: string, _body?: unknown): void } {
  return { emit() {} };
}

// ─── Feature flags / config ─────────────────────────────────────────

let _isRemoteMode = false;
let _kairosActive = false;
let _userMsgOptIn = false;
let _sdkBetas: string[] = [];

export function getKairosActive(): boolean { return _kairosActive; }
export function setKairosActive(v: boolean): void { _kairosActive = v; }
export function getUserMsgOptIn(): boolean { return _userMsgOptIn; }
export function setUserMsgOptIn(v: boolean): void { _userMsgOptIn = v; }
export function getSdkBetas(): string[] { return _sdkBetas; }
export function setSdkBetas(betas: string[]): void { _sdkBetas = betas; }
export function getSdkAgentProgressSummariesEnabled(): boolean { return false; }
export function getIsRemoteMode(): boolean { return _isRemoteMode; }
export function setIsRemoteMode(v: boolean): void { _isRemoteMode = v; }
export function getDirectConnectServerUrl(): string | null { return null; }
export function getMainThreadAgentType(): string { return "main"; }
export function getHasDevChannels(): boolean { return false; }
export function getStrictToolResultPairing(): boolean { return true; }
export function getQuestionPreviewFormat(): string { return "text"; }
export function getUseCoworkPlugins(): boolean { return false; }
export function setUseCoworkPlugins(_v: boolean): void { /* no-op */ }

// ─── Slow operations ────────────────────────────────────────────────

const _slowOps: string[] = [];
export function addSlowOperation(op: string): void { _slowOps.push(op); }
export function getSlowOperations(): string[] { return _slowOps; }

// ─── Hooks / registered callbacks ───────────────────────────────────

const _hooks: Record<string, unknown[]> = {};
export function registerHookCallbacks(name: string, cbs: unknown): void {
  if (!_hooks[name]) _hooks[name] = [];
  _hooks[name].push(cbs);
}
export function getRegisteredHooks(): Record<string, unknown[]> { return _hooks; }

// ─── Plan mode ──────────────────────────────────────────────────────

let _hasExitedPlanMode = false;
let _needsPlanModeExitAttachment = false;
let _needsAutoModeExitAttachment = false;

export function handlePlanModeTransition(): void { /* no-op */ }
export function setHasExitedPlanMode(v: boolean): void { _hasExitedPlanMode = v; }
export function getHasExitedPlanMode(): boolean { return _hasExitedPlanMode; }
export function setNeedsPlanModeExitAttachment(v: boolean): void { _needsPlanModeExitAttachment = v; }
export function getNeedsPlanModeExitAttachment(): boolean { return _needsPlanModeExitAttachment; }
export function setNeedsAutoModeExitAttachment(v: boolean): void { _needsAutoModeExitAttachment = v; }
export function getNeedsAutoModeExitAttachment(): boolean { return _needsAutoModeExitAttachment; }

// ─── System prompt cache ────────────────────────────────────────────

const sectionCache = new Map<string, string | null>();
export function getSystemPromptSectionCache(): Map<string, string | null> { return sectionCache; }
export function setSystemPromptSectionCacheEntry(name: string, value: string | null): void { sectionCache.set(name, value); }
export function clearSystemPromptSectionState(): void { sectionCache.clear(); }
export function clearBetaHeaderLatches(): void { /* no-op */ }

// ─── Skills / Plugins ───────────────────────────────────────────────

const _invokedSkills = new Map<string, Set<string>>();
const _inlinePlugins: unknown[] = [];

export function addInvokedSkill(name: string, agentId?: string): void {
  const key = agentId ?? "__main__";
  if (!_invokedSkills.has(key)) _invokedSkills.set(key, new Set());
  _invokedSkills.get(key)!.add(name);
}
export function getInvokedSkillsForAgent(agentId?: string): string[] {
  return [...(_invokedSkills.get(agentId ?? "__main__") ?? [])];
}
export function clearInvokedSkillsForAgent(agentId?: string): void {
  _invokedSkills.delete(agentId ?? "__main__");
}
export function getInlinePlugins(): unknown[] { return _inlinePlugins; }

// ─── Prompt / request tracking ──────────────────────────────────────

let _promptId = "";
let _lastAPIRequest: unknown = null;

export function getPromptId(): string { return _promptId; }
export function setPromptId(id: string): void { _promptId = id; }
export function getLastAPIRequest(): unknown { return _lastAPIRequest; }
export function setLastAPIRequest(req: unknown): void { _lastAPIRequest = req; }

// ─── Misc state ─────────────────────────────────────────────────────

let _postCompactionDone = false;
let _replBridgeActive = false;
let _sessionPersistenceDisabled = false;
let _scheduledTasksEnabled = false;
let _lspRecommendationShown = false;
const _agentColorMap = new Map<string, string>();
const _planSlugCache = new Map<string, string>();
const _allowedChannels: string[] = [];
let _allowedSettingSources = ["user", "project", "local"];
let _additionalClaudeMdDirs: string[] = [];

export function markPostCompaction(): void { _postCompactionDone = true; }
export function getPostCompactionDone(): boolean { return _postCompactionDone; }
export function isReplBridgeActive(): boolean { return _replBridgeActive; }
export function setReplBridgeActive(v: boolean): void { _replBridgeActive = v; }
export function isSessionPersistenceDisabled(): boolean { return _sessionPersistenceDisabled; }
export function setSessionPersistenceDisabled(v: boolean): void { _sessionPersistenceDisabled = v; }
export function resetSdkInitState(): void { /* no-op */ }
export function getAgentColorMap(): Map<string, string> { return _agentColorMap; }
export function getPlanSlugCache(): Map<string, string> { return _planSlugCache; }
export function getAllowedChannels(): string[] { return _allowedChannels; }
export function getAllowedSettingSources(): string[] { return _allowedSettingSources; }
export function setAllowedSettingSources(sources: string[]): void { _allowedSettingSources = sources; }
export function getAdditionalDirectoriesForClaudeMd(): string[] { return _additionalClaudeMdDirs; }
export function setAdditionalDirectoriesForClaudeMd(dirs: string[]): void { _additionalClaudeMdDirs = dirs; }
export function setTeleportedSessionInfo(_info: unknown): void { /* no-op */ }
export function setScheduledTasksEnabled(v: boolean): void { _scheduledTasksEnabled = v; }
export function getScheduledTasksEnabled(): boolean { return _scheduledTasksEnabled; }
export function getSessionCreatedTeams(): string[] { return []; }
export function hasShownLspRecommendationThisSession(): boolean { return _lspRecommendationShown; }
export function setLspRecommendationShownThisSession(v: boolean): void { _lspRecommendationShown = v; }

// ─── Auth (stubs — no FD-based auth in Code Shell) ─────────────────

export function setApiKeyFromFd(..._args: any[]): any { return undefined as any; }
export function getApiKeyFromFd(..._args: any[]): any { return undefined as any; }
export function getOauthTokenFromFd(..._args: any[]): any { return undefined as any; }
export function setOauthTokenFromFd(..._args: any[]): any { return undefined as any; }
export function preferThirdPartyAuthentication(..._args: any[]): any { return false as any; }
export function getParentSessionId(..._args: any[]): any { return undefined as any; }
export function getFlagSettingsInline(..._args: any[]): any { return undefined as any; }
export function getFlagSettingsPath(..._args: any[]): any { return undefined as any; }
