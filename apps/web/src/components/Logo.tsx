import { cn } from '../lib/cn';

/** Text wordmark until the logo source file is supplied (PRD §14). */
export function Logo({ className, inverted = false }: { className?: string; inverted?: boolean }) {
  return (
    <span className={cn('inline-flex items-baseline gap-1 font-bold tracking-tight', className)}>
      <span className={inverted ? 'text-white' : 'text-brand-dark'}>BedEx</span>
      <span className={inverted ? 'text-white/70' : 'text-brand-primary'}>Delivery</span>
    </span>
  );
}
