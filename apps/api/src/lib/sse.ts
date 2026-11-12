import type { RequestHandler } from 'express';
import type { ChangeFeed } from './changeFeed';
import { ACCESS_TOKEN_TTL_SECONDS } from './jwt';

const KEEPALIVE_MS = 25_000;
/** A stream never outlives the access token that opened it; clients reconnect with a fresh one. */
const MAX_STREAM_MS = ACCESS_TOKEN_TTL_SECONDS * 1000;

/**
 * Server-Sent Events of database change notifications (DSH-07, RTE-09).
 * Events carry only table names, never data; clients refetch through
 * the normal, permission-checked endpoints.
 */
export function changeStream(changes: ChangeFeed, tables?: readonly string[]): RequestHandler {
  return (req, res) => {
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Stop Nginx buffering the stream.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\nevent: ready\ndata: {}\n\n');

    const unsubscribe = changes.subscribe((changed) => {
      const relevant = tables ? changed.filter((t) => tables.includes(t)) : changed;
      if (relevant.length) res.write(`event: change\ndata: ${JSON.stringify({ tables: relevant })}\n\n`);
    });
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS);
    const expiry = setTimeout(() => res.end(), MAX_STREAM_MS);

    req.on('close', () => {
      unsubscribe();
      clearInterval(keepalive);
      clearTimeout(expiry);
    });
  };
}
