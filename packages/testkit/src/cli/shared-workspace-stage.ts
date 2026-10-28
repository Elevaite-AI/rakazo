import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { createApp } from "@rakazo/api/app";
import type { Actor, Bot } from "@rakazo/contracts";
import { runAsSystem } from "@rakazo/db";
import pg from "pg";
import { OrbStagingAccess } from "../../../../apps/shared-workspace-pilot/orb-access.js";
import { OrbDecisionAccess } from "../../../../apps/shared-workspace-pilot/orb-decision-access.js";
import { OrbLiveAccess } from "../../../../apps/shared-workspace-pilot/orb-live-access.js";
import { OrbVersionedAccess } from "../../../../apps/shared-workspace-pilot/orb-versioned-access.js";
import { sessionCookieHeader } from "../index.js";

for (const connection of [process.env.DATABASE_URL, process.env.DATABASE_MIGRATION_URL]) {
  const url = new URL(connection!);
  if (
    url.hostname !== "127.0.0.1" ||
    url.port !== "15439" ||
    url.pathname !== "/rakazo_native_stage"
  )
    throw new Error("Refusing a non-staging database");
}
if (process.env.AGENT_RUNTIME !== "scripted" || process.env.SANDBOX_PROVIDER !== "fake")
  throw new Error("Staging must use offline model and sandbox adapters");
const fixturePath = process.env.NATIVE_STAGE_FIXTURE!;
const statePath = process.env.NATIVE_STAGE_STATE!;
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const admin = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATION_URL });
const policyPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await admin.query(
  await readFile(
    new URL("../../../../apps/shared-workspace-pilot/orb-stage.sql", import.meta.url),
    "utf8",
  ),
);
const brokerConfig = process.env.NATIVE_STAGE_DECISION_CONFIG
  ? JSON.parse(await readFile(process.env.NATIVE_STAGE_DECISION_CONFIG, "utf8"))
  : null;
if (brokerConfig && process.env.NATIVE_STAGE_AUTHORITY_CONFIG)
  throw new Error("Do not load an ORB database credential with decision mode");
const versionedConfig = process.env.NATIVE_STAGE_AUTHORITY_CONFIG
  ? JSON.parse(await readFile(process.env.NATIVE_STAGE_AUTHORITY_CONFIG, "utf8"))
  : null;
if (versionedConfig) {
  const authorityUrl = new URL(versionedConfig.url);
  const local =
    authorityUrl.hostname === "127.0.0.1" &&
    ((authorityUrl.port === "15443" && authorityUrl.pathname === "/orb_permission_stage") ||
      (authorityUrl.port === "15444" && authorityUrl.pathname === "/postgres"));
  const live =
    versionedConfig.mode === "live" &&
    authorityUrl.hostname.endsWith(".pooler.supabase.com") &&
    authorityUrl.port === "5432" &&
    authorityUrl.pathname === "/postgres" &&
    decodeURIComponent(authorityUrl.username).startsWith("rakazo_permission_reader.") &&
    versionedConfig.ssl?.rejectUnauthorized === true;
  if (versionedConfig.approvals && !local)
    throw new Error("Approval candidate requires isolated authority");
  if (!local && !live) throw new Error("Approved scoped permission authority required");
}
const authorityPool = versionedConfig
  ? new pg.Pool({
      connectionString: versionedConfig.url,
      ...(versionedConfig.ssl ? { ssl: versionedConfig.ssl } : {}),
      max: 4,
      connectionTimeoutMillis: versionedConfig.mode === "live" ? 5000 : 750,
      query_timeout: 750,
      statement_timeout: 500,
    })
  : null;
const liveConfig =
  !versionedConfig && process.env.NATIVE_STAGE_ORB_LIVE_CONFIG
    ? JSON.parse(await readFile(process.env.NATIVE_STAGE_ORB_LIVE_CONFIG, "utf8"))
    : null;
const policy = brokerConfig
  ? new OrbDecisionAccess(brokerConfig.url, brokerConfig.token, new Set(brokerConfig.spaces))
  : authorityPool
    ? new OrbVersionedAccess(
        authorityPool,
        new Set(versionedConfig.spaces),
        versionedConfig.approvals === true,
      )
    : liveConfig
      ? new OrbLiveAccess(policyPool, liveConfig)
      : new OrbStagingAccess(policyPool);
