import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";

export class IsolationError extends Error {
  constructor(message = "Resource not found") {
    super(message);
    this.name = "IsolationError";
  }
}

/** Unique (spaceId, userId, name) collision when renaming a bot section. */
export class BotSectionNameConflictError extends Error {
  constructor(message = "Section name already used") {
    super(message);
    this.name = "BotSectionNameConflictError";
  }
}

/** Organisation metadata is administered server-side; generic org routes are disabled. */
export function requiresSharedWorkspaceAuthority(metadata?: string | null): boolean {
  if (!metadata) return false;
  let value: unknown;
  try {
    value = JSON.parse(metadata);
  } catch {
    throw new IsolationError();
  }
  if (value === null) return false;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  if (!("sharedWorkspaceAuthority" in value)) return false;
  if (value.sharedWorkspaceAuthority !== "external") throw new IsolationError();
  return true;
}

export async function requireMembership(
  prisma: PrismaClient,
  userId: string,
  requestedSpaceId?: string | null,
): Promise<Actor> {
  const membership = await prisma.spaceMember.findFirst({
    where: {
      userId,
      ...(requestedSpaceId ? { spaceId: requestedSpaceId } : {}),
    },
    orderBy: [{ space: { isDefault: "desc" } }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      userId: true,
      spaceId: true,
      member: { select: { user: { select: { email: true } } } },
      space: { select: { organization: { select: { metadata: true } } } },
    },
  });
  if (!membership) {
    throw new IsolationError("No personal space");
  }
  return {
    userId: membership.userId,
    spaceId: membership.spaceId,
    email: membership.member.user.email,
    isDeploymentOwner: false,
    ...(requiresSharedWorkspaceAuthority(membership.space?.organization?.metadata)
      ? { sharedWorkspaceRequired: true }
      : {}),
  };
}

export function scoped<T extends { spaceId: string; userId?: string }>(
  actor: Actor,
  record: T | null,
): T {
  if (!record || record.spaceId !== actor.spaceId) {
    throw new IsolationError();
  }
  if (record.userId && record.userId !== actor.userId) {
    throw new IsolationError();
  }
  return record;
}
