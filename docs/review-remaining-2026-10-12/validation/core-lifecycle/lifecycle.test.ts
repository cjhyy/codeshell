import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const network = await import('/tmp/codeshell-remaining-core-lifecycle/deny-network.mjs');
const root = '/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell';
const dirs: string[] = [];
const managers: any[] = [];
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'cs-lifecycle-review-')); dirs.push(dir); return dir; };
const sent: Array<{ prompt: string, options: unknown }> = [];
// This fixture exercises the actual EngineRunner control flow while replacing
// only Engine construction/protocol transport. It does not execute a real Engine.
mock.module(root + '/packages/core/src/engine/engine.ts', () => ({ Engine: class { registerCustomTool() {} } }));
mock.module(root + '/packages/core/src/protocol/helpers.ts', () => ({ createInProcessClient: () => ({
  client: { run: async (prompt: string, options: unknown) => { sent.push({ prompt, options }); return { text: 'done', reason: 'completed', sessionId: 'restored-session', turnCount: 1 }; }, cancel: async () => {} }, close: async () => {},
}) }));
const { RunManager } = await import(root + '/packages/core/src/run/RunManager.ts');
const { FileRunStore } = await import(root + '/packages/core/src/run/FileRunStore.ts');
const { CompositeEvaluator } = await import(root + '/packages/core/src/run/Evaluator.ts');
const { MemoryManager } = await import(root + '/packages/core/src/session/memory.ts');
const { MemoryOrchestrator } = await import(root + '/packages/core/src/services/memory-orchestrator.ts');
const { recordSession, sessionsSinceLastDream } = await import(root + '/packages/core/src/services/auto-dream.ts');
const { OperationLedger } = await import(root + '/packages/core/src/operations/ledger.ts');
const { OperationController } = await import(root + '/packages/core/src/operations/controller.ts');
const { PlaintextCipher } = await import(root + '/packages/core/src/credentials/cipher.ts');
const { LifetimeScope } = await import(root + '/packages/core/src/composition/lifetime.ts');
const { createPrivateServices } = await import(root + '/packages/core/src/composition/activation.ts');
const waitFor = async (fn: () => Promise<boolean>) => { const until = Date.now() + 3000; while (!(await fn())) { if (Date.now() >= until) throw new Error('fixture timeout'); await new Promise(r => setTimeout(r, 2)); } };
const handle = () => ({ resolveApproval: () => false, resolveInput: () => false, hasPendingApproval: () => false, hasPendingInput: () => false });
const snapshot = (runId: string, cwd: string) => ({ runId, objective: 'Original objective: prepare the report', preset: 'general', cwd, status: 'waiting_input', createdAt: Date.now(), updatedAt: Date.now(), startedAt: Date.now(), finishedAt: null, parentRunId: null, sessionId: 'restored-session', childSessionIds: [], attemptCount: 1, latestCheckpointId: null, latestApprovalId: null, summary: null, error: null, tags: [], metadata: {} });
afterEach(async () => { for (const manager of managers.splice(0)) await manager.shutdown(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); sent.length = 0; });
afterAll(() => { console.log('network guard receipt', JSON.stringify(network.stats())); expect(network.stats().denied).toBe(0); network.restore(); mock.restore(); });

test('cold waiting_input resume persists answer as event but actual EngineRunner resends original objective', async () => {
  const dir = tmp(); const store = new FileRunStore(dir); const run = snapshot('cold-input-run', dir); await store.create(run as any);
  const manager = new RunManager({ store, runsDir: dir, executor: { llm: { provider: 'openai', model: 'fixture', apiKey: 'fixture' } } }); managers.push(manager);
  await manager.resume(run.runId, { userInput: 'Use region EU and currency EUR' });
  await waitFor(async () => (await store.get(run.runId))?.status === 'completed');
  expect(sent).toHaveLength(1);
  expect(sent[0].prompt).toBe(run.objective);
  expect(sent[0].prompt).not.toContain('currency EUR');
  expect(sent[0].options).toEqual({ cwd: dir, sessionId: 'restored-session' });
  const events = await store.listEvents(run.runId);
  expect(events.find((e: any) => e.type === 'run_resumed')?.data.userInput).toBe('Use region EU and currency EUR');
  expect((await store.get(run.runId))?.status).toBe('completed');
  console.log('cold input receipt', JSON.stringify({ sent, resumed: events.filter((e: any) => e.type === 'run_resumed') }));
});

