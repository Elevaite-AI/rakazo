import type {
  SharedWorkspaceAccess,
  SharedWorkspaceGrant,
} from "../../../packages/contracts/src/shared-workspace.js";

/** The native application has an HTTP decision token, never an ORB database login. */
export class OrbDecisionAccess implements SharedWorkspaceAccess {
  private readonly endpoint: URL;
  constructor(
    url: string,
    private readonly token: string,
    private readonly spaces: ReadonlySet<string>,
  ) {
    this.endpoint = new URL(url);
    if (
      this.endpoint.pathname !== "/v1/resolve" ||
      this.endpoint.search ||
      this.endpoint.hash ||
      this.endpoint.username ||
      this.endpoint.password ||
      (this.endpoint.protocol !== "https:" &&
        !(this.endpoint.protocol === "http:" && this.endpoint.hostname === "127.0.0.1")) ||
      !/^[a-f0-9]{64}$/.test(token)
    )
      throw new Error("Invalid permission decision endpoint");
  }
  isSharedSpace(spaceId: string) {
    return this.spaces.has(spaceId);
  }
  async resolve(subject: string, spaceId: string): Promise<SharedWorkspaceGrant | null> {
    if (!this.isSharedSpace(spaceId)) return null;
    const response = await fetch(this.endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ subject, spaceId }),
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) throw new Error("Permission authority unavailable");
    const body = await response.json();
    if (body.grant === null) return null;
    const g = body.grant;
    if (
      !g ||
      typeof g.executionUserId !== "string" ||
      !g.executionUserId ||
      typeof g.revision !== "string" ||
      !g.revision ||
      g.canSend !== true ||
      !Array.isArray(g.botIds) ||
      g.botIds.length !== 1 ||
      typeof g.botIds[0] !== "string" ||
      !g.botIds[0] ||
      (g.approvalRevision !== undefined &&
        (typeof g.approvalRevision !== "string" || !g.approvalRevision))
    )
      throw new Error("Invalid permission decision");
    return {
      executionUserId: g.executionUserId,
      revision: g.revision,
      botIds: g.botIds,
      canSend: true,
      ...(g.approvalRevision ? { approvalRevision: g.approvalRevision } : {}),
    };
  }
}
