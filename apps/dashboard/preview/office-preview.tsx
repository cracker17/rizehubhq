// Standalone DEMO build of the isometric office (no Next.js server). Built by preview/build.mjs.
import { createRoot } from 'react-dom/client';
import { HqProvider } from '@/lib/data/store';
import { demoSnapshot } from '@/lib/mock';
import { FullscreenOffice } from '@/components/office/FullscreenOffice';
import { Toaster } from '@/components/Toaster';

const session = { mode: 'demo', supabase: null, user: null, isCeo: true, chatLive: false } as const;
createRoot(document.getElementById('root')!).render(
  <HqProvider session={session as never} initial={demoSnapshot()} loadError={undefined}>
    <FullscreenOffice />
    <Toaster />
  </HqProvider>,
);
