# Shared workspace pilot

For the subsequent native interface/executor integration, see [NATIVE.md](NATIVE.md). This document describes the original standalone prototype.

An isolated, executable access-control pilot using the real Rakazo PostgreSQL schema. One shared workspace/agent, separate private workspaces, two member identities and one outsider. The HTTP/browser harness uses synthetic sessions and a deterministic offline agent. **It is not the native Rakazo UI, Better Auth login, or production executor integration.** It proves the proposed policy and data boundary, not those unconnected surfaces.

No production environment files, user records, personal credentials, Honcho data or ORB rows are copied. Database connections are rejected unless they use the dedicated loopback port and database name. The runtime has a separate non-superuser/non-BYPASSRLS role. The owner connection is used only for test schema and fixtures. The API listens only on loopback. Never publish this synthetic login harness on a public hostname.

## Run

Requirements: Docker, Node 22+, pinned root workspace dependencies (`pnpm install --frozen-lockfile`).

```sh
bash apps/shared-workspace-pilot/setup.sh
cd apps/shared-workspace-pilot
source env.sh
npm start
```

The seed writes temporary session tokens to ignored `.local/sessions.json`, mode 0600, expiring in 24 hours. Open `http://127.0.0.1:15440/#TOKEN` in separate browser profiles, using the token whose identity is `pilot-owner`, `pilot-member` or `pilot-outsider`. The owner and member represent the two collaborators; these are not their real accounts. The URL fragment is removed immediately. Do not paste tokens into shared documentation. A private SSH tunnel is needed when reviewing from a different machine.

The owner can remove the member in Team workspace. Both accounts keep their own private workspace. Removal prevents subsequent reads/sends, closes the member's open stream, and cancels queued work. Existing shared conversation history stays available to remaining members. Previously downloaded or read information cannot be recalled.

`npm test` runs real PostgreSQL/HTTP tests. With a freshly seeded server running, `npm run test:browser` uses three isolated Chromium contexts and writes ignored screenshots. Reseeding is destructive only to synthetic fixtures and rotates local session tokens; restart the pilot server after reseeding. Do not run browser tests concurrently with fixture-resetting API tests.

## Policy and boundaries

- `access.mjs` centralises authorisation. Sessions supply actor IDs; request bodies cannot set them.
- Discover only explicit space memberships across organisations.
- Shared agent access is opt-in in `shared_pilot.resources`; private agents remain owner-only.
- Actual requester, membership generation and approved execution principal are distinct.
- Test execution is bound to `offline-test-agent`. There is no private-credential fallback, shell, browser, connector, external model, or external memory adapter.
- Every data operation checks membership under a transaction lock; revocation and work execution are ordered against that lock. An operation admitted before revocation may finish before revocation commits. After the revocation response, subsequent access is denied.
- Stream checks occur every 500 ms by default; failure closes the stream. HTTP failures never fall back to stale permission grants. Browser content clears when stream revocation arrives.
- Revocation is owner-only, cannot target an owner, and preserves private data. Regrant is intentionally an administrative fixture operation in this pilot, not a second permissions UI.
- Idempotency applies per requester, space and nonce; parallel retries cannot create duplicate messages.
- Native attachments, search, exports, notifications, shared browser sessions, approval actions, model billing, native background workers and native login are not implemented by this harness. They must be wired through the same policy before a native release can be claimed safe.

## ORB integration seam

The pilot intentionally makes no live ORB calls. A future server-side adapter should map a verified Rakazo subject to an explicitly linked ORB authenticated user, use ORB's canonical active-member/grant rules, and map an ORB resource to a Rakazo space/agent. Missing, disabled or ambiguous mappings deny. Never grant a private space through a broad organisational role.

ORB should own the grant policy; Rakazo must own enforcement on each resource and execution path. The adapter can materialise versioned grants into local memberships for latency, but must have a defined revocation freshness bound, expiry, outage behaviour and audit trail. A login-time check alone is insufficient. Do not connect a browser directly to privileged membership tables. A team membership is not automatically a right to use every personal credential an agent owner possesses.

## Retaining changes through updates

Keep this directory in a versioned private fork/patch series. Pin the upstream base and candidate hashes, dependency lockfile and deployment image digests. Do not edit a running container. Carry only narrow native policy hooks when the native integration is implemented; keep organisation-specific mappings outside upstream product logic.

For each candidate, review changes to authentication, routes, RLS, schema, vaults and background execution. Run the baseline test suite, then rehearse candidate migrations on an expendable pilot database:

```sh
bash apps/shared-workspace-pilot/check-upstream.sh FULL_REVIEWED_COMMIT_HASH
```

This changes only the pilot database. Passing means this harness works on that schema, **not** that the new full application or deployment is validated. Run native integration tests and a staging backup/restore rehearsal before any production update. Do not roll back a migrated database just by downgrading its app image. Disable the pilot feature/access first; retain audit/history.

## Acceptance evidence

The automated tests cover discovery, direct private URLs, wrong-space resource IDs, forged actors, shared attribution, shared memory isolation, PostgreSQL RLS, concurrent retries, owner-only administration, old-session revocation, queued-work cancellation, regrant generation safety, stream closure, origin checks, private-data preservation and audit attribution.

Browser checks verify shared conversation visibility, hidden private navigation, revocation-driven clearing and continued access to one's private space. They exercise the pilot interface only.
