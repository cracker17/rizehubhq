/** Same-size placeholder shown while the office map (Phaser) loads, so nothing shifts. */
export function MapSkeleton() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-[#0e0d26]" aria-hidden>
      <svg viewBox="0 0 200 110" className="h-24 w-44 opacity-40" fill="none">
        <path d="M100 10 L190 55 L100 100 L10 55 Z" stroke="#7c5cff" strokeWidth="2" />
        <path d="M100 10 L100 100 M55 32 L145 78 M55 78 L145 32" stroke="#2c2863" strokeWidth="1.5" />
      </svg>
    </div>
  );
}
