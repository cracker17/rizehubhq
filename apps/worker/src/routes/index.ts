// Extra HTTP routes; each module owns its own file.
import type { Route } from './types';
import { vaultRoutes } from './vault';
import { rizehubRoutes } from './rizehub';
import { mcpRoutes } from './mcp';
import { salesRoutes } from './sales';

export const EXTRA_ROUTES: Route[] = [...vaultRoutes, ...rizehubRoutes, ...mcpRoutes, ...salesRoutes];
