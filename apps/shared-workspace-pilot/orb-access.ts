import type { Pool } from "pg";
import type { SharedWorkspaceAccess } from "../../../packages/contracts/src/shared-workspace.js";

export type WorkspaceBinding = { executionUserId: string; botId: string; orbAgentId: string };

/** Staging ORB permission projection. No production credentials or directory writes. */
export class OrbStagingAccess implements SharedWorkspaceAccess {
  readonly bindings = new Map<string, WorkspaceBinding>();
  constructor(private readonly pool: Pool) {}
  isSharedSpace(spaceId: string) {
    return this.bindings.has(spaceId);
  }
  async resolve(requesterUserId: string, spaceId: string) {
    const binding = this.bindings.get(spaceId);
    if (!binding) return null;
    const { rows } = await this.pool.query<{
      id: string;
      version: number;
      has_access: boolean;
    }>(
      `
      SELECT a.id,a.has_access,v.version
      FROM orb_stage.rakazo_identities i
      JOIN orb_stage.profiles p ON p.id=i.profile_id
      LEFT JOIN orb_stage.identity_aliases alias ON alias.alias_profile_id=p.id
      JOIN orb_stage.team_member t ON t.user_id=COALESCE(alias.canonical_profile_id,p.id)
      JOIN orb_stage.agent_access a ON a.team_member_id=t.id AND a.agent_id=$2
      JOIN orb_stage.grant_versions v ON v.grant_id=a.id
      WHERE i.rakazo_user_id=$1 AND t.is_active AND t.employment_status='active'
        AND t.ended_at IS NULL AND a.has_access
    `,
      [requesterUserId, binding.orbAgentId],
    );
    if (rows.length !== 1) return null;
    return {
      executionUserId: binding.executionUserId,
      botIds: [binding.botId],
      canSend: true,
      revision: `${rows[0].id}:${rows[0].version}`,
    };
  }
}
