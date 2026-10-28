import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { governedMemoryFromEnv, HttpGovernedMemoryProvider } from "./governed-memory-client.js";

const context = {
  userId: "owner",
  spaceId: "workspace",
  agentId: "agent",
  agentLabel: "Assistant",
};
const resolver = async () => [{ address: "203.0.113.10", family: 4 }];
const endpoint = "https://memory.example.test/workflow";
const credential = "example-deployment-credential";
function provider(fetch: typeof globalThis.fetch) {
  return new HttpGovernedMemoryProvider(endpoint, credential, {
    network: { fetch, resolveHostname: resolver },
  });
}

describe("governed memory HTTP boundary", () => {
  it("is disabled without configuration and rejects partial configuration", () => {
    expect(governedMemoryFromEnv({})).toBeUndefined();
    expect(() => governedMemoryFromEnv({ MEMORY_WORKFLOW_URL: endpoint })).toThrow(/both/);
    expect(() => governedMemoryFromEnv({ MEMORY_WORKFLOW_TOKEN: credential })).toThrow(/both/);
  });
  it("sends trusted identity and only the source text hash", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "ok", enrolled: false }));
    const signal = new AbortController().signal;
    await provider(fetch).execute(
      "status",
      {},
      { ...context, signal, sourceText: "original input" },
    );
    const [url, init] = fetch.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(String(url)).toBe(endpoint);
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${credential}`);
    const sent = new TextDecoder().decode(init.body as ArrayBuffer);
    const body = JSON.parse(sent);
    expect(body.context).toEqual({
      ...context,
      sourceTextHash: createHash("sha256").update("original input").digest("hex"),
    });
    expect(sent).not.toContain("original input");
    expect(body.context).not.toHaveProperty("signal");
    expect(init.redirect).toBe("manual");
  });
  it("keeps credentials on explicitly opted-in local HTTP only", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "ok" }));
    const local = new HttpGovernedMemoryProvider("http://127.0.0.1:9000/workflow", credential, {
      allowPrivateEndpoint: true,
      network: { fetch },
    });
    await local.execute("status", {}, context);
    const [, init] = fetch.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${credential}`);
    expect(
      () =>
        new HttpGovernedMemoryProvider("http://public.example.test/workflow", credential, {
          allowPrivateEndpoint: true,
        }),
    ).toThrow(/HTTPS/);
    expect(
      () => new HttpGovernedMemoryProvider("http://127.0.0.1:9000/workflow", credential),
    ).toThrow();
  });
  it("refuses credential-bearing URLs and redirects", async () => {
    expect(
      () =>
        new HttpGovernedMemoryProvider(
          "https://user:password@memory.example.test/workflow",
          credential,
        ),
    ).toThrow();
    expect(() => new HttpGovernedMemoryProvider(`${endpoint}?token=secret`, credential)).toThrow();
    const fetch = vi.fn(
      async () =>
        new Response(null, { status: 307, headers: { location: "https://other.example.test/" } }),
    );
    await expect(provider(fetch).execute("status", {}, context)).rejects.toThrow(
      /could not be verified/,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not expose upstream error bodies, credentials or network errors", async () => {
    const upstream = vi.fn(
      async () => new Response(`private source ${credential}`, { status: 403 }),
    );
    await expect(provider(upstream).execute("search", {}, context)).rejects.toThrow(
      /^Memory could not be verified/,
    );
    const fetch = vi.fn(async () => {
      throw new Error(`network logged ${credential}`);
    });
    await expect(provider(fetch).execute("search", {}, context)).rejects.toThrow(
      /^Memory could not be verified/,
    );
  });
  it("reports revision conflicts without copying the remote body", async () => {
    const fetch = vi.fn(async () => new Response("untrusted details", { status: 409 }));
    await expect(provider(fetch).execute("publish", {}, context)).rejects.toThrow(
      /changed.*latest revision/,
    );
  });
  it("rejects malformed or oversized evidence instead of returning an empty result", async () => {
    await expect(
      provider(vi.fn(async () => new Response("not JSON"))).execute("search", {}, context),
    ).rejects.toThrow(/could not be verified/);
    await expect(
      provider(vi.fn(async () => Response.json([]))).execute("search", {}, context),
    ).rejects.toThrow(/could not be verified/);
    await expect(
      provider(vi.fn(async () => new Response("x".repeat(1024 * 1024 + 1)))).execute(
        "search",
        {},
        context,
      ),
    ).rejects.toThrow(/could not be verified/);
  });
  it("keeps caller deadlines bounded even when a network adapter ignores cancellation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => undefined));
    const controller = new AbortController();
    const result = provider(fetch).execute("status", {}, { ...context, signal: controller.signal });
    const rejected = expect(result).rejects.toThrow(/could not be verified/);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort(new Error("private cancellation detail"));
    await rejected;
  });
  it("cancels a stalled response body on the caller deadline", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetch = vi.fn(async () => new Response(body));
    const controller = new AbortController();
    const result = provider(fetch).execute("status", {}, { ...context, signal: controller.signal });
    const rejected = expect(result).rejects.toThrow(/could not be verified/);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("blocks DNS rebinding into a private network by default", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "ok" }));
    const client = new HttpGovernedMemoryProvider(endpoint, credential, {
      network: { fetch, resolveHostname: async () => [{ address: "127.0.0.1", family: 4 }] },
    });
    await expect(client.execute("status", {}, context)).rejects.toThrow(/could not be verified/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
