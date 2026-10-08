// Extra HTTP routes; each module owns its own file.
import type { Route } from './types';
import { vaultRoutes } from './vault';
import { rizehubRoutes } from './rizehub';
import { mcpRoutes } from './mcp';
import { salesRoutes } from './sales';
import { transcribeRoutes } from './transcribe';
import { connectorRoutes } from './connectors';
import { mcpConnectorRoutes } from './mcpConnectors';
import { storageConnectorRoutes } from './storageConnectors';
import { ceoEmailRoutes } from './ceoEmail';

export const EXTRA_ROUTES: Route[] = [...vaultRoutes, ...rizehubRoutes, ...mcpRoutes, ...salesRoutes, ...transcribeRoutes, ...connectorRoutes, ...mcpConnectorRoutes, ...storageConnectorRoutes, ...ceoEmailRoutes];
