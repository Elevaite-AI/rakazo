/** Trusted execution context. None of these identity/approval fields come from tool arguments. */
export interface GovernedMemoryContext {
  userId: string;
  userLabel?: string;
  spaceId: string;
  agentId: string;
  agentLabel: string;
  runId?: string;
  threadId?: string;
  sourceMessageId?: string;
  sourceText?: string;
  sourceTextHash?: string;
  sourceRecordedAt?: string;
  signal?: AbortSignal;
  approval?: {
    effectId: string;
    approverUserId: string;
    approvedAt: string;
    kind: "native-owner-approval";
  };
}

export type GovernedMemoryOperation = "publish" | "search" | "history" | "status";

/** Optional deployment connection; publication must be idempotent by approval.effectId. */
export interface GovernedMemoryProvider {
  execute(
    operation: GovernedMemoryOperation,
    request: Record<string, unknown>,
    context: GovernedMemoryContext,
  ): Promise<unknown>;
}
