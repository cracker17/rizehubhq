import { Sidebar } from '@/components/Sidebar';
import { MobileNav } from '@/components/MobileNav';
import { Topbar } from '@/components/Topbar';
import { Toaster } from '@/components/Toaster';
import { NotCeo } from '@/components/NotCeo';
import { HqProvider } from '@/lib/data/store';
import { loadHq } from '@/lib/data/loaders';

// Data depends on env (DEMO/LIVE) and the session cookie, so always render per request.
export const dynamic = 'force-dynamic';

export default async function HqLayout({ children }: { children: React.ReactNode }) {
  const { session, snapshot, error } = await loadHq();
  if (session.mode === 'live' && session.user && !session.isCeo) return <NotCeo email={session.user.email} />;
  return (
    <HqProvider session={session} initial={snapshot} loadError={error}>
      <div className="flex min-h-screen">
        <Sidebar />
        <div className="mx-auto flex w-full min-w-0 max-w-[1680px] flex-col gap-4 px-4 pb-24 pt-4 sm:px-6 lg:gap-5 lg:pb-8 lg:pt-6">
          <Topbar />
          {error && (
            <p role="alert" className="item border-[color-mix(in_oklab,var(--color-danger)_50%,transparent)] px-4 py-3 text-sm text-[#ff8a8d]">
              Couldn&apos;t load everything from Supabase: {error}
            </p>
          )}
          <main className="flex min-w-0 flex-col gap-4 lg:gap-5">{children}</main>
        </div>
      </div>
      <MobileNav />
      <Toaster />
    </HqProvider>
  );
}
