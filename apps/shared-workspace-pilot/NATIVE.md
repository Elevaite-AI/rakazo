# Native staging pilot

This follow-on pilot uses the actual Better Auth sessions, native web interface, RPC routes, PostgreSQL repositories, queue and executor. The original standalone prototype and its evidence remain separate; README.md describes that prototype.

The native source is based on upstream `a2c8001cfa69cd019b7fb9bbc79ef8012286ea0e`. A dedicated staging database has the candidate's 160 migrations. The native runner is `packages/testkit/src/cli/shared-workspace-stage.ts`. Both database connections are restricted to the isolated loopback staging database, and the runner requires offline model and sandbox adapters. No production deployment is changed. The subsequent read-only live adapter mode is documented below.

## Policy

`SharedWorkspaceAccess` is a provider-neutral server interface. `orb-access.ts` is a staging adapter over a local projection of ORB's active `team_member` and explicit `agent_access` rules. It does not query or change production ORB. Verified identity aliases map to the same canonical profile, team member and grant. Alias registration is an administrative binding, never inferred from a client-supplied email. Accounts and private spaces are not merged.

The shared space has a dedicated execution principal with no personal credentials. Authentication retains the human requester; approved shared routes use the execution principal only within the granted space and bot. The sender and grant revision are stored on the native message. Existing private bot ownership remains enforced. Native navigation includes only memberships the requester holds and grants the adapter currently approves.

The pilot allows text conversations with one shared agent. Other routes fail closed, including attachments, credentials, computer endpoints, memory administration and destructive agent operations. The native web interface now hides unsupported controls in the conversation-only shared context. Shared participants can stop the shared conversation; separate moderator permissions are outside this pilot. Concurrent sends while a run is active are rejected to keep attribution unambiguous.

Requests and sends check current access. Streams and active runs recheck every 500 ms; queued execution and model tool dispatch recheck access. Grant version changes invalidate old queued work even after regrant. No permission-source fallback is used on failure. Revocation cannot undo data already seen or an external effect already dispatched. The offline pilot proves native cancellation and access rejection, not cancellation of real external provider operations.

## Running and verification

The private staging fixture and generated credentials belong in ignored `.local/`, mode 0600. The fixture supplies `people` entries with key, name, email, profileId, canonicalProfileId, canonicalEmail and teamMemberId. No real identities belong in tracked source. Configure the existing native application environment, `NATIVE_STAGE_FIXTURE` and `NATIVE_STAGE_STATE`, then run:

```sh
pnpm exec tsx packages/testkit/src/cli/shared-workspace-stage.ts
```

The runner serves the native API on loopback port 15441; native Vite uses 15442 with its API proxy pointing to 15441. Use a private tunnel for remote review. Never publish the staging account fixture.

With a disposable migrated PostgreSQL database, `VERIFY_DATABASE=1`, runtime and migration URLs, and the normal offline test environment (including `MCP_ALLOW_PRIVATE_ENDPOINT=true` for the existing authorization suite’s local model fixtures):

```sh
pnpm exec vitest run packages/testkit/src/shared-workspace-native.postgres.test.ts
pnpm exec vitest run packages/testkit/src/authorization.test.ts
pnpm --filter @rakazo/api check
pnpm --filter @rakazo/testkit check
pnpm --filter @rakazo/web build
```

The seven native integration tests cover discovery, requester attribution and native completion, cross-user private resource denial, outsider denial, unsupported operations, old-session revocation, old-grant queued execution, live stream/run cancellation and permission-source failure. Do not run the fault-injection test concurrently with browser checks: it briefly makes the staging permission table unavailable.

## Upgrade and release boundary

Retain this as a small reviewed patch series in a fork, with the ORB adapter and identity fixtures separate from product logic. Rebase onto each pinned upstream candidate, rehearse migrations, run the native permission and original authorization suites, then repeat browser isolation/revocation checks. Updates are not automatically safe: new routes, workers, downloads, notifications and memory paths need explicit policy review. An upstream cherry-pick cannot replace this validation.

Before production, provide the authenticated live ORB grant export/adapter, version all relevant identity/member/grant changes, bound lookup timeouts and revocation freshness, and audit the authority changes. Verify policy injection in every actual executor process, choose explicit team credentials and billing, hide unsupported controls, rehearse backup/restore and rollback, and test each enabled tool/memory channel. Current staging uses the actual native executor with scripted model output and a fake computer; it does not prove live-model, external-tool or Honcho authorization. No memory migration or account merge occurs.

## Live ORB read-only staging mode

Set `NATIVE_STAGE_ORB_LIVE_CONFIG` to an owner-readable, ignored JSON file containing the project HTTPS `url` and server-only `key`. The native runner selects `OrbLiveAccess` instead of the local projection. Failure to read configured credentials stops startup; failed or timed-out live queries deny access. No fallback to local grants exists. The current adapter performs GET requests only, refuses redirects, uses a two-second timeout, and reads only member status and agent grants for the canonical server-bound identity. It never sends credentials to the browser. The existing operator credential used in the rehearsal has broader privileges than the adapter; a dedicated read-only endpoint/credential remains a production prerequisite.

A live grant must match the configured staging resource UUID and `agent_type = 'rakazo-staging'`. Active membership or an admin role alone does not grant access. The live table's unique constraint is `(team_member_id, agent_type)`; this is not an unrestricted per-agent membership model. The local adapter's simplified schema should not be mistaken for the live schema.

The server returns `me.conversationOnly` for shared requests. The native web shell hides unsupported settings, search/activity, create/import, integrations, computer, file attachment, reply/reaction and slash-action controls in that context. It preserves text sending, stopping and navigation back to private spaces. Private controls remain unchanged. The backend allowlist remains authoritative. Mobile capability rendering is not validated by this browser pilot.

The live table has no monotonic mutation version for grant updates. The adapter fingerprints the selected grant and member update timestamp; it cannot detect an off/on toggle between observations if the same row returns unchanged. For the proposed live rehearsal, revoke by removing the staging-only grant and regrant with a new grant ID. A versioned authority export is still required before claiming general production regrant safety.

Verification must distinguish three results: live missing-grant denial, isolated-grant browser access/revocation, and actual live grant revocation. Do not claim the third from the first two. Creating the two staging-only rows in a live permission database is a production data change and must respect the user's production-change boundary.

## Versioned authority follow-on

The current isolated rehearsal uses a transactional versioned source and function-only reader credential. See [VERSIONED-AUTHORITY.md](VERSIONED-AUTHORITY.md) for the source boundary, setup, guarantees and production release gates. This mode uses an isolated ORB source reproduction; it is not a synchronized live ORB cache.
