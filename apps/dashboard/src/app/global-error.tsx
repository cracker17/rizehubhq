'use client';
import './globals.css';
import { ErrorScreen } from '@/components/ErrorScreen';

// Last-resort boundary (errors in the root layout itself): replaces the whole document.
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body>
        <ErrorScreen error={error} />
      </body>
    </html>
  );
}
