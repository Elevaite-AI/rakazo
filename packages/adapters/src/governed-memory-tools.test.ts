import { describe, expect, it } from "vitest";
import {
  currentDecisionVisibility,
  nativeMemoryApproval,
  parseGovernedMemoryArgs,
} from "./governed-memory-tools.js";

describe("governed memory request boundary", () => {
  it("rejects model-supplied identity, approval and correction visibility", () => {
    const save = { content: "Approved decision", visibility: "shared" };
    for (const spoof of [
      { userId: "other" },
      { humanConfirmed: true },
      { sourceMessageId: "other" },
      { approval: {} },
    ]) {
      expect(() => parseGovernedMemoryArgs("save_decision", { ...save, ...spoof })).toThrow();
    }
    expect(() =>
      parseGovernedMemoryArgs("correct_decision", {
        factId: "fact",
        content: "Correction",
        reason: "Owner request",
        expectedRevision: 1,
        visibility: "shared",
      }),
    ).toThrow();
  });
  it("requires explicit visibility, bounded full wording and optimistic revision", () => {
    expect(() => parseGovernedMemoryArgs("save_decision", { content: "Fact" })).toThrow();
    expect(() =>
      parseGovernedMemoryArgs("save_decision", {
        content: "x".repeat(4001),
        visibility: "private",
      }),
    ).toThrow();
    expect(() =>
      parseGovernedMemoryArgs("correct_decision", {
        factId: "fact",
        content: "Fact",
        reason: "Reason",
        expectedRevision: 0,
      }),
    ).toThrow();
  });
  it("accepts correction visibility only on backend-bound approved replay", () => {
    expect(
      parseGovernedMemoryArgs(
        "correct_decision",
        {
          factId: "fact",
          content: "Updated",
          reason: "Reason",
          expectedRevision: 2,
          visibility: "private",
          audienceKey: "owner-scope",
          audienceLabel: "Owner only",
        },
        true,
      ),
    ).toMatchObject({ visibility: "private", expectedRevision: 2 });
  });
});

describe("native owner approval proof", () => {
  const proof = {
    approval: {
      effectId: "effect",
      runId: "run",
      approverUserId: "owner",
      approvedAt: "2026-01-01T00:00:00.000Z",
      kind: "native-owner-approval",
    },
  };
  const expected = { effectId: "effect", runId: "run", userId: "owner" };
  it("requires authenticated proof matching the effect, owner and run", () => {
    expect(nativeMemoryApproval(proof, expected)).toMatchObject({
      effectId: "effect",
      approverUserId: "owner",
    });
    for (const changes of [{ effectId: "other" }, { runId: "other" }, { userId: "other" }])
      expect(() => nativeMemoryApproval(proof, { ...expected, ...changes })).toThrow();
    expect(() => nativeMemoryApproval({ humanConfirmed: true }, expected)).toThrow();
    expect(() => nativeMemoryApproval(undefined, expected)).toThrow();
  });
});

describe("correction preflight", () => {
  const current = {
    revision: 2,
    state: "current",
    visibility: "private",
    editable: true,
    audienceKey: "owner-scope",
    audienceLabel: "Owner only",
  };
  it("takes visibility from live authorised history and refuses stale/unowned facts", () => {
    expect(currentDecisionVisibility({ revisions: [current] }, 2)).toBe("private");
    expect(() => currentDecisionVisibility({ revisions: [current] }, 1)).toThrow();
    expect(() =>
      currentDecisionVisibility({ revisions: [{ ...current, editable: false }] }, 2),
    ).toThrow();
    expect(() => currentDecisionVisibility({ revisions: [] }, 2)).toThrow();
    expect(() =>
      currentDecisionVisibility(
        { revisions: [current, { ...current, revision: 3, state: "pending" }] },
        2,
      ),
    ).toThrow();
  });
});
