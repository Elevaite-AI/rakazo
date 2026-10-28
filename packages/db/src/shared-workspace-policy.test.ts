import { describe, expect, it } from "vitest";
import { IsolationError, requiresSharedWorkspaceAuthority } from "./scope.js";

describe("persisted workspace authority classification", () => {
  it("preserves personal organisations and recognises the explicit external policy", () => {
    expect(requiresSharedWorkspaceAuthority(null)).toBe(false);
    expect(requiresSharedWorkspaceAuthority("[]")).toBe(false);
    expect(requiresSharedWorkspaceAuthority('{"other":"metadata"}')).toBe(false);
    expect(requiresSharedWorkspaceAuthority('{"sharedWorkspaceAuthority":"external"}')).toBe(true);
  });
  it("fails closed for malformed or unknown policies", () => {
    for (const value of [
      '{"sharedWorkspaceAuthority":',
      '{"sharedWorkspaceAuthority":false}',
      '{"sharedWorkspaceAuthority":0}',
    ])
      expect(() => requiresSharedWorkspaceAuthority(value)).toThrow(IsolationError);
  });
});
