import { createContext, useContext } from "react";

/** Server-declared UI capabilities; the API independently enforces every operation. */
export const ConversationOnlyContext = createContext(false);
export const SharedApproverContext = createContext(false);
export const useSharedApprover = () => useContext(SharedApproverContext);
export const useConversationOnly = () => useContext(ConversationOnlyContext);
