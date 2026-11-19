import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { request } from './api';

export type LiveStatus = 'connecting' | 'live' | 'offline';

export const useLiveStatus = create<{ status: LiveStatus; set: (s: LiveStatus) => void }>()((set) => ({
  status: 'connecting',
  set: (status) => set({ status }),
}));

/** Poll interval for live data while the stream is down. */
export const FALLBACK_POLL_MS = 10_000;

const RECONNECT_MS = 3_000;

/**
 * Keep a Server-Sent Events connection open and call `onChange` with the
 * tables that changed ('*' after (re)connecting, to catch up). Uses fetch,
 * not EventSource, so the bearer token goes in a header rather than the URL.
 */
export function useEventStream(path: string, onChange: (tables: string[]) => void, onStatus?: (s: LiveStatus) => void): void {
  const handlers = useRef({ onChange, onStatus });
  handlers.current = { onChange, onStatus };

  useEffect(() => {
    let stopped = false;
    let controller: AbortController | null = null;
    const status = (s: LiveStatus) => handlers.current.onStatus?.(s);

    const handleEvent = (raw: string) => {
      let event = 'message';
      let data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (event === 'ready') {
        status('live');
        handlers.current.onChange(['*']);
      } else if (event === 'change') {
        try {
          handlers.current.onChange((JSON.parse(data) as { tables: string[] }).tables);
        } catch {
          handlers.current.onChange(['*']);
        }
      }
    };

    async function run() {
      while (!stopped) {
        controller = new AbortController();
        try {
          const res = await request(path, { headers: { Accept: 'text/event-stream' }, signal: controller.signal });
          if (!res.body) throw new Error('Streaming not supported');
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value.replace(/\r\n/g, '\n');
            let split: number;
            while ((split = buffer.indexOf('\n\n')) >= 0) {
              handleEvent(buffer.slice(0, split));
              buffer = buffer.slice(split + 2);
            }
          }
          // Server closed the stream (token lifetime reached): reconnect straight away.
          if (!stopped) status('connecting');
          continue;
        } catch {
          if (stopped) return;
          status('offline');
        }
        await new Promise((r) => setTimeout(r, RECONNECT_MS));
      }
    }

    void run();
    return () => {
      stopped = true;
      controller?.abort();
    };
  }, [path]);
}

const touches = (tables: string[], ...names: string[]) => tables.some((t) => t === '*' || names.includes(t));

/** DSH-07 / RTE-09: office-wide live updates (dashboard, orders, planner). */
export function useLiveUpdates(): void {
  const queryClient = useQueryClient();
  const setStatus = useLiveStatus((s) => s.set);
  useEventStream(
    '/dashboard/stream',
    (tables) => {
      // GPS fixes arrive every ~30 s per van: they only move vans on the map.
      const onlyGps = tables.length > 0 && tables.every((t) => t === 'driver_locations');
      void queryClient.invalidateQueries({ queryKey: onlyGps ? ['dashboard', 'live'] : ['dashboard'] });
      if (touches(tables, 'orders', 'delivery_attempts', 'route_stops')) void queryClient.invalidateQueries({ queryKey: ['orders'] });
      if (touches(tables, 'orders', 'routes', 'route_stops')) void queryClient.invalidateQueries({ queryKey: ['planner'] });
      if (touches(tables, 'orders', 'routes', 'route_stops', 'driver_locations', 'delivery_attempts')) {
        void queryClient.invalidateQueries({ queryKey: ['fleet'] });
      }
    },
    setStatus,
  );
}
