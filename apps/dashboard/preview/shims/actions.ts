// Server actions are not available in the static preview; demo mode never calls them.
const off = async () => { throw new Error('Not available in the static preview'); };
export const askAgentAction = off, createRequestAction = off, decideApprovalAction = off, refreshSnapshotAction = off;
export const signOutAction = off, signInAction = off;
