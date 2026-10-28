import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createApp } from "@rakazo/api/app";
import type { Actor, Bot } from "@rakazo/contracts";
import { runAsSystem, runAsTenant } from "@rakazo/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OrbStagingAccess } from "../../../apps/shared-workspace-pilot/orb-access.js";
import { sessionCookieHeader } from "./index.js";

const enabled = process.env.VERIFY_DATABASE === "1";
describe.runIf(enabled)("native shared workspace with staged ORB grants", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let admin: pg.Pool, policyPool: pg.Pool, policy: OrbStagingAccess;
  const stamp = randomUUID();
  const people: Record<string, { cookie: string; actor: Actor; bot: Bot }> = {};
  let teamSpace: string, teamBot: Bot;
  const grants: Record<string, string> = {};
  const authoredMessages: Record<string, string> = {};
  async function raw(who: string, path: string, input: unknown = {}, spaceId?: string) {
    return handles.app.request(`/rpc/${path}`, {
      method: "POST",
      headers: {
        cookie: people[who].cookie,
        origin: "http://127.0.0.1:5173",
        "content-type": "application/json",
        ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
      },
      body: JSON.stringify({ json: input }),
    });
  }
  async function rpc(who: string, path: string, input: unknown = {}, spaceId?: string) {
    const r = await raw(who, path, input, spaceId);
    const b = await r.json();
    if (r.status >= 400) throw new Error(`${path}: ${r.status} ${JSON.stringify(b)}`);
    return b.json;
  }
  const system = <T>(fn: () => Promise<T>) =>
    runAsSystem("native isolated sharing test fixture", fn);
  const idle = () => handles.awaitIdle?.();
  async function setAccess(who: string, value: boolean) {
    await admin.query("UPDATE orb_stage.agent_access SET has_access=$1 WHERE id=$2", [
      value,
      grants[who],
    ]);
  }
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATION_URL });
    policyPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await admin.query(
      await readFile(
        new URL("../../../apps/shared-workspace-pilot/orb-stage.sql", import.meta.url),
        "utf8",
      ),
    );
    policy = new OrbStagingAccess(policyPool);
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir: `/tmp/native-shared-${stamp}`,
      encryptionKey: "native-pilot-test-encryption-key",
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      sharedWorkspaceAccess: policy,
    });
    for (const who of ["owner", "member", "outsider", "service"]) {
      const response = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:5173", "content-type": "application/json" },
        body: JSON.stringify({
          email: `${who}-${stamp}@example.test`,
          name: who,
          password: "native-pilot-password12",
        }),
      });
      expect(response.status).toBeLessThan(400);
      people[who] = { cookie: sessionCookieHeader(response), actor: null!, bot: null! };
      people[who].actor = await rpc(who, "me");
      people[who].bot = await rpc(who, "bots/create", {
        name: `${who} agent`,
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      await idle();
    }
    teamSpace = people.service.actor.spaceId;
    teamBot = people.service.bot;
    await system(async () => {
      const space = await handles.prisma.space.findUniqueOrThrow({ where: { id: teamSpace } });
      await handles.prisma.organization.update({
        where: { id: space.organizationId },
        data: { metadata: JSON.stringify({ sharedWorkspaceAuthority: "external" }) },
      });
    });
    const orbAgent = randomUUID();
    for (const who of ["owner", "member"]) {
      const canonical = randomUUID(),
        alias = randomUUID(),
        member = randomUUID(),
        grant = randomUUID();
      grants[who] = grant;
      await admin.query("INSERT INTO orb_stage.profiles VALUES($1,$2),($3,$4)", [
        canonical,
        `${who}@canonical.test`,
        alias,
        `${who}@alias.test`,
      ]);
      await admin.query("INSERT INTO orb_stage.team_member VALUES($1,$2,true,'active',NULL)", [
        member,
        canonical,
      ]);
      await admin.query("INSERT INTO orb_stage.identity_aliases VALUES($1,$2)", [alias, canonical]);
      await admin.query("INSERT INTO orb_stage.rakazo_identities VALUES($1,$2)", [
        people[who].actor.userId,
        alias,
      ]);
      await admin.query("INSERT INTO orb_stage.agent_access VALUES($1,$2,$3,'rakazo',true)", [
        grant,
        member,
        orbAgent,
      ]);
      await admin.query("INSERT INTO orb_stage.grant_versions VALUES($1,1)", [grant]);
      await system(async () => {
        const space = await handles.prisma.space.findUniqueOrThrow({ where: { id: teamSpace } });
        await handles.prisma.member.create({
          data: {
            id: randomUUID(),
            organizationId: space.organizationId,
            userId: people[who].actor.userId,
            role: "member",
            createdAt: new Date(),
          },
        });
      });
    }
    policy.bindings.set(teamSpace, {
      executionUserId: people.service.actor.userId,
      botId: teamBot.id,
      orbAgentId: orbAgent,
    });
  }, 60000);
  afterAll(async () => {
    await handles?.stop();
    await policyPool?.end();
    await admin?.end();
  });
  it("native navigation discovers the approved agent across organisations and hides private spaces", async () => {
    for (const who of ["owner", "member"]) {
      const spaces = (await rpc(who, "spaces/list")).spaces;
      expect(spaces.map((s: { id: string }) => s.id)).toContain(teamSpace);
      expect(
        spaces.find((s: { id: string }) => s.id === teamSpace).bots.map((b: Bot) => b.id),
      ).toContain(teamBot.id);
      expect(spaces.map((s: { id: string }) => s.id)).not.toContain(
        people[who === "owner" ? "member" : "owner"].actor.spaceId,
      );
      const boot = await rpc(who, "bootstrap", {}, teamSpace);
      expect(boot.me.userId).toBe(people[who].actor.userId);
      expect(boot.bots.map((b: Bot) => b.id)).toEqual([teamBot.id]);
    }
  });
  it("resolves current-space navigation once per request and observes the next revocation", async () => {
    const resolve = vi.spyOn(policy, "resolve");
    try {
      await rpc("owner", "bootstrap", {}, teamSpace);
      expect(
        resolve.mock.calls.filter(
          ([id, space]) => id === people.owner.actor.userId && space === teamSpace,
        ),
      ).toHaveLength(1);
      await setAccess("owner", false);
      expect((await raw("owner", "bootstrap", {}, teamSpace)).status).toBe(401);
      expect(
        resolve.mock.calls.filter(
          ([id, space]) => id === people.owner.actor.userId && space === teamSpace,
        ),
      ).toHaveLength(2);
    } finally {
      resolve.mockRestore();
      await setAccess("owner", true);
    }
  });
  it("runs messages from both accounts through the native executor with human provenance", async () => {
    for (const who of ["owner", "member"]) {
      const sent = await rpc(
        who,
        "threads/send",
        { botId: teamBot.id, text: `Hello from ${who}`, clientNonce: randomUUID() },
        teamSpace,
      );
      await idle();
      const run = await system(() =>
        handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId ?? sent.runIds?.[0] } }),
      );
      expect(run.userId).toBe(people.service.actor.userId);
      expect(run.status).toBe("completed");
      authoredMessages[who] = run.sourceMessageId!;
      const source = await system(() =>
        handles.prisma.message.findUniqueOrThrow({ where: { id: run.sourceMessageId! } }),
      );
      expect(source.blocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sharedAuthor: expect.objectContaining({ userId: people[who].actor.userId }),
          }),
        ]),
      );
    }
    const a = await rpc("owner", "threads/get", { botId: teamBot.id }, teamSpace);
    const b = await rpc("member", "threads/get", { botId: teamBot.id }, teamSpace);
    expect(a.messages).toEqual(b.messages);
  }, 30000);
  it("denies controlled spaces and delegated queued work when authority configuration is absent", async () => {
    const missing = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir: `/tmp/native-shared-missing-${stamp}`,
      encryptionKey: "native-pilot-test-encryption-key",
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
    });
    try {
      const request = (path: string, space: string) =>
        missing.app.request(`/rpc/${path}`, {
          method: "POST",
          headers: {
            cookie: people.owner.cookie,
            origin: "http://127.0.0.1:5173",
            "content-type": "application/json",
            "x-rakazo-space-id": space,
          },
          body: JSON.stringify({ json: {} }),
        });
      expect((await request("bootstrap", teamSpace)).status).toBe(401);
      expect((await request("bots/create", teamSpace)).status).toBe(401);
      expect((await request("bootstrap", people.owner.actor.spaceId)).status).toBe(200);
      const queued = await system(async () => {
        const original = await handles.prisma.run.findFirstOrThrow({
          where: { botId: teamBot.id, status: "completed" },
        });
        return handles.prisma.run.create({
          data: {
            spaceId: original.spaceId,
            userId: original.userId,
            botId: original.botId,
            threadId: original.threadId,
            taskId: original.taskId,
            sourceMessageId: original.sourceMessageId,
            status: "queued",
            trigger: "user",
          },
        });
      });
      await runAsTenant({ spaceId: teamSpace, userId: people.service.actor.userId }, () =>
        missing.executor.continueRun(queued.id, "missing-authority"),
      );
      const background = await system(() =>
        handles.prisma.run.create({
          data: {
            spaceId: queued.spaceId,
            userId: queued.userId,
            botId: queued.botId,
            threadId: queued.threadId,
            taskId: queued.taskId,
            sourceMessageId: null,
            status: "queued",
            trigger: "routine",
          },
        }),
      );
      await runAsTenant({ spaceId: teamSpace, userId: people.service.actor.userId }, () =>
        missing.executor.continueRun(background.id, "missing-authority-background"),
      );
      await system(async () => {
        expect(
          (await handles.prisma.run.findUniqueOrThrow({ where: { id: background.id } })).status,
        ).toBe("cancelled");
        expect(await handles.prisma.attempt.count({ where: { runId: background.id } })).toBe(0);
      });
      await system(async () => {
        expect(
          (await handles.prisma.run.findUniqueOrThrow({ where: { id: queued.id } })).status,
        ).toBe("cancelled");
        expect(await handles.prisma.attempt.count({ where: { runId: queued.id } })).toBe(0);
      });
    } finally {
      await missing.stop();
    }
  });
  it("rechecks native membership and does not revive old work after membership recreation", async () => {
    const membership = await system(() =>
      handles.prisma.spaceMember.findUniqueOrThrow({
        where: { spaceId_userId: { spaceId: teamSpace, userId: people.owner.actor.userId } },
      }),
    );
    const original = await system(() =>
      handles.prisma.run.findFirstOrThrow({
        where: {
          botId: teamBot.id,
          status: "completed",
          trigger: "user",
          sourceMessageId: { not: null },
        },
        orderBy: { createdAt: "asc" },
      }),
    );
    const source = await system(() =>
      handles.prisma.message.findUniqueOrThrow({ where: { id: original.sourceMessageId! } }),
    );
    expect(source.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sharedAuthor: expect.objectContaining({ userId: people.owner.actor.userId }),
        }),
      ]),
    );
    const replay = async () => {
      const queued = await system(() =>
        handles.prisma.run.create({
          data: {
            spaceId: original.spaceId,
            userId: original.userId,
            botId: original.botId,
            threadId: original.threadId,
            taskId: original.taskId,
            sourceMessageId: source.id,
            status: "queued",
            trigger: "user",
          },
        }),
      );
      await runAsTenant({ spaceId: teamSpace, userId: people.service.actor.userId }, () =>
        handles.executor.continueRun(queued.id, "native-membership-replay"),
      );
      expect(
        (await system(() => handles.prisma.run.findUniqueOrThrow({ where: { id: queued.id } })))
          .status,
      ).toBe("cancelled");
    };
    try {
      await system(() => handles.prisma.spaceMember.delete({ where: { id: membership.id } }));
      expect((await raw("owner", "bootstrap", {}, teamSpace)).status).toBe(401);
      expect((await raw("owner", "bootstrap", {}, people.owner.actor.spaceId)).status).toBe(200);
      await replay();
      await system(() =>
        handles.prisma.spaceMember.create({
          data: { ...membership, id: randomUUID(), createdAt: new Date() },
        }),
      );
      await replay();
      expect((await raw("owner", "bootstrap", {}, teamSpace)).status).toBe(200);
      const sent = await rpc(
        "owner",
        "threads/send",
        { botId: teamBot.id, text: "Fresh native membership", clientNonce: randomUUID() },
        teamSpace,
      );
      await idle();
      expect(
        (
          await system(() =>
            handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId ?? sent.runIds?.[0] } }),
          )
        ).status,
      ).toBe("completed");
    } finally {
      await system(async () => {
        if (
          !(await handles.prisma.spaceMember.findUnique({
            where: { spaceId_userId: { spaceId: teamSpace, userId: people.owner.actor.userId } },
          }))
        )
          await handles.prisma.spaceMember.create({
            data: { ...membership, id: randomUUID(), createdAt: new Date() },
          });
      });
    }
  });
  it("denies private resources, outsider access, credential management and unapproved tools", async () => {
    for (const who of ["owner", "member"]) {
      const other = who === "owner" ? "member" : "owner";
      expect(
        (
          await raw(
            who,
            "threads/get",
            { botId: people[other].bot.id },
            people[other].actor.spaceId,
          )
        ).status,
      ).toBeGreaterThanOrEqual(400);
      expect(
        (await raw(who, "threads/get", { botId: people[other].bot.id }, teamSpace)).status,
      ).toBeGreaterThanOrEqual(400);
      expect(
        (await raw(who, "bots/remove", { botId: teamBot.id }, teamSpace)).status,
      ).toBeGreaterThanOrEqual(400);
      expect(
        (
          await raw(
            who,
            "threads/send",
            { botId: teamBot.id, text: "attachment", artifactIds: ["private-file"] },
            teamSpace,
          )
        ).status,
      ).toBeGreaterThanOrEqual(400);
    }
    expect((await raw("outsider", "bootstrap", {}, teamSpace)).status).toBeGreaterThanOrEqual(400);
  });
  it("ORB revocation blocks old native sessions and shared discovery, preserving private access", async () => {
    await setAccess("member", false);
    expect((await raw("member", "bootstrap", {}, teamSpace)).status).toBe(401);
    expect(
      (await raw("member", "threads/send", { botId: teamBot.id, text: "denied" }, teamSpace))
        .status,
    ).toBe(401);
    expect(
      (await rpc("member", "spaces/list")).spaces.map((s: { id: string }) => s.id),
    ).not.toContain(teamSpace);
    expect((await rpc("member", "me")).userId).toBe(people.member.actor.userId);
    expect((await rpc("owner", "bootstrap", {}, teamSpace)).bots[0].id).toBe(teamBot.id);
  });
  it("the executor refuses old grant generations even after regrant", async () => {
    const source = await system(() =>
      handles.prisma.message.findUniqueOrThrow({ where: { id: authoredMessages.member } }),
    );
    const oldRun = await system(() =>
      handles.prisma.run.findFirstOrThrow({ where: { sourceMessageId: source.id } }),
    );
    await setAccess("member", true);
    const queued = await system(() =>
      handles.prisma.run.create({
        data: {
          spaceId: teamSpace,
          botId: teamBot.id,
          threadId: oldRun.threadId,
          taskId: oldRun.taskId,
          userId: oldRun.userId,
          status: "queued",
          trigger: "user",
          sourceMessageId: source.id,
        },
      }),
    );
    await runAsTenant({ spaceId: teamSpace, userId: oldRun.userId }, () =>
      handles.executor.continueRun(queued.id, "revocation-proof"),
    );
    expect(
      (await system(() => handles.prisma.run.findUniqueOrThrow({ where: { id: queued.id } })))
        .status,
    ).toBe("cancelled");
  });
  it("revocation interrupts a running native executor and a live native subscription", async () => {
    const sent = await rpc(
      "member",
      "threads/send",
      { botId: teamBot.id, text: "hang until stopped", clientNonce: randomUUID() },
      teamSpace,
    );
    const runId = sent.runId ?? sent.runIds?.[0];
    await expect
      .poll(
        async () =>
          (await system(() => handles.prisma.run.findUniqueOrThrow({ where: { id: runId } })))
            .status,
      )
      .toBe("running");
    const response = await raw(
      "member",
      "threads/subscribe",
      { botId: teamBot.id, cursor: -1 },
      teamSpace,
    );
    const reader = response.body!.getReader();
    await reader.read();
    await setAccess("member", false);
    let output = "";
    await Promise.race([
      (async () => {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          output += new TextDecoder().decode(part.value);
        }
      })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Stream did not revoke")), 3000),
      ),
    ]);
    expect(output).toMatch(/UNAUTHORIZED|Unauthorized/);
    await idle();
    expect(
      (await system(() => handles.prisma.run.findUniqueOrThrow({ where: { id: runId } }))).status,
    ).toBe("cancelled");
    await setAccess("member", true);
  }, 10000);
  it("permission source failure denies shared access while private sessions still work", async () => {
    await admin.query("ALTER TABLE orb_stage.agent_access RENAME TO agent_access_offline");
    try {
      expect((await raw("owner", "bootstrap", {}, teamSpace)).status).toBe(401);
      expect((await rpc("owner", "me")).userId).toBe(people.owner.actor.userId);
    } finally {
      await admin.query("ALTER TABLE orb_stage.agent_access_offline RENAME TO agent_access");
    }
  });
});