test('warm waiting_input resume delivers exact answer to the suspended handle', async () => {
  const dir = tmp(); const store = new FileRunStore(dir); let received = ''; let unblock!: (answer: string) => void;
  const executor = { async execute(_run: any, _ctx: any, hooks: any, onHandleReady: any) {
    const suspended = new Promise<string>(r => { unblock = r; });
    onHandleReady({ ...handle(), hasPendingInput: () => true, resolveInput: (answer: string) => { received = answer; unblock(answer); return true; } });
    await hooks.onInputNeeded('Which region/currency?'); await suspended;
    return { result: { text: 'done', reason: 'completed', sessionId: 'warm-session', turnCount: 1 }, handle: handle() };
  } };
  const manager = new RunManager({ store, runsDir: dir, executor }); managers.push(manager);
  const run = await manager.submit({ objective: 'Original objective', cwd: dir });
  await waitFor(async () => (await store.get(run.runId))?.status === 'waiting_input');
  await manager.resume(run.runId, { userInput: 'Use region EU and currency EUR' });
  await waitFor(async () => (await store.get(run.runId))?.status === 'completed');
  expect(received).toBe('Use region EU and currency EUR');
  expect(sent).toHaveLength(0);
});

for (const verdict of ['passed', 'warning', 'failed'] as const) test(`RunManager evaluator ${verdict} maps to ${verdict === 'passed' ? 'completed' : 'failed'}`, async () => {
  const dir = tmp(); const store = new FileRunStore(dir);
  const evaluator = new CompositeEvaluator([{ name: 'advisory', evaluate: async () => ({ verdict, findings: [verdict + ' finding'] }) }]);
  expect((await evaluator.evaluate({} as any)).verdict).toBe(verdict);
  const manager = new RunManager({ store, runsDir: dir, evaluator, executor: { async execute() { return { result: { text: 'successful result', reason: 'completed', sessionId: 'evaluator-session', turnCount: 1 }, handle: handle() }; } } }); managers.push(manager);
  const run = await manager.submit({ objective: 'Complete the task', cwd: dir });
  await waitFor(async () => ['completed', 'failed'].includes((await store.get(run.runId))?.status ?? ''));
  const final = await store.get(run.runId); const cp = await store.getLatestCheckpoint(run.runId);
  expect(final?.status).toBe(verdict === 'passed' ? 'completed' : 'failed');
  expect(cp?.evaluator?.status).toBe(verdict === 'passed' ? 'passed' : 'failed');
  if (verdict === 'warning') expect(final?.error).toBe('Evaluator failed: [advisory] warning finding');
  console.log('evaluator receipt', JSON.stringify({ verdict, status: final?.status, error: final?.error }));
});

function dreamSetup() { const baseDir = tmp(); const projectDir = tmp(); const mm = new MemoryManager({ baseDir, projectDir }); mm.save({ type: 'user', name: 'style', description: 'Stable preference', content: 'Use concise reports', origin: 'manual' }); for (let n = 0; n < 5; n++) recordSession(baseDir); return { baseDir, projectDir, mm }; }

