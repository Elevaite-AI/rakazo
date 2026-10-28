# Versioned authority rehearsal and live staging

This candidate runs in a separate PostgreSQL container on loopback port 15443, database `orb_permission_stage`. It is an isolated ORB permission-source reproduction, not a continuously synchronized cache of production. Live ORB schema and the two previously approved live staging grants remain unchanged. This describes the original local rehearsal; the live staging addendum below supersedes its deployment status.

## Guarantees implemented

- Source `team_member` and `agent_access` changes update authority rows in the same transaction through triggers. The reproduced source tables use the inspected member/type uniqueness rule. Only mapped staging resources participate in grant synchronization.
- Every insertion/update gets a new sequence revision. The decision revision combines instance epoch, principal binding, alias binding, member state, grant, resource and reader scope. Even an off/on change within one committed transaction changes the revision. Deletion and recreation cannot recover an old revision.
- A new database instance has a fresh epoch. After restoring a snapshot, rotate the epoch before admitting traffic; restore rehearsal remains a release gate.
- The native executor compares the stored message revision with the current decision. Streams and active work continue to recheck. No decision is cached across requests; unknown identities, missing scopes and failed lookups deny access.
- Resource-to-ORB bindings are immutable in this pilot. Rebinding requires explicit new-resource provisioning, avoiding accidentally retaining grants from another resource.
- `rakazo_permission_reader` can connect and execute only the scoped `resolve(text,text)` decision function. It cannot read source/authority tables, write grants, create objects or assume owner. The function uses `session_user` and a fixed search path; callers cannot supply a reader identity. The reader has one pilot scope, a connection limit and bounded query/lock timeouts.
- The native app uses a maximum four-connection pool, a 750 ms query limit (local connection limit 750 ms; live TLS handshake allowance 5 seconds) and 500 ms statement limit. Credentials are private server-side configuration. The earlier local copy of the broad ORB service key has been removed.

## Reproduce locally

Start with the existing isolated native pilot and ignored `.local/orb-identities.json` and `.local/native-state.json` fixtures. Do not put actual identities or passwords into tracked files.

```sh
node apps/shared-workspace-pilot/setup-authority.mjs
```

The setup refuses to overwrite an existing authority container. It uses the pinned PostgreSQL image and applies the following files in order:

1. `authority-stage.sql`: private authority schema and versioned decision function.
2. `authority-orb-source-stage.sql`: minimal reproduction of the inspected ORB source tables, transactional synchronization triggers and resource mapping.
3. `authority-stage-hardening.sql`: reader-scope versions and immutable resource mapping.
4. `authority-source-delete-hardening.sql`: source cascade fidelity and permanent revocation of deleted member grants.

The setup seeds only the pilot fixture, creates a random scoped reader password, and writes owner/reader config files with mode 0600. Owner credentials are for fixture administration only. Set `NATIVE_STAGE_AUTHORITY_CONFIG` to the reader config, then start the native stage runner. It validates the isolated database address and gives the versioned provider priority; configured authority errors never fall back to the live or legacy providers. No production key is loaded in this mode.

Tests: set `VERIFY_AUTHORITY=1`, `AUTHORITY_OWNER_URL` and `AUTHORITY_READER_URL` from the private staging configs, then run `pnpm exec vitest run packages/testkit/src/orb-versioned-authority.postgres.test.ts`. The test requires the isolated host/port/database, uses synthetic identities and removes its temporary reader scope on exit. The prior native and authorization suites remain applicable.

## Evidence and performance interpretation

The rehearsal covers all three pilot logins, same-row revocation/regrant, six native old-work replays including committed off/on transitions, source outage and recovery, raw-table denial, scope isolation, member offboarding, cascade deletion/recreation and binding changes. Querying a healthy current grant before an old-work replay separates version rejection from source outage failure.

