import { createServer } from "node:http";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindSharedWorkspaceMembership,
  loadSharedWorkspaceAccess,
  SharedWorkspaceDecisionAccess,
} from "./shared-workspace-access.js";
const token = "a".repeat(64);
const grant = {
  executionUserId: "service",
  botIds: ["agent"],
  revision: "external-1",
  canSend: true,
  approvalRevision: "canonical-approval-1",
};
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function directory() {
  const dir = await mkdtemp("/tmp/rakazo-decision-");
  directories.push(dir);
  return dir;
}

describe("shared workspace deployment access", () => {
  it("requires a private valid configured file and never falls back from a missing one", async () => {
    expect(await loadSharedWorkspaceAccess({})).toBeUndefined();
    const dir = await directory(),
      file = dir + "/client.json";
    const source = { RAKAZO_SHARED_WORKSPACE_CONFIG: file };
    await expect(loadSharedWorkspaceAccess(source)).rejects.toThrow();
    await writeFile(
      file,
      JSON.stringify({ url: "http://127.0.0.1/v1/resolve", token, spaces: ["workspace"] }),
      { mode: 0o600 },
    );
    expect((await loadSharedWorkspaceAccess(source))?.isSharedSpace("workspace")).toBe(true);
    await chmod(file, 0o644);
    await expect(loadSharedWorkspaceAccess(source)).rejects.toThrow();
    await chmod(file, 0o600);
    await writeFile(
      file,
      JSON.stringify({
        url: "http://127.0.0.1/v1/resolve",
        token,
        spaces: ["workspace"],
        database: "forbidden",
      }),
    );
    await expect(loadSharedWorkspaceAccess(source)).rejects.toThrow();
  });
  it("uses only the configured Unix socket and observes fresh revocation without TCP fallback", async () => {
    const dir = await directory(),
      socket = dir + "/decision.sock";
    let allowed = true,
      requests = 0;
    const server = createServer(async (req, res) => {
      requests++;
      expect(req.url).toBe("/v1/resolve");
      expect(req.headers.authorization).toBe(`Bearer ${token}`);
      let body = "";
      for await (const chunk of req) body += chunk;
      expect(JSON.parse(body)).toEqual({ subject: "member", spaceId: "workspace" });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ grant: allowed ? grant : null }));
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const access = new SharedWorkspaceDecisionAccess(
        "http://127.0.0.1/v1/resolve",
        token,
        new Set(["workspace"]),
        socket,
      );
      expect(await access.resolve("member", "workspace")).toEqual(grant);
      allowed = false;
      expect(await access.resolve("member", "workspace")).toBeNull();
      expect(await access.resolve("member", "private")).toBeNull();
      expect(requests).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const missing = new SharedWorkspaceDecisionAccess(
      "http://127.0.0.1/v1/resolve",
      token,
      new Set(["workspace"]),
      socket,
    );
    await expect(missing.resolve("member", "workspace")).rejects.toThrow(
      "Permission authority unavailable",
    );
  });
  it("requires native membership and versions deletion/recreation independently of the external grant", async () => {
    let member: { id: string; createdAt: Date } | null = {
      id: "first-membership",
      createdAt: new Date(0),
    };
    const findUnique = vi.fn(async () => member);
    const prisma = { spaceMember: { findUnique } } as unknown as PrismaClient;
    const authority = {
      isSharedSpace: (id: string) => id === "workspace",
      resolve: vi.fn(async () => grant),
    };
    const access = bindSharedWorkspaceMembership(prisma, authority)!;
    const first = await access.resolve("member", "workspace");
    expect(first).not.toBeNull();
    member = null;
    expect(await access.resolve("member", "workspace")).toBeNull();
    member = { id: "recreated-membership", createdAt: new Date(1) };
    const fresh = await access.resolve("member", "workspace");
    expect(fresh?.revision).not.toBe(first?.revision);
    expect(fresh?.approvalRevision).toBe(first?.approvalRevision);
    expect(findUnique).toHaveBeenCalledWith({
      where: { spaceId_userId: { spaceId: "workspace", userId: "member" } },
      select: { id: true, createdAt: true },
    });
    expect(await access.resolve("member", "private")).toBeNull();
    expect(authority.resolve).toHaveBeenCalledTimes(3);
  });
});
