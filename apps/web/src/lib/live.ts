import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
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
 * DSH-07: keep one Server-Sent Events connection open while the office app is
 * mounted and refetch affected queries when the database changes. Uses fetch
 * (not EventSource) so the bearer token goes in a header, not the URL.
 */
export function useLiveUpdates(): void {
  const queryClient = useQueryClient();
  const setStatus = useLiveStatus((s) => s.set);

  useEffect(() => {
    let stopped = false;
    let controller: AbortController | null = null;

    const invalidate = (tables: string[]) => {
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      if (tables.some((t) => t === '*' || t === 'orders' || t === 'delivery_attempts' || t === 'route_stops')) {
        void queryClient.invalidateQueries({ queryKey: ['orders'] });
      }
    };

    const handleEvent = (raw: string) => {
      let event = 'message';
      let data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (event === 'ready') {
        setStatus('live');
        invalidate(['*']); // catch up on anything missed while disconnected
      } else if (event === 'change') {
        try {
          invalidate((JSON.parse(data) as { tables: string[] }).tables);
        } catch {
          invalidate(['*']);
        }
      }
    };

    async function run() {
      while (!stopped) {
        controller = new AbortController();
        try {
          const res = await request('/dashboard/stream', {
            headers: { Accept: 'text/event-stream' },
            signal: controller.signal,
          });
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
          if (!stopped) setStatus('connecting');
          continue;
        } catch {
          if (stopped) return;
          setStatus('offline');
        }
        await new Promise((r) => setTimeout(r, RECONNECT_MS));
      }
    }

    void run();
    return () => {
      stopped = true;
      controller?.abort();
    };
  }, [queryClient, setStatus]);
}
