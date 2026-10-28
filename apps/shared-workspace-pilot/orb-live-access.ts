import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { SharedWorkspaceAccess } from "../../../packages/contracts/src/shared-workspace.js";
import type { WorkspaceBinding } from "./orb-access.js";

type Member = {
  id: string;
  user_id: string;
  is_active: boolean;
  employment_status: string;
  ended_at: string | null;
  updated_at: string;
  agent_access: {
    id: string;
    agent_id: string;
    agent_type: string;
    has_access: boolean;
    created_at: string;
  }[];
};
/** Read-only live directory. Local rows bind identities/resources; they never grant access. */
export class OrbLiveAccess implements SharedWorkspaceAccess {
  readonly bindings = new Map<string, WorkspaceBinding>();
  constructor(
    private readonly pool: Pool,
    private readonly options: {
      url: string;
      key: string;
      fetch?: typeof fetch;
      timeoutMs?: number;
    },
  ) {
    const url = new URL(options.url);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/") {
      throw new Error("Live ORB requires an HTTPS project origin");
    }
  }
  isSharedSpace(spaceId: string) {
    return this.bindings.has(spaceId);
  }
  async resolve(requesterUserId: string, spaceId: string) {
    const binding = this.bindings.get(spaceId);
    if (!binding) return null;
    const { rows } = await this.pool.query<{ canonical_id: string }>(
      `
      SELECT COALESCE(a.canonical_profile_id,i.profile_id) AS canonical_id
      FROM orb_stage.rakazo_identities i
      LEFT JOIN orb_stage.identity_aliases a ON a.alias_profile_id=i.profile_id
      WHERE i.rakazo_user_id=$1`,
      [requesterUserId],
    );
    if (rows.length !== 1) return null;
    const canonical = rows[0].canonical_id;
    const url = new URL("/rest/v1/team_member", this.options.url);
    url.searchParams.set("user_id", `eq.${canonical}`);
    url.searchParams.set(
      "select",
      "id,user_id,is_active,employment_status,ended_at,updated_at,agent_access(id,agent_id,agent_type,has_access,created_at)",
    );
    const response = await (this.options.fetch ?? fetch)(url, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      headers: { apikey: this.options.key, Authorization: `Bearer ${this.options.key}` },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 2000),
    });
    if (!response.ok) throw new Error(`ORB permission lookup failed (${response.status})`);
    const members: Member[] = await response.json();
    if (!Array.isArray(members) || members.length !== 1) return null;
    const member = members[0];
    if (
      member.user_id !== canonical ||
      member.is_active !== true ||
      member.employment_status !== "active" ||
      member.ended_at !== null
    )
      return null;
    if (!Array.isArray(member.agent_access)) return null;
    const grants = member.agent_access.filter(
      (g) =>
        g.agent_id === binding.orbAgentId &&
        g.agent_type === "rakazo-staging" &&
        g.has_access === true,
    );
    if (grants.length !== 1) return null;
    // Content fingerprint, not an authoritative mutation sequence. Production needs a
    // versioned export to detect revoke/regrant transitions between observations.
    const revision = createHash("sha256")
      .update(JSON.stringify([member.id, member.updated_at, grants[0]]))
      .digest("hex");
    return {
      executionUserId: binding.executionUserId,
      botIds: [binding.botId],
      canSend: true,
      revision,
    };
  }
}
