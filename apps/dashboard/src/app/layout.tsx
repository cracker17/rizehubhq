import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Sidebar } from '@/components/Sidebar';
import { MobileNav } from '@/components/MobileNav';
import { Topbar } from '@/components/Topbar';

export const metadata: Metadata = {
  title: 'RizeHub HQ',
  description: 'AI virtual office: your AI team, approvals and daily reports in one place.',
};
export const viewport: Viewport = { themeColor: '#0b0a1f', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" />
      </head>
      <body>
        <div className="flex min-h-screen">
          <Sidebar />
          <div className="mx-auto flex w-full min-w-0 max-w-[1680px] flex-col gap-4 px-4 pb-24 pt-4 sm:px-6 lg:gap-5 lg:pb-8 lg:pt-6">
            <Topbar />
            <main className="flex min-w-0 flex-col gap-4 lg:gap-5">{children}</main>
          </div>
        </div>
        <MobileNav />
      </body>
    </html>
  );
}
