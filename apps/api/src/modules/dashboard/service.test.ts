import { describe, expect, it } from 'vitest';
import { etaDriftMinutes } from './service';

const at = (hhmm: string) => new Date(`2026-11-12T${hhmm}:00Z`);

describe('etaDriftMinutes', () => {
  it('is null without timing data', () => {
    expect(etaDriftMinutes([], at('10:00'))).toBeNull();
    expect(etaDriftMinutes([{ eta: null, completedAt: null }], at('10:00'))).toBeNull();
  });

  it('is null before the first stop is due', () => {
    expect(etaDriftMinutes([{ eta: at('09:00'), completedAt: null }], at('08:30'))).toBeNull();
  });

  it('reports how late the most recent completed stop was', () => {
    const stops = [
      { eta: at('09:00'), completedAt: at('09:05') },
      { eta: at('09:30'), completedAt: at('09:42') },
      { eta: at('10:30'), completedAt: null },
    ];
    expect(etaDriftMinutes(stops, at('09:45'))).toBe(12);
  });

  it('reports running early as negative', () => {
    const stops = [
      { eta: at('09:00'), completedAt: at('08:52') },
      { eta: at('10:00'), completedAt: null },
    ];
    expect(etaDriftMinutes(stops, at('09:00'))).toBe(-8);
  });

  it('uses the overdue next stop when that is worse', () => {
    const stops = [
      { eta: at('09:00'), completedAt: at('09:02') },
      { eta: at('09:30'), completedAt: null },
    ];
    expect(etaDriftMinutes(stops, at('10:10'))).toBe(40);
  });

  it('flags a released route that has not started on time', () => {
    expect(etaDriftMinutes([{ eta: at('08:30'), completedAt: null }], at('09:00'))).toBe(30);
  });
});
