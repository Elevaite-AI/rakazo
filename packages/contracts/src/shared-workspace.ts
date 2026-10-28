/** Server-side capability source. Never accept these grants from a client. */
export interface SharedWorkspaceGrant {
  executionUserId: string;
  botIds: string[];
  revision: string;
  canSend: boolean;
  /** Independent, versioned permission to approve individual shared actions. */
  approvalRevision?: string;
}

export interface SharedWorkspaceAccess {
  isSharedSpace(spaceId: string): boolean;
  resolve(requesterUserId: string, spaceId: string): Promise<SharedWorkspaceGrant | null>;
}
