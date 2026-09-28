import type { Route } from './types';
import { createRizehubWebhookHandler } from '../rizehub/webhookRoute';

/** RizeHub → HQ webhooks (docs/12 "Webhooks"). Signed with X-RizeHub-Signature; see rizehub/webhookRoute.ts. */
export const rizehubRoutes: Route[] = [
  { method: 'POST', path: '/hooks/rizehub', auth: 'self', handle: createRizehubWebhookHandler() },
];
