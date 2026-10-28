import type { Actor, SharedWorkspaceAccess } from "@rakazo/contracts";

export async function sharedWorkspaceActor(
  actor: Actor,
  access?: SharedWorkspaceAccess,
): Promise<Actor | null> {
  if (!access?.isSharedSpace(actor.spaceId)) return actor.sharedWorkspaceRequired ? null : actor;
  const grant = await access.resolve(actor.userId, actor.spaceId);
  if (!grant) return null;
  return {
    ...actor,
    requesterUserId: actor.userId,
    userId: grant.executionUserId,
    sharedGrantRevision: grant.revision,
    sharedBotIds: grant.botIds,
    sharedCanSend: grant.canSend,
    sharedApprovalRevision: grant.approvalRevision,
  };
}

/** Small pilot surface; all other native features fail closed in a shared space. */
export const SHARED_WORKSPACE_ROUTES = new Set([
  "me",
  "bootstrap",
  "spaces.list",
  "spaces.accessMembers",
  "bots.list",
  "bots.get",
  "threads.head",
  "threads.get",
  "threads.messages",
  "threads.subscribe",
  "threads.send",
  "threads.answer",
  "threads.markRead",
  "threads.markUnread",
  "threads.stop",
  "routines.list",
  "models.list",
  "models.catalog",
  "models.roles",
]);
