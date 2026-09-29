'use client';
import { ErrorScreen } from '@/components/ErrorScreen';

// Errors inside the signed-in app: the sidebar and top bar stay, the page area shows ErrorScreen.
export default function HqError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorScreen error={error} reset={reset} />;
}
