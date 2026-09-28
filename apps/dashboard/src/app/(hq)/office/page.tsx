import type { Metadata } from 'next';
import { FullscreenOffice } from '@/components/office/FullscreenOffice';

export const metadata: Metadata = { title: 'Office · RizeHub HQ' };

export default function OfficeFullPage() {
  return <FullscreenOffice />;
}
