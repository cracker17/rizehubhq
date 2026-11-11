'use client';
import { useRouter } from 'next/navigation';
import { MemberTotp } from '@/components/brain/MemberTotp';

export function MemberTwoFactor() {
  const router = useRouter();
  return <MemberTotp onDone={() => router.refresh()} />;
}
