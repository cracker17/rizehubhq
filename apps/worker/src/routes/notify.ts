import type { Route } from './types';
import { createNotifyHandler, NOTIFY_MAX_BODY } from '../notify/externalAlerts';

/** Other apps → HQ alerts (Hushdesk first). Signed with X-HQ-Signature; see notify/externalAlerts.ts. */
export const notifyRoutes: Route[] = [
  { method: 'POST', path: '/hooks/notify', auth: 'self', maxBody: NOTIFY_MAX_BODY, handle: createNotifyHandler() },
];