The colocated authority has a different network topology from the previous remote Data API. The lower measured staging latency proves the candidate path is cheap locally; it does not guarantee remote production timings. Place the production decision service/database close to the executor and measure that exact path. Do not replace required authorization with a memory-relevance heuristic. No cross-request permission cache was introduced.

## Gates before production

1. Review and produce an additive migration against ORB's actual migration ledger and schema through its protected release workflow. The public-table CREATE statements in this rehearsal are fixtures and must not be applied to existing production tables. Preserve existing RLS and permissions. Backfill only reviewed identity/resource bindings and validate source-to-authority equivalence before enabling reads.
2. Install the versioned source synchronization/export and issue a separate scoped read-only credential through the approved production secret path. Decide the production resource type explicitly. Do not reuse a service-role key. Rotation must withdraw the old reader scope and terminate its sessions; changing a password alone does not invalidate existing database connections.
3. Wire the provider into every deployed API and worker process, with TLS verification and production connection budgets. Rehearse source loss, credential rotation, replica/backup restoration with a new epoch, and rollback to a deny-safe state. A restored old revision namespace must never admit old queued work.
4. Repeat the three-login proof against the actual live versioned endpoint and intended network placement. Confirm no stale-permission window and measure tail latency under expected concurrency. Current staging is a source snapshot, not live ORB authorization.
5. Validate every tool/memory/export/notification channel enabled for shared use, including explicit team credentials and billing. This pilot retains scripted model output and a fake computer. Honcho, real external effects and mobile capability rendering have not been proved by these tests.

These are release gates, not authorization to change production. Existing production Rakazo remains unchanged.


## Live staging addendum — 2026-10-27

The additive ORB migration `20261027041101` was applied through the protected main workflow with exact-release approval. The live version reads existing source member/grant rows directly and tracks durable member, grant and canonical-identity generations; it does not replace source tables, policies or existing grants. One staging scope and three subjects representing two canonical members were provisioned. Native staging now uses the scoped reader; production Rakazo has not changed.

The private config selected by `NATIVE_STAGE_AUTHORITY_CONFIG` uses `mode: "live"`, a session-pooler URL on port 5432, reader username, approved `spaces`, and `ssl: {rejectUnauthorized: true, ca: PEM}`. Keep its URL/password in ignored mode-0600 storage. Retrieve the CA from the HTTPS URL published in Supabase's official Studio `hooks/custom-content/custom-content.json`, currently `https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt`. The verified root SHA-256 fingerprint is `807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa`. Do not trust a certificate obtained only from an unverified server handshake or disable verification. Rotation requires revalidation against the official source.

The live handshake needs a longer allowance than a loopback connection; permission queries retain the 750 ms client/500 ms server bounds. A cold connection can therefore add several seconds before failing closed. The client-to-pooler TLS certificate and hostname are verified. `pg_stat_ssl` reports the onward pooler-to-database leg is not encrypted: database-side SSL enforcement is a remaining production gate and can require a shared database restart.

All three native staging login tests passed against live authority: shared attribution, private isolation, revocation of existing sessions and active work, open-UI removal, and regrant. Both aliases lose shared access together. Six stale-work replays, including off/on changes within one transaction, remained cancelled with healthy current grants. Both approved staging grants were restored. Raw source/private tables, mutation and role escalation were denied to the reader.

Ten bootstrap samples per login measured shared medians 533–541 ms and p90 540–551 ms; private bootstrap medians were 287–291 ms because discovery also checks the configured shared scope. These are remote staging measurements, not a production latency guarantee. No authorization cache was introduced. The earlier local outage and source mutation tests remain local evidence; do not disrupt live ORB to simulate an outage.

The migration/provisioning gates above are complete for staging only. Production still requires intended-topology/concurrency measurement, credential rotation and restore/epoch rehearsal, database-side TLS, and validation of each enabled real tool, memory, export and notification channel. This remains a loopback synthetic-account harness with a scripted model and fake computer.