test('overlapping auto-dream runs consume the same cadence twice and lose a session finishing mid-dream', async () => {
  const { baseDir, projectDir } = dreamSetup(); const releases: Array<(value: boolean) => void> = []; const captured: number[] = [];
  const create = () => new MemoryOrchestrator({ baseDir, projectDir, autoExtract: false, callLLM: async () => { throw new Error('unexpected LLM call'); }, runDream: async () => { captured.push(sessionsSinceLastDream(baseDir)); return await new Promise<boolean>(r => releases.push(r)); } });
  const first = create().run([], 'dream-first'); const second = create().run([], 'dream-second');
  await waitFor(async () => releases.length === 2);
  expect(captured).toEqual([6, 7]);
  recordSession(baseDir); expect(sessionsSinceLastDream(baseDir)).toBe(8);
  releases[0](true); expect((await first).dreamTriggered).toBe(true); expect(sessionsSinceLastDream(baseDir)).toBe(2);
  releases[1](true); expect((await second).dreamTriggered).toBe(true); expect(sessionsSinceLastDream(baseDir)).toBe(0);
  console.log('overlap dream receipt', JSON.stringify({ captured, afterFirst: 2, afterSecond: sessionsSinceLastDream(baseDir), unconsumedMidflightSessions: 1 }));
});

test('single auto-dream run preserves a session finishing mid-dream', async () => {
  const { baseDir, projectDir } = dreamSetup(); let release!: (value: boolean) => void; let started = false;
  const orchestrator = new MemoryOrchestrator({ baseDir, projectDir, autoExtract: false, callLLM: async () => { throw new Error('unexpected LLM call'); }, runDream: async () => { started = true; return await new Promise<boolean>(r => { release = r; }); } });
  const running = orchestrator.run([], 'dream-single'); await waitFor(async () => started);
  expect(sessionsSinceLastDream(baseDir)).toBe(6); recordSession(baseDir); release(true);
  expect((await running).dreamTriggered).toBe(true); expect(sessionsSinceLastDream(baseDir)).toBe(1);
});

const plan = { sessionId: 'review-session', intentId: 'review-intent', service: 'fixture', action: 'create', channel: 'fixture', account: 'fixture', target: 'fixture', parameters: { data: 1 }, postcondition: { data: 1 } };
const adapter = (execute: any) => ({ assertAuthorized() {}, preflight: async () => {}, validate: async () => {}, authorize: async () => true, execute, verify: async () => true });

test('operation verified replay and lost-response cold replay do not send twice', async () => {
  for (const failed of [false, true]) { const dir = tmp(); let sends = 0; const execute = async () => { sends++; if (failed) throw new Error('lost response'); return { id: 'created-1' }; };
    const first = await new OperationController(new OperationLedger(dir, new PlaintextCipher())).run(plan, adapter(execute));
    const cold = await new OperationController(new OperationLedger(dir, new PlaintextCipher())).run(plan, adapter(execute));
    expect(first.state).toBe(failed ? 'unknown' : 'verified'); expect(cold.state).toBe(first.state); expect(sends).toBe(1);
  }
});

test('private service cancellation disposes both acquired and late resources exactly once', async () => {
  const scope = new LifetimeScope('session', 'fixture'); const ac = new AbortController(); const values: Record<string, unknown> = {}; const disposed: string[] = []; let resolveLate!: (value: string) => void;
  const contributions = [{ moduleId: 'first', key: 'first', value: { scope: 'session', create: () => 'first-resource', dispose: (value: string) => { disposed.push(value); } } }, { moduleId: 'late', key: 'late', value: { scope: 'session', create: () => new Promise<string>(r => { resolveLate = r; }), dispose: (value: string) => { disposed.push(value); } } }];
  const activating = createPrivateServices(contributions as any, 'session', scope, {} as any, values, ac.signal);
  expect(values.first).toBe('first-resource'); ac.abort(new Error('cancelled fixture')); resolveLate('late-resource');
  await expect(activating).rejects.toThrow('Private service activation failed'); await scope.dispose();
  expect(values).toEqual({}); expect(disposed.sort()).toEqual(['first-resource', 'late-resource']);
});

