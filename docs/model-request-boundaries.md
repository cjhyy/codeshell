# Model request evidence

Main-agent model invocations have a UUID `logicalCallId`, also used by the model
diagnostic recorder. Each call of the SDK's configured fetch has its own
`physicalAttemptId`; SDK retries can therefore produce several attempt events
under one logical boundary. A streaming fallback is a new logical invocation.
Retries hidden inside a custom fetch implementation are outside this observation
point.

The provider adapter captures its request after message/image/tool conversion,
prompt-cache layout, reasoning translation, and parameter selection. Immediately
before the underlying fetch, the guard parses the actual JSON body and checks it
against that snapshot. It validates the provider model and Session identity,
obtains Host signatures, then durably writes `model_request_boundary` and
`model_request_attempt`. A custody, projection, identity, or audit-write failure
aborts before fetch and prevents SDK retries and streaming fallback. Attempt
anchors mean validated handoff to fetch; they do not prove remote receipt or a
charge.

Evidence covers the canonical JSON request body, not HTTP headers or credentials.
`systemPromptDigest`, `messageDigest`, and `wireDigest` are domain-separated keyed
HMACs. `sourceContextDigest` separately signs Transcript-derived Core context;
`sourceEventRange` identifies its durable source. Transient hook context, image
pruning, and other run transformations are covered by the actual provider
projection, and are not falsely described as reconstructible from source event
IDs. Public composition and projected tool catalog use normalized unkeyed digests.
No prompt, image data, tool arguments, transient private prehash, or key is added
to these audit events. The ordinary transcript still retains its existing message
history. Full model diagnostics require the separate explicit content opt-in in
[model-request-diagnostics.md](model-request-diagnostics.md).

Durable Session keys are bound to storage scope, SID, and accounting Session
incarnation. They are stored separately from transcripts and never rotate merely
because a file is corrupt, unreadable, or encrypted by an unavailable authority.
Node/TUI Hosts explicitly use `PlaintextCipher` in an owner-only `0700` directory
with `0600` files: this is plaintext custody, not encryption. SDK Hosts may supply
their own `modelRequestSigner`. Desktop Main owns the key behind its OS encryption
provider, refuses an unavailable or plaintext backend, and signs transient
prehashes over private worker IPC. Renderer and model RPC surfaces cannot retrieve
keys or use the signing service.

Ephemeral sessions use Host-memory keys and memory-only events. Desktop requires
an active native Quick Chat owner, pins the first signing incarnation to the
current worker generation, and wipes ephemeral keys when that generation ends.
This evidence intentionally has no verification promise across restart.

Metadata-only transcripts can establish call/attempt ordering and composition/tool
versions. Rechecking private HMACs requires the authorized Host and the original
projection (for example an explicitly enabled private diagnostic capture); digest
values alone cannot reconstruct a request. Restoring a durable Session on the
same custody authority preserves its key identity and permits that verification.

Validation uses `bun test packages/core/src/model-request-boundary` and
`bun test packages/desktop/src/main/model-request-signing-service.test.ts`. After
`bun run test:package-release` completes, run
`node scripts/smoke-model-request-boundaries.mjs` for compiled SDK, actual stdio
worker, and TUI consumers. CI runs the same consumer script. Every model fixture
uses a fresh HOME, an exact localhost origin guard installed before Core loads,
and checks the actual child/worker bootstrap receipt. Redirects and inherited
proxies are disabled.

The consumer checks OpenAI transparent retry, Anthropic streaming, image
conversion, a real read-only tool roundtrip, queued steering, runtime hook
injection, tool visibility and composition changes, archived history and resumed
Session keys, worker restart/client-message replay, and Host-encrypted worker
signing. Independently recomputed keyed digests are compared with the JSON bodies
received by the local server. Real production Transcript writer faults at both
the logical boundary and physical attempt append, and a custody failure, produce
zero server requests and no fallback. Not-sent accounting receipts carry known
zero usage/cost rather than unknown billed usage. The Desktop service tests use a
fixture encrypted cipher and explicitly exercise unavailable encryption; they do
not claim a headless test exercised an OS keychain.
