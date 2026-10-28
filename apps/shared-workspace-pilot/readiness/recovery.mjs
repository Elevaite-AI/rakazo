import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import pg from "../node_modules/pg/lib/index.js";

const base = new URL("../.local/", import.meta.url),
  owner = JSON.parse(await readFile(new URL("release-proof/owner.json", base), "utf8")),
  reader = JSON.parse(await readFile(new URL("release-proof/reader.json", base), "utf8")),
  state = JSON.parse(await readFile(new URL("native-state.json", base), "utf8"));
for (const c of [owner, reader]) {
  const u = new URL(c.url);
  assert.equal(u.hostname, "127.0.0.1");
  assert.equal(u.port, "15444");
  assert.equal(u.pathname, "/postgres");
}
const admin = new pg.Pool({ connectionString: owner.url }),
  old = new pg.Client({ connectionString: reader.url });
old.on("error", () => {});
const originalPassword = decodeURIComponent(new URL(reader.url).password),
  nextPassword = randomBytes(32).toString("hex");
let fresh, restored, recovered;
const results = {};
const resolve = async (c) =>
  (
    await c.query("SELECT * FROM permission_authority.resolve($1,$2)", [
      state.people.member.actor.userId,
      state.spaceId,
    ])
  ).rows[0];
try {
  await old.connect();
  const before = await resolve(old);
  assert.ok(before);
  await admin.query(`ALTER ROLE rakazo_permission_reader PASSWORD '${nextPassword}'`);
  assert.ok(await resolve(old));
  results.passwordChangeDoesNotKillExistingSession = true;
  const invalid = new pg.Client({ connectionString: reader.url, connectionTimeoutMillis: 2000 });
  await assert.rejects(
    () => invalid.connect(),
    (e) => e.code === "28P01",
  );
  await invalid.end().catch(() => {});
  results.oldPasswordNewConnectionDenied = true;
  await admin.query(
    "DELETE FROM permission_authority.reader_scopes WHERE login_name='rakazo_permission_reader' AND space_id=$1",
    [state.spaceId],
  );
  assert.equal(await resolve(old), undefined);
  results.oldSessionDeniedAfterScopeWithdrawal = true;
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='rakazo_permission_reader' AND datname='postgres' AND pid<>pg_backend_pid()",
  );
  await old.end().catch(() => {});
  const newUrl = new URL(reader.url);
  newUrl.password = nextPassword;
  fresh = new pg.Client({ connectionString: newUrl.toString() });
  await fresh.connect();
  assert.equal(await resolve(fresh), undefined);
  await admin.query(
    "INSERT INTO permission_authority.reader_scopes(login_name,space_id) VALUES('rakazo_permission_reader',$1)",
    [state.spaceId],
  );
  const rotated = await resolve(fresh);
  assert.ok(rotated);
  assert.notEqual(rotated.revision, before.revision);
  results.newCredentialGrantedWithNewRevision = true;
  const approvalArgs = [state.people.member.actor.userId, state.spaceId];
  const currentApproval = (
    await fresh.query(
      "SELECT approval_revision FROM permission_authority.resolve_with_approval($1,$2)",
      approvalArgs,
    )
  ).rows[0]?.approval_revision;
  await fresh.end();
  fresh = null;
  const snapshot = execFileSync(
    "docker",
    ["exec", "rakazo-orb-release-proof", "pg_dump", "-U", "postgres", "--no-owner", "postgres"],
    { maxBuffer: 20 * 1024 * 1024 },
  );
  await writeFile(new URL("release-proof/recovery-snapshot.sql", base), snapshot, { mode: 0o600 });
  await admin.query("CREATE DATABASE permission_recovery");
  await admin.query("ALTER ROLE rakazo_permission_reader NOLOGIN");
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "rakazo-orb-release-proof",
      "psql",
      "-U",
      "postgres",
      "-d",
      "permission_recovery",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input: snapshot, stdio: ["pipe", "pipe", "pipe"] },
  );
  const restoredAdminUrl = new URL(owner.url);
  restoredAdminUrl.pathname = "/permission_recovery";
  restored = new pg.Client({ connectionString: restoredAdminUrl.toString() });
  await restored.connect();
  const oldEpoch = (await admin.query("SELECT epoch FROM permission_authority.instance")).rows[0]
    .epoch;
  assert.equal(
    (await restored.query("SELECT epoch FROM permission_authority.instance")).rows[0].epoch,
    oldEpoch,
  );
  results.snapshotRestoresOldEpoch = true;
  await restored.query("UPDATE permission_authority.instance SET epoch=gen_random_uuid()");
  assert.notEqual(
    (await restored.query("SELECT epoch FROM permission_authority.instance")).rows[0].epoch,
    oldEpoch,
  );
  await admin.query("ALTER ROLE rakazo_permission_reader LOGIN");
  const recoveredUrl = new URL(newUrl);
  recoveredUrl.pathname = "/permission_recovery";
  recovered = new pg.Client({ connectionString: recoveredUrl.toString() });
  await recovered.connect();
  const recoveredGrant = await resolve(recovered);
  const recoveredApproval = (
    await recovered.query(
      "SELECT approval_revision FROM permission_authority.resolve_with_approval($1,$2)",
      approvalArgs,
    )
  ).rows[0]?.approval_revision;
  assert.ok(recoveredApproval);
  assert.ok(currentApproval);
  assert.notEqual(recoveredApproval, currentApproval);
  results.preRestoreApprovalInvalidated = true;
  assert.ok(recoveredGrant);
  assert.notEqual(recoveredGrant.revision, rotated.revision);
  await recovered.end();
  results.recoveryFencedUntilEpochRotated = true;
  results.preRestoreRevisionInvalidated = true;
  await writeFile(
    new URL("readiness-recovery-results.json", base),
    JSON.stringify({ environment: "isolated exact release database only", results }, null, 2),
  );
  console.log(JSON.stringify(results));
} finally {
  await old.end().catch(() => {});
  if (fresh) await fresh.end();
  if (restored) await restored.end();
  if (recovered) await recovered.end().catch(() => {});
  await admin.query(`ALTER ROLE rakazo_permission_reader LOGIN PASSWORD '${originalPassword}'`);
  await admin.query("DROP DATABASE IF EXISTS permission_recovery WITH (FORCE)");
  await admin.end();
}
