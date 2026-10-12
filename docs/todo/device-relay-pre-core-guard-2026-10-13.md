# DeviceRelay acceptance pre-Core protection checkpoint

This change prepares the cross-repository candidate gate. It does not record a new
full DeviceRelay consumer, Docker, physical-phone or deployment acceptance.

The installed Services entry previously statically imported Server/Core through its
device-relay, clients, auth-shutdown and recovery modules. It also fell back to real
DNS for unknown hosts. The Host wrapper inherited operator HOME, provider/proxy and
Node-option environment and deleted scratch data after failed or interrupted runs.

The paired Services task branch `codex/services/device-relay-pre-core-guard-20261013`
now validates a fresh private HOME, prepares only its fixed system-OpenSSL CA commands,
installs and awaits transport/DNS/process refusal probes, then dynamically imports all
product and indirect Core consumers. Ordered one-shot listener grants bind only
`127.0.0.1`. Actual listening ports authorize HTTP/HTTPS destinations. Only
`directory.test` and strict UUID device names resolve locally. Real TLS CA, SNI and
hostname verification remain enabled; WSS uses the guarded native connector.

The Host child receives only its private HOME/config/cache/data/state/TMP paths,
fixed system PATH/locale and HOME hash. The wrapper still requires every original
business/recovery assertion and now additionally checks the exact guard receipt:
12 transport/process probes, 10 DNS probes, seven listener lifetimes, and zero open
listeners/connections. Captured child `close`, exit 0 and all business/cleanup/guard
proofs must pass before private data is removed or PASS is printed. Any missing proof,
failure or interruption preserves the root and reports its private path.

Validation in the independent task worktrees:

- Services: Node v25.8.1, four isolated child tests passed. These exercise actual
  HTTP listener lifetime, private-CA HTTPS and WSS echo, wrong CA and wrong hostname
  rejection, rejected unknown DNS/resolvers/transports/Worker/process entry points,
  and rejection of caller-provided WSS connectors (the function is never invoked).
- Host: guarded `tests/device-relay-wrapper.test.ts`, 26 tests / 61 assertions,
  zero failures or skips. Synthetic installed entries verify child environment,
  mandatory guard proof, every existing receipt condition, failure preservation and
  cooperative interruption. These entries do not substitute for actual product
  acceptance. Their private fixtures are removed only after the captured wrapper
  termination; timeout without that proof retains the fixture.
- Targeted Prettier, `node --check` and `git diff --check` passed. No Core/Main,
  browser, Docker, paid provider or operator credential store was started.

This process-local test guard is not OS confinement. The full original 15-stage
Services consumer must run after both task commits are integrated with the exact
candidate tarballs. No shutdown claim is made for an unknown descendant after a
forced kill; failed/incomplete runs retain HOME instead.