const handles = await createApp({ sharedWorkspaceAccess: policy });
const origin = "http://127.0.0.1:15442";
async function rpc(cookie: string, method: string, input: unknown = {}, spaceId?: string) {
  const r = await handles.app.request(`/rpc/${method}`, {
    method: "POST",
    headers: {
      cookie,
      origin,
      "content-type": "application/json",
      ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
    },
    body: JSON.stringify({ json: input }),
  });
  const b = await r.json();
  if (r.status >= 400) throw new Error(`${method} ${r.status}: ${JSON.stringify(b)}`);
  return b.json;
}
let state: {
  people: Record<
    string,
    { email: string; password: string; actor: Actor; bot: Bot; grantId?: string }
  >;
  spaceId: string;
  botId: string;
  orbAgentId: string;
};
try {
  state = JSON.parse(await readFile(statePath, "utf8"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  state = { people: {}, spaceId: "", botId: "", orbAgentId: randomUUID() };
  for (const person of [
    ...fixture.people,
    { key: "outsider", email: "outsider@native-pilot.test", name: "Outsider" },
    { key: "service", email: "team-executor@native-pilot.test", name: "Team execution identity" },
  ]) {
    const password = randomBytes(24).toString("base64url");
    const r = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email: person.email, name: person.name, password }),
    });
    if (r.status >= 400) throw new Error(`Staging account could not be created (${r.status})`);
    const cookie = sessionCookieHeader(r);
    const actor = await rpc(cookie, "me");
    const bot = await rpc(cookie, "bots/create", {
      name: person.key === "service" ? "Team Pilot" : `${person.name} Private`,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    await handles.awaitIdle?.();
    await runAsSystem("staging identity fixture only", () =>
      handles.prisma.space.update({
        where: { id: actor.spaceId },
        data: { name: person.key === "service" ? "Team — Staging" : `${person.name} — Private` },
      }),
    );
    state.people[person.key] = { ...person, password, actor, bot };
  }
  const service = state.people.service;
  state.spaceId = service.actor.spaceId;
  state.botId = service.bot.id;
  for (const person of fixture.people) {
    const p = state.people[person.key];
    for (const [id, email] of [
      [person.profileId, person.email],
      [person.canonicalProfileId, person.canonicalEmail],
    ]) {
      await admin.query("INSERT INTO orb_stage.profiles VALUES($1,$2) ON CONFLICT(id) DO NOTHING", [
        id,
        email,
      ]);
    }
    await admin.query(
      "INSERT INTO orb_stage.team_member VALUES($1,$2,true,'active',NULL) ON CONFLICT(id) DO NOTHING",
      [person.teamMemberId, person.canonicalProfileId],
    );
    if (person.profileId !== person.canonicalProfileId)
      await admin.query(
        "INSERT INTO orb_stage.identity_aliases VALUES($1,$2) ON CONFLICT(alias_profile_id) DO UPDATE SET canonical_profile_id=excluded.canonical_profile_id",
        [person.profileId, person.canonicalProfileId],
      );
    await admin.query("INSERT INTO orb_stage.rakazo_identities VALUES($1,$2)", [
      p.actor.userId,
      person.profileId,
    ]);
    const existing = (
      await admin.query(
        "SELECT id FROM orb_stage.agent_access WHERE team_member_id=$1 AND agent_id=$2",
        [person.teamMemberId, state.orbAgentId],
      )
    ).rows[0];
    p.grantId = existing?.id ?? randomUUID();
    await admin.query(
      "INSERT INTO orb_stage.agent_access VALUES($1,$2,$3,'rakazo',true) ON CONFLICT(id) DO NOTHING",
      [p.grantId, person.teamMemberId, state.orbAgentId],
    );
    await admin.query(
      "INSERT INTO orb_stage.grant_versions VALUES($1,1) ON CONFLICT(grant_id) DO NOTHING",
      [p.grantId],
    );
    await runAsSystem("staging shared workspace membership", async () => {
      const space = await handles.prisma.space.findUniqueOrThrow({ where: { id: state.spaceId } });
      await handles.prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId: space.organizationId,
          userId: p.actor.userId,
          role: "member",
          createdAt: new Date(),
        },
      });
    });
  }
  await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}
if (policy instanceof OrbLiveAccess || policy instanceof OrbStagingAccess)
  policy.bindings.set(state.spaceId, {
    executionUserId: state.people.service.actor.userId,
    botId: state.botId,
    orbAgentId: state.orbAgentId,
  });
const server = serve({ fetch: handles.app.fetch, hostname: "127.0.0.1", port: 15441 });
console.log(
  "Native staging API ready on loopback port 15441. Account credentials remain in the private staging state file.",
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    server.close();
    await handles.stop();
    await policyPool.end();
    await authorityPool?.end();
    await admin.end();
    process.exit(0);
  });
