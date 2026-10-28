import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type {
  GovernedMemoryContext,
  GovernedMemoryOperation,
  GovernedMemoryProvider,
} from "@rakazo/adapter-kit";
import { cancelResponseBody, readBoundedJsonResponse } from "@rakazo/core";
import { secureFetch, validateUrl } from "./mcp-transport.js";
import { isPrivateNetworkHost } from "@rakazo/contracts";
import type { RemoteTransportDependencies } from "./remote-mcp.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 128 * 1024;

export class GovernedMemoryRequestError extends Error {
  constructor(readonly status?: number) {
    super(
      status === 409
        ? "This decision changed. Read its latest revision and submit a new proposal."
        : "Memory could not be verified. Check the connection before relying on a saved decision.",
    );
    this.name = "GovernedMemoryRequestError";
  }
}

async function awaitWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new GovernedMemoryRequestError();
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new GovernedMemoryRequestError());
    };
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** The deployment endpoint is trusted configuration, never an agent-supplied URL. */
export class HttpGovernedMemoryProvider implements GovernedMemoryProvider {
  private readonly endpoint: URL;
  private readonly authorization: string;
  private readonly request: typeof globalThis.fetch;

  constructor(
    endpoint: string,
    token: string,
    options: { allowPrivateEndpoint?: boolean; network?: RemoteTransportDependencies } = {},
  ) {
    if (!token.trim() || /\s/.test(token)) throw new Error("Invalid memory workflow credential");
    const policy = {
      allowPrivateEndpoint: options.allowPrivateEndpoint === true,
      allowHttpLocalhost: options.allowPrivateEndpoint === true,
      allowLocalHttpCredentials: options.allowPrivateEndpoint === true,
    };
    this.endpoint = validateUrl(endpoint, policy);
    this.authorization = `Bearer ${token}`;
    if (this.endpoint.search) throw new Error("Memory workflow URL must not contain a query");
    const hostname = this.endpoint.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (
      this.endpoint.protocol === "http:" &&
      !(
        options.allowPrivateEndpoint === true &&
        (hostname === "localhost" ||
          hostname.endsWith(".localhost") ||
          (isIP(hostname) !== 0 && isPrivateNetworkHost(hostname)))
      )
    ) {
      throw new Error("Memory workflow credentials require HTTPS or an opted-in private address");
    }
    this.request = secureFetch(
      this.endpoint,
      policy,
      { headers: { authorization: `Bearer ${token}` } },
      options.network,
    );
  }

  async execute(
    operation: GovernedMemoryOperation,
    request: Record<string, unknown>,
    context: GovernedMemoryContext,
  ): Promise<unknown> {
    const { signal, sourceText, ...trustedContext } = context;
    const body = JSON.stringify({
      operation,
      request,
      context: {
        ...trustedContext,
        ...(sourceText === undefined
          ? {}
          : { sourceTextHash: createHash("sha256").update(sourceText).digest("hex") }),
      },
    });
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new GovernedMemoryRequestError();
    const boundedSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000);
    try {
      if (boundedSignal.aborted) throw new GovernedMemoryRequestError();
      const response = await awaitWithAbort(
        this.request(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "user-agent": "Rakazo-memory-workflow/1.0",
            authorization: this.authorization,
          },
          body,
          signal: boundedSignal,
        }),
        boundedSignal,
      );
      if (!response.ok) {
        cancelResponseBody(response);
        throw new GovernedMemoryRequestError(response.status);
      }
      const result = await readBoundedJsonResponse<unknown>(
        response,
        MAX_RESPONSE_BYTES,
        boundedSignal,
      );
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new GovernedMemoryRequestError();
      }
      return result;
    } catch (error) {
      // Upstream bodies, DNS errors and URLs can contain credentials or private evidence.
      if (error instanceof GovernedMemoryRequestError) throw error;
      throw new GovernedMemoryRequestError();
    }
  }
}

export function governedMemoryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GovernedMemoryProvider | undefined {
  const endpoint = env.MEMORY_WORKFLOW_URL?.trim();
  const token = env.MEMORY_WORKFLOW_TOKEN?.trim();
  if (!endpoint && !token) return undefined;
  if (!endpoint || !token) throw new Error("Configure both memory workflow URL and credential");
  return new HttpGovernedMemoryProvider(endpoint, token, {
    allowPrivateEndpoint: env.MEMORY_WORKFLOW_ALLOW_PRIVATE_ENDPOINT === "true",
  });
}
