import { createRouterClient } from "@orpc/server";
import type { Actor, SharedWorkspaceAccess } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { SHARED_WORKSPACE_ROUTES } from "./shared-workspace.js";

const teamActor: Actor = {
  userId: "execution-user",
  requesterUserId: "alex",
  spaceId: "team-space",
  email: "alex@example.test",
  isDeploymentOwner: false,
  sharedBotIds: ["team-bot"],
  sharedCanSend: true,
  sharedGrantRevision: "grant-1",
};

function setup() {
  const findMany = vi.fn(async () => [
    { userId: "alex", member: { user: { name: "Alex" } } },
    { userId: "casey", member: { user: { name: "Casey" } } },
    { userId: "revoked", member: { user: { name: "Revoked" } } },
    { userId: "execution-user", member: { user: { name: "Executor" } } },
  ]);
  const resolve = vi.fn<SharedWorkspaceAccess["resolve"]>(async (subject) => {
    if (subject === "alex" || subject === "casey")
      return {
        executionUserId: "execution-user",
        botIds: ["team-bot"],
        revision: "grant-1",
        canSend: true,
        ...(subject === "casey" ? { approvalRevision: "approval-1" } : {}),
      };
    return null;
  });
  const deps = {
    prisma: { spaceMember: { findMany } } as unknown as PrismaClient,
    sharedWorkspaceAccess: { isSharedSpace: () => true, resolve },
    env: { defaultProvider: "fake", defaultModel: "fake-model" },
  } as unknown as RouterDeps;
  const client = createRouterClient(createRouter(deps), { context: { actor: teamActor } as never });
  return { client, findMany, resolve, deps };
}

describe("shared bot access roster", () => {
  it("lists only current native members with a fresh grant for this bot", async () => {
    const { client, findMany, resolve } = setup();
    await expect(client.spaces.accessMembers({ botId: "team-bot" })).resolves.toEqual([
      { id: "alex", name: "Alex", canApprove: false },
      { id: "casey", name: "Casey", canApprove: true },
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { spaceId: "team-space" } }),
    );
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(SHARED_WORKSPACE_ROUTES.has("spaces.accessMembers")).toBe(true);
    expect(SHARED_WORKSPACE_ROUTES.has("bots.create")).toBe(false);
  });

  it("fails closed when the permission source is unavailable", async () => {
    const { client, resolve } = setup();
    resolve.mockRejectedValue(new Error("authority unavailable"));
    await expect(client.spaces.accessMembers({ botId: "team-bot" })).rejects.toThrow();
  });

  it("rejects personal contexts and bots outside the current grant", async () => {
    const { deps, findMany } = setup();
    const personal = createRouterClient(createRouter(deps), {
      context: { actor: { ...teamActor, requesterUserId: undefined } } as never,
    });
    await expect(personal.spaces.accessMembers({ botId: "team-bot" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const shared = createRouterClient(createRouter(deps), {
      context: { actor: teamActor } as never,
    });
    await expect(shared.spaces.accessMembers({ botId: "other-bot" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(findMany).not.toHaveBeenCalled();
  });
});
