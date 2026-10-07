/** Contoh strip foto di halaman depan: dua orang, empat jepretan. */

const POSES = [
  { a: 0, b: 0 },
  { a: -14, b: 10 },
  { a: 12, b: -12 },
  { a: -4, b: 4 },
];

function Person({ shift, tone }: { shift: number; tone: string }) {
  return (
    <svg viewBox="0 0 120 90" className="h-full w-full" aria-hidden="true">
      <rect width="120" height="90" fill={tone} />
      <g transform={`translate(${shift} 0)`} fill="#0E1440" opacity="0.85">
        <circle cx="60" cy="38" r="16" />
        <path d="M28 90c2-20 16-30 32-30s30 10 32 30z" />
      </g>
    </svg>
  );
}

export function SampleStrip() {
  return (
    <figure
      className="animate-strip w-[min(78vw,300px)] rotate-2 bg-paper p-3 pb-0 text-ink shadow-[0_30px_60px_-20px_rgb(0_0_0/0.55)]"
      aria-label="Contoh strip foto berisi dua orang dalam empat jepretan"
    >
      <div className="flex flex-col gap-2">
        {POSES.map((pose, i) => (
          <div key={i} className="grid grid-cols-2 gap-2">
            <div className="aspect-[4/3] overflow-hidden">
              <Person shift={pose.a} tone="#C9DCF6" />
            </div>
            <div className="aspect-[4/3] overflow-hidden">
              <Person shift={pose.b} tone="#F6C9D0" />
            </div>
          </div>
        ))}
      </div>
      <figcaption className="py-4 text-center">
        <span className="block font-display text-3xl font-black leading-none">kita</span>
        <span className="mt-1 block text-xs text-ink/60">14 Februari 2026</span>
      </figcaption>
    </figure>
  );
}
