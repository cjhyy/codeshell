# Device relay acceptance in a private deployment candidate

`scripts/smoke-services-cloud-entry.mjs` runs the Services-owned native TLS/WSS
acceptance after relocating and independently installing its actual Host tarballs,
before building/exporting Docker images. It writes `device-relay-candidate.json`
with the exact Host/Services revisions and five package checksums. The Services
fixture verifies those tarballs against npm's installed integrity records; no
workspace source or development `dist` fallback is accepted.

The matching Services revision must include the v1 fixture and the matching Host
must expose `/auth` and `/remote-relay`. Old published dependencies are not a
passing substitute. The fixture requires Node 22.16+ and `openssl`; it creates a
private, locally trusted CA and only binds test listeners to loopback. It does not
disable certificate/hostname verification or change system DNS.

The Host wrapper independently requires all 14 network/authorization stages,
including an actual production file download interrupted by phone revocation,
another phone's download continuing, single-use tickets, obsolete connections,
restart/offline behavior, and a committed POST not replayed after connection loss.
It also requires matching source/manifest identity, a successful overall result
and successful cleanup. A zero exit status, a partial report, or a receipt from a
previous run is insufficient. Failed evidence is preserved separately.
The installed-candidate script uses a unique receipt filename for each invocation
under `evidence/device-relay-acceptance-*.json`, so a retry preserves earlier
successes and failures. Setup and login must also demonstrate that real password
hashing/persistence finishes before shutdown releases the directory lock.

To recheck an existing installed candidate with a fresh evidence destination:

```sh
node scripts/smoke-device-relay.mjs \
  /path/to/installed-candidate \
  /path/to/installed-candidate/device-relay-candidate.json \
  /path/to/new/device-relay-acceptance.json
```

The wrapper gives the child a new private temporary directory for certificates,
credentials and fixture data. It waits for process exit, then removes that
directory, including after interruption or failure. A four-minute deadline sends
SIGTERM, followed by SIGKILL after ten seconds if necessary. A forced exit or
signal may produce no receipt; that is a failed acceptance, never successful
cleanup evidence. Process tests cover missing/stale/partial/mismatched evidence,
failure cleanup and interrupted children that incorrectly exit zero. Those tests
validate the gate; they do not replace the real TLS fixture.

This is a private compatibility candidate. It does not establish that packages or
images were publicly released, production DNS/TLS was configured, a target server
was deployed, or physical phones/Electron settings were verified. Panel business
packages and internal interfaces are unchanged by this gate.
