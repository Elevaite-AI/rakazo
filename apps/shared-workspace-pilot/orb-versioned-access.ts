import type { Pool } from "pg";
import type { SharedWorkspaceAccess } from "../../../packages/contracts/src/shared-workspace.js";

/** Scoped authority connection. No table reads, directory key, or cross-request cache. */
export class OrbVersionedAccess implements SharedWorkspaceAccess {
  constructor(
    private readonly pool: Pool,
    private readonly spaces: ReadonlySet<string>,
    private readonly approvals = false,
  ) {}
  isSharedSpace(spaceId: string) {
    return this.spaces.has(spaceId);
  }
  async resolve(subject: string, spaceId: string) {
    if (!this.isSharedSpace(spaceId)) return null;
    const { rows } = await this.pool.query<{
      execution_user_id: string;
      bot_id: string;
      revision: string;
      approval_revision?: string;
    }>(
      this.approvals
        ? "SELECT * FROM permission_authority.resolve_with_approval($1,$2)"
        : "SELECT * FROM permission_authority.resolve($1,$2)",
      [subject, spaceId],
    );
    if (rows.length !== 1) return null;
    const row = rows[0];
    if (!row.execution_user_id || !row.bot_id || !row.revision) return null;
    return {
      executionUserId: row.execution_user_id,
      botIds: [row.bot_id],
      revision: row.revision,
      canSend: true,
      ...(row.approval_revision ? { approvalRevision: row.approval_revision } : {}),
    };
  }
}
