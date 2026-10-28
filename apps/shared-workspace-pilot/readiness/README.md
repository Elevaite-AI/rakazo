# Production-readiness rehearsals

These checks are for the isolated native pilot and the explicitly scoped live ORB reader. They do not authorise a production Rakazo deployment or an ORB database restart. Run from the repository root with the existing private `.local/native.env`. No credentials or identity manifests belong in this directory.

## Evidence from 27 October 2026

- `load.mjs`: 72 native bootstrap reads across the three staging logins, 24 at each concurrency level 1/4/8. All returned 200. Median/p95 milliseconds: 531/577, 587/1998, 952/1100. The four-client batch included cold connections. This is a bounded pilot test, not a saturation or long-duration production capacity claim.
- `recovery.mjs`: against the disposable exact-release PostgreSQL fixture on port 15444 only, changed the password, proved the existing session survived, withdrew its scope, terminated sessions, verified old-password denial, and admitted the new credential with a fresh scope revision. Dumped/restored into a separate database while login was disabled and changed the epoch before reopening. Old restored revisions were invalidated. Restored the fixture credential and removed the recovery database.
- `tls.mjs`: on the same isolated database, enabled a temporary CA-verified TLS connection, rejected plaintext and untrusted certificates, and verified `pg_stat_ssl.ssl=true`. Restored the original database configuration. The public ORB pooler remains a separate deployment concern.
- `tools.ts`: authenticated three mapped native staging accounts against live ORB authority. A deterministic runtime requested real native tools; it did not simulate their results. Actual Honcho HTTP, embedding/dialectic recall and PostgreSQL markdown memory were used. Shared save/recall, private-canary exclusion, source-run attribution, and explicit public `web_fetch` passed. The memory correction test deleted the disposable old fact through the real provider and proved the next recall returned GREEN, not BLUE. Live revocation immediately before a real memory write cancelled the run without executing that tool, then the staging grant was restored.

The model generating tool requests is deterministic, and the computer remains fake. This is not validation of external shell/computer/connector writes, model reasoning quality, or the full ORB Brain/reranking connector.

## Running

Keep the existing staging API running for `node apps/shared-workspace-pilot/readiness/load.mjs`.

Run `node apps/shared-workspace-pilot/readiness/recovery.mjs` and `node apps/shared-workspace-pilot/readiness/tls.mjs` serially against the disposable `rakazo-orb-release-proof` fixture. They refuse other database targets. Never point them at production.

Stop only the loopback native staging API before `pnpm exec tsx apps/shared-workspace-pilot/readiness/tools.ts`; it creates its own native API/executor in-process. It requires the rehearsal Honcho container and mints a one-hour key for a newly named disposable workspace. Do not reuse a personal Honcho workspace. It writes phase requests to `.local/readiness-tool-phase.json`. The authorised operator must revoke only the approved Member staging grant at phase `revoke`, confirm the database result, then write `{"phase":"revoked"}` to `.local/readiness-tool-release.json`. At phase `regrant`, restore that same grant, confirm it, and write `{"phase":"regranted"}`. A timeout is a failure, never approval. If interrupted, restore the grant and cancel only this test's waiting runs before restarting normal staging. Results remain in `.local/readiness-*-results.json`.

The tool proof intentionally captures a native `waiting_input` result for `forget_memory`. The shared pilot currently excludes the approval-action routes and UI. The subsequent disposable correction is an operator-authorised provider test, NOT evidence that the shared approval workflow works. Do not bypass the missing product permission model by granting every shared member approval powers.

## Remaining product gates

1. Define who can approve each shared action (requester, workspace owner, designated approver) and enforce that on native approval routes, stale approvals and resumed execution. Then expose the supported controls and test requester/other-member/revoked approver cases. The current hidden controls leave a correction waiting indefinitely and can occupy the shared agent.
2. Honcho stores shared/bot peers, not the individual requesting user. Source runs retain verified requester attribution in Rakazo; an exported Honcho conclusion does not retain that standalone provenance. Add an explicit provenance contract before claiming cross-agent personal attribution outside Rakazo.
3. Markdown and Honcho are separate stores. Updating MEMORY.md does not atomically replace a semantic fact. The correction rehearsal explicitly updated both and removed the obsolete conclusion. Define retry/reconciliation and UI ownership before production correction workflows.
4. Validate the actual deployed API/worker topology and connection budget. Private bootstrap also discovers shared scopes and pays an ORB query; a cold handshake can take seconds. Eight concurrent pilot reads passed, but geographic placement and sustained load remain material.

## ORB TLS maintenance proposal — NOT executed

Supabase documents that changing SSL enforcement reboots the database and can take seconds to minutes: https://supabase.com/docs/guides/platform/ssl-enforcement. Reserve a maintenance window with a rollback allowance; no precise duration is guaranteed.

Observed live sessions include the scoped reader over Supavisor with `ssl=false`, and local `gbrain_user`/`pgbouncer` postgres.js sessions. A local database address may belong to managed infrastructure; it does not identify the originating application or prove that its external connection is plaintext. Classify these clients before enforcing SSL. The current staging-to-pooler connection verifies CA and hostname successfully.

