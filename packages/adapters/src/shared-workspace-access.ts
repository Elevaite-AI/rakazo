import type { PrismaClient } from "@rakazo/db";
import { readFile, lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { request } from "node:http";
import type { SharedWorkspaceAccess, SharedWorkspaceGrant } from "@rakazo/contracts";

/** The native application has an HTTP decision token, never an ORB database login. */
export class SharedWorkspaceDecisionAccess implements SharedWorkspaceAccess {
  private readonly endpoint: URL;
  constructor(
    url: string,
    private readonly token: string,
    private readonly spaces: ReadonlySet<string>,
    private readonly socketPath?: string,
  ) {
    try {
      this.endpoint = new URL(url);
    } catch {
      throw new Error("Invalid permission decision endpoint");
    }
    if (
      this.endpoint.pathname !== "/v1/resolve" ||
      this.endpoint.search ||
      this.endpoint.hash ||
      this.endpoint.username ||
      this.endpoint.password ||
      (this.endpoint.protocol !== "https:" &&
        !(this.endpoint.protocol === "http:" && this.endpoint.hostname === "127.0.0.1")) ||
      (socketPath !== undefined &&
        (!isAbsolute(socketPath) ||
          socketPath.includes("\0") ||
          Buffer.byteLength(socketPath) > 100 ||
          this.endpoint.protocol !== "http:" ||
          this.endpoint.hostname !== "127.0.0.1")) ||
      !/^[a-f0-9]{64}$/.test(token)
    )
      throw new Error("Invalid permission decision endpoint");
  }
  isSharedSpace(spaceId: string) {
    return this.spaces.has(spaceId);
  }
  async resolve(subject: string, spaceId: string): Promise<SharedWorkspaceGrant | null> {
    if (!this.isSharedSpace(spaceId)) return null;
    const send = this.socketPath
      ? (url: URL, options: RequestInit) => requestDecisionSocket(this.socketPath!, url, options)
      : fetch;
    const response = await send(this.endpoint, {
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

function requestDecisionSocket(
  socketPath: string,
  url: URL,
  options: RequestInit,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: url.pathname,
        method: "POST",
        headers: options.headers as Record<string, string>,
        signal: options.signal ?? undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 16384) {
            reject(new Error("Invalid permission decision"));
            res.destroy();
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.once("aborted", () => reject(new Error("Permission authority unavailable")));
        res.on("error", () => reject(new Error("Permission authority unavailable")));
        res.on("end", () => {
          try {
            resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 503 }));
          } catch {
            reject(new Error("Invalid permission decision"));
          }
        });
      },
    );
    req.on("error", () => reject(new Error("Permission authority unavailable")));
    req.end(options.body);
  });
}

/** Optional deployment adapter. A missing file or malformed config never falls back. */
export async function loadSharedWorkspaceAccess(
  source: NodeJS.ProcessEnv = process.env,
): Promise<SharedWorkspaceAccess | undefined> {
  const filename = source.RAKAZO_SHARED_WORKSPACE_CONFIG;
  if (!filename) return undefined;
  if (!isAbsolute(filename)) throw new Error("Absolute shared workspace config path required");
  if (typeof process.getuid !== "function")
    throw new Error("A POSIX secret mount is required for shared workspace configuration");
  const info = await lstat(filename).catch(() => {
    throw new Error("Shared workspace configuration unavailable");
  });
  if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077)
    throw new Error("Private application-owned shared workspace config required");
  let config;
  try {
    config = JSON.parse(await readFile(filename, "utf8"));
  } catch {
    throw new Error("Invalid shared workspace configuration");
  }
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.keys(config).some((key) => !["url", "token", "spaces", "socketPath"].includes(key)) ||
    !Array.isArray(config.spaces) ||
    config.spaces.length !== 1 ||
    config.spaces.some(
      (space: unknown) => typeof space !== "string" || !space || space.length > 100,
    )
  )
    throw new Error("Invalid shared workspace config");
  return new SharedWorkspaceDecisionAccess(
    config.url,
    config.token,
    new Set(config.spaces),
    config.socketPath,
  );
}

/** Native membership and external authority are both required, on every check. */
export function bindSharedWorkspaceMembership(
  prisma: Pick<PrismaClient, "spaceMember">,
  authority?: SharedWorkspaceAccess,
): SharedWorkspaceAccess | undefined {
  if (!authority) return undefined;
  return {
    isSharedSpace: (spaceId) => authority.isSharedSpace(spaceId),
    async resolve(userId, spaceId) {
      if (!authority.isSharedSpace(spaceId)) return null;
      const grant = await authority.resolve(userId, spaceId);
      if (!grant) return null;
      const member = await prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId, userId } },
        select: { id: true, createdAt: true },
      });
      if (!member) return null;
      // Recreated native membership is a new grant, including an off/on toggle
      // between observations. The canonical approval permission stays external.
      return {
        ...grant,
        revision: JSON.stringify([grant.revision, member.id, member.createdAt.toISOString()]),
      };
    },
  };
}
