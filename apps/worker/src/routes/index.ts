// Extra HTTP routes; each module owns its own file.
import type { Route } from './types';
import { vaultRoutes } from './vault';
import { rizehubRoutes } from './rizehub';

export const EXTRA_ROUTES: Route[] = [...vaultRoutes, ...rizehubRoutes];