Release preconditions: identify owners and reconnect behaviour of non-TLS clients; check current SSL setting through the managed API; obtain a current backup/recovery receipt; run application/worker health baselines; confirm all customer-controlled direct clients use verified TLS; agree the downtime window. Use a separately reviewed protected operational release with management credentials held only in CI, not an ad hoc local management token. The migration-only approval from the earlier release does not authorise this different operational change.

During the window: enable database SSL enforcement once; observe health/reconnection; inspect `pg_stat_ssl` for the new scoped-reader backend; rerun all three native logins, revocation/regrant and bounded latency checks. Confirm ORB application and worker health, not only the reader. If critical clients cannot reconnect, the approved operator follows the documented rollback; disabling enforcement may itself restart the database. Preserve evidence. Production Rakazo application/configuration remains unchanged.

## Scoped credential rotation and restore procedure

A routine password change alone is insufficient. For the pilot's one reader: withdraw the exact scope, disable login, terminate its existing sessions, generate a new credential in the protected runner, export it recipient-encrypted, install it in staging, then recreate only the reviewed scope (new revision), enable login and recheck all three identities. This deliberately causes a staging-only denial window; it need not reboot ORB or change other grants. Invalidate old queued work and verify both old-password and old-session denial. Do not reset the password back to a potentially compromised credential as a rollback.

For database recovery, keep authority traffic fenced while restoring. Rotate the authority epoch before reopening; a restore revives old sequence/revision values. Reconcile current membership/grants with audit changes since the recovery point, and rotate credentials if exposure is possible. Old queued work must fail and new work must pass after explicit regrant. The local rehearsal validates these mechanics; a managed Supabase disaster recovery exercise has not been performed.

## Effective privilege audit: direct-reader containment is incomplete

Live catalog inspection found the reader can execute 219 functions in `public`, including 108 SECURITY DEFINER functions (87 non-trigger functions), plus 12 functions in `net`, through existing shared privileges. Only one function is granted inside `permission_authority`, but that does NOT make the login globally function-only. No unrelated function was invoked; callable metadata is not proof that its internal checks allow data disclosure. The earlier negative raw-table tests were necessary but insufficient.

Do not promote or distribute this direct database credential as a complete least-privilege boundary. NOINHERIT does not remove PUBLIC privileges, and default_transaction_read_only is a default, not a tamper-proof permission. Remediation requires either a reviewed PUBLIC privilege cleanup with explicit replacement grants and application compatibility tests, or a narrow authenticated decision endpoint that exposes no SQL interface to Rakazo and keeps the database login inside its protected backend. Neither is a reason to change global ORB grants ad hoc. Until that work is verified, the private staging credential remains contained on the test host and production rollout is blocked. Rotation alone cannot repair these inherited privileges.

## Designated approval candidate (isolated authority only)

Workspace access does not confer approval rights. The additive `approval-stage.sql` candidate stores explicit canonical-person approvers with independent revisions and default denial. Aliases share the same approver record. The existing live resolver is unchanged; the optional resolver is enabled only against the isolated authority by the staging composition root.

The native answer endpoint accepts only individual allow/deny decisions from a fresh designated grant. It rejects permanent approvals, secret inputs and instruction edits. The actual caller and both permission versions are saved atomically with the approval. The executor checks the requester and approver again on resume and before tools, cancelling missing, revoked or stale approvals. Regrant does not revive an old receipt. This bounds authority to the last check before dispatch; it cannot undo an external request already dispatched.

`approvals.ts` exercised all three synthetic mapped sessions against the isolated exact-release authority, native API/executor and a disposable real Honcho workspace. It proved denial without the approver grant while membership remained active, outsider denial, rejection of permanent approvals, caller receipts, permitted deletion, cancellation after approver revocation before deletion, and cancellation after regrant. Tool requests are deterministic; this is not an evaluation of an LLM's decision to ask for approval. Recall text checks are smoke observations, not a calibrated semantic-quality evaluation.

The web shows allow/deny only to designated approvers. A pending card seen by a member says “Workspace approver required”; this is necessary because the private-card fallback “No longer active” incorrectly describes an active shared request. Private controls remain unchanged. UI component tests cover these cases; a full browser approval flow remains a release gate.

Normal staging is restored to live membership permissions with approval capability denied until a new reviewed ORB migration and protected deployment. The candidate has not been applied to live ORB. Mobile approval rendering is not enabled by this pilot; its API receives the same authorization enforcement. Audit export, operator grant-management UI, and attribution displayed on answered cards remain follow-up usability work before general availability.

## Decision-only runtime cutover

`OrbDecisionAccess` sends only authenticated subject/workspace decisions to the separate ORB broker. The serve-only composition root `shared-workspace-serve.ts` rejects ORB SQL configuration and native migration credentials. The staging API runs as a separate non-root UID in a read-only container, without a Docker socket, with the host private configuration directory masked and a dedicated decision-token secret volume. The broker SQL volume is never mounted there. Host-side operators retain deployment authority; the application process does not.

The isolated broker/native tests exercised real Honcho deletion, each mapped login, approver revocation/regrant, service outage/recovery, and direct attempts to read broker/host credentials from the API container. An isolated sixty-second decision soak completed without failed requests. These local measurements do not predict live ORB round-trip latency. The protected ORB release rotates the old SQL credential before live cutover; until that approved deployment completes, the live direct-reader configuration remains a pending retirement item.
