'use client';
// Shared body of the error boundaries: a tab left open across a deploy reloads itself once (lib/staleDeploy.ts);
// any other crash shows a short message with Reload instead of Next's bare "Application error".
import { useEffect, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { isStaleDeployError, reloadOnce } from '@/lib/staleDeploy';

export function ErrorScreen({ error, reset }: { error: Error & { digest?: string }; reset?: () => void }) {
  const stale = isStaleDeployError(error);
  const [reloading, setReloading] = useState(stale);
  useEffect(() => {
    if (stale && !reloadOnce()) setReloading(false);
  }, [stale]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-4">
      <div className="card w-full max-w-md p-6 text-center sm:p-7" role="alert">
        <h1 className="text-lg font-semibold">{stale ? 'HQ was just updated' : 'Something went wrong'}</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          {reloading
            ? 'Loading the new version…'
            : stale
              ? 'This tab is still running the previous version. Reload to continue.'
              : 'This page hit an error. Reloading usually fixes it; nothing you approved was lost.'}
        </p>
        {!reloading && (
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <button type="button" onClick={() => window.location.reload()}
              className="inline-flex h-10 items-center gap-2 rounded-[10px] bg-[var(--color-primary)] px-4 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]">
              <RotateCw size={16} aria-hidden /> Reload
            </button>
            {reset && !stale && (
              <button type="button" onClick={reset}
                className="inline-flex h-10 items-center rounded-[10px] border border-[var(--color-line)] px-3.5 text-sm hover:border-[var(--color-line-active)]">
                Try again
              </button>
            )}
          </div>
        )}
        {error.digest && !reloading && <p className="mt-4 font-mono text-xs text-[var(--color-dim)]">Error id {error.digest}</p>}
      </div>
    </div>
  );
}
