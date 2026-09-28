import { KpiCards } from '@/components/KpiCards';
import { OfficePanel } from '@/components/OfficePanel';
import { ApprovalsColumn } from '@/components/ApprovalsColumn';
import { ActivityStrip } from '@/components/ActivityStrip';

export default function OfficePage() {
  return (
    <>
      <KpiCards />
      <div className="grid min-w-0 gap-4 lg:gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        {/* On phones Approvals comes first (docs/06 "Mobile priority") */}
        <div className="order-2 min-w-0 xl:order-1"><OfficePanel /></div>
        <div className="order-1 min-w-0 xl:order-2"><ApprovalsColumn /></div>
      </div>
      <ActivityStrip />
    </>
  );
}
