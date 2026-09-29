// /api/connectors/callback is shared by MCP app sign-ins and storage sign-ins (Google Drive / Dropbox, docs/15 §6).
// The worker starts storage sign-ins with a "st_" state, so the state alone says which worker route finishes it.
import { isStorageState } from '@rizehubhq/shared';

export type CallbackKind = 'storage' | 'mcp';

export function callbackTarget(state: string): { kind: CallbackKind; path: string } {
  return isStorageState(state)
    ? { kind: 'storage', path: '/connectors/storage/finish' }
    : { kind: 'mcp', path: '/connectors/mcp/finish' };
}

/** Query params for Admin → Connectors after a finished sign-in (MCP keeps its `connected` param: opens the tool review). */
export function callbackSuccessParams(kind: CallbackKind, id: string): Record<string, string> {
  return kind === 'storage' ? { storageConnected: id } : { connected: id };
}
