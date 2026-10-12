# Historical registry fixture

`registry-9fa1194e.ts.txt` contains the exact, unmodified bytes of
`packages/server/src/project-runtime/registry.ts` at CodeShell commit
`9fa1194ed5d07012f5137451e80317cb60415580`, Git blob
`c7f98c0debbf232e5ebd4bdbba72114a0d4b247a`.

SHA-256: `c74433a4907fb4e9bc72fd1b737676e427360c6cebfb29b3bf8dd164238024fd`.

The account adoption test verifies the hash, rewrites only the lock module import
to the current implementation, and executes this actual previous registry
algorithm against an adopted registry. This keeps the compatibility gate usable
in shallow checkouts without substituting a mock of the historical behavior.
Keep the snapshot bytes unchanged.
