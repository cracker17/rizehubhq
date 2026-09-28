import type { Route } from './types';
import { workerEnv } from '../config';
import { listRoleIds } from '../roles';
import { createHqMcpRoutes, getMcpDeps } from '../hermes/mcp';
import { mcpTokenMap } from '../hermes/config';

let roleIds: string[] | null = null;

/** HQ MCP tool server for Hermes agents (POST /mcp, Bearer HQ_MCP_TOKEN_<AGENT>); see hermes/mcp.ts. */
export const mcpRoutes: Route[] = createHqMcpRoutes({
  deps: getMcpDeps,
  tokens: () => mcpTokenMap((roleIds ??= listRoleIds()), workerEnv()),
});