test('production AuxiliaryPipeline concurrently schedules two dreams against one cadence root', async () => {
  const { AuxiliaryPipeline } = await import(root + '/packages/core/src/engine/auxiliary-pipeline.ts');
  const { Transcript } = await import(root + '/packages/core/src/session/transcript.ts');
  const { baseDir, projectDir } = dreamSetup(); const previous = process.env.CODE_SHELL_HOME; process.env.CODE_SHELL_HOME = baseDir;
  const releases: Array<(value: any) => void> = []; const captured: number[] = []; let summaryCalls = 0;
  const llm = { createMessage: async (params: any) => {
    if (!params.tools.length) { summaryCalls++; return { text: JSON.stringify({ summary: 'fixture summary', keyTopics: ['review'], decisions: [] }), toolCalls: [] }; }
    captured.push(sessionsSinceLastDream(baseDir));
    return await new Promise<any>(r => releases.push(r));
  } };
  const registry = { getTool: (name: string) => ({ name, description: name, inputSchema: {} }) };
  const deps = { config: () => ({ llm: { provider: 'fixture', model: 'fixture' } }), settings: () => ({ get: () => ({ memories: { autoExtract: false } }), invalidate() {} }), modelPool: () => ({}), toolRegistry: () => registry, toolContext: () => ({ cwd: projectDir, memoryBaseDir: baseDir }) };
  const transcript = Transcript.inMemory('dream-production');
  for (let i = 0; i < 8; i++) transcript.append('message', { role: i % 2 === 0 ? 'user' : 'assistant', content: 'Normal fixture message ' + i });
  try {
    const first = new AuxiliaryPipeline(deps as any).runMemoryPipeline(transcript, 'prod-dream-first', projectDir, llm as any);
    const second = new AuxiliaryPipeline(deps as any).runMemoryPipeline(transcript, 'prod-dream-second', projectDir, llm as any);
    await waitFor(async () => releases.length === 2);
    expect(summaryCalls).toBe(2); expect(captured).toEqual([6, 7]); recordSession(baseDir); expect(sessionsSinceLastDream(baseDir)).toBe(8);
    releases[0]({ text: 'Consolidated fixture', toolCalls: [] }); await first;
    expect(sessionsSinceLastDream(baseDir)).toBe(2);
    releases[1]({ text: 'Consolidated fixture', toolCalls: [] }); await second;
    expect(sessionsSinceLastDream(baseDir)).toBe(0);
    console.log('production auxiliary receipt', JSON.stringify({ summaryCalls, captured, afterBoth: sessionsSinceLastDream(baseDir), inMemoryLLM: true }));
  } finally { if (previous === undefined) delete process.env.CODE_SHELL_HOME; else process.env.CODE_SHELL_HOME = previous; }
});

test('pure document parsing/search and collection version refresh preserve ordinary content', async () => {
  const { writeFileSync } = await import('node:fs');
  const { parseDocument } = await import(root + '/packages/core/src/sources/documents/parse.ts');
  const { searchDocumentIndexes, documentIndexText } = await import(root + '/packages/core/src/sources/documents/index-store.ts');
  const { captureCollectionLocalFile, readCollectionLocalFile } = await import(root + '/packages/core/src/sources/collection-local.ts');
  const text = '项目预算 budget 42\n'; const parsed = await parseDocument(Buffer.from(text), 'notes.txt');
  expect(parsed.format).toBe('text'); expect(parsed.parts[0].text).toBe(text);
  const index = { version: '1', resourceId: 'notes', sourceHash: 'a'.repeat(64), inputBytes: Buffer.byteLength(text), format: 'text', truncated: false, chunks: [{ id: 'c1', part: 'document', partIndex: 0, start: 0, end: text.length, text }] };
  expect(documentIndexText(index as any)).toBe(text); expect(searchDocumentIndexes([index] as any, '预算', 5).matches).toHaveLength(1);
  const dir = tmp(); const file = join(dir, 'notes.txt'); writeFileSync(file, text); const first = captureCollectionLocalFile(file, 'notes');
  expect(Buffer.from(readCollectionLocalFile(first)).toString()).toBe(text);
  writeFileSync(file, '项目预算 budget 43\n'); expect(() => readCollectionLocalFile(first)).toThrow('changed');
  const refreshed = captureCollectionLocalFile(file, 'notes'); expect(Buffer.from(readCollectionLocalFile(refreshed)).toString()).toBe('项目预算 budget 43\n');
});
