/**
 * The brain's only way into the database: call one of the brain_* SQL functions (supabase/migrations/
 * 20260930010000_brain_index.sql). Every function takes named scalar/jsonb arguments and returns one scalar/jsonb value,
 * so the production store (supabase-js rpc) and the local PGlite store behave the same.
 */
export interface Store {
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T>;
  close?(): Promise<void>;
}
