import {
  BedDouble,
  Box,
  ClipboardCheck,
  Clock,
  type LucideIcon,
  MapPin,
  Navigation,
  Package,
  PackageCheck,
  PackageOpen,
  Route,
  Sofa,
  Truck,
  Warehouse,
} from 'lucide-react';

const ICONS: LucideIcon[] = [Truck, Package, MapPin, BedDouble, PackageCheck, Route, Box, Clock, Truck, Sofa, Navigation, PackageOpen, Warehouse, ClipboardCheck];

const COLS = 6;
const ROWS = 7;

/** Small seeded PRNG so the scatter looks random but stays identical on every render. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One icon per grid cell, jittered inside it, so icons spread evenly without clumping. */
const ITEMS = (() => {
  const rand = mulberry32(20261113);
  return Array.from({ length: COLS * ROWS }, (_, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    return {
      Icon: ICONS[Math.floor(rand() * ICONS.length)]!,
      left: ((col + 0.15 + rand() * 0.7) / COLS) * 100,
      top: ((row + 0.15 + rand() * 0.7) / ROWS) * 100,
      size: 28 + Math.round(rand() * 20),
      rotate: Math.round(rand() * 50 - 25),
      accent: rand() < 0.2,
    };
  });
})();

/** Decorative background of scattered delivery icons. Sits behind content and ignores clicks. */
export function DeliveryPattern() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -left-32 -top-32 h-96 w-96 rounded-full bg-brand-primary/10 blur-3xl" />
      <div className="absolute -bottom-40 -right-32 h-[28rem] w-[28rem] rounded-full bg-brand-primary/10 blur-3xl" />
      {ITEMS.map(({ Icon, left, top, size, rotate, accent }, i) => (
        <Icon
          key={i}
          size={size}
          strokeWidth={1.5}
          className={accent ? 'absolute text-brand-primary/25' : 'absolute text-slate-400/30'}
          style={{ left: `${left}%`, top: `${top}%`, transform: `translate(-50%, -50%) rotate(${rotate}deg)` }}
        />
      ))}
    </div>
  );
}
