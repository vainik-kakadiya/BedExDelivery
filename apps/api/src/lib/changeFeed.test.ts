import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeFeed } from './changeFeed';

describe('ChangeFeed', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces a burst into one event listing each table once', () => {
    const feed = new ChangeFeed(300);
    const seen: string[][] = [];
    feed.subscribe((t) => seen.push(t));

    for (let i = 0; i < 50; i++) feed.publish('orders');
    feed.publish('route_stops');
    vi.advanceTimersByTime(300);

    expect(seen).toEqual([['orders', 'route_stops']]);
  });

  it('stops delivering after unsubscribe and survives a throwing listener', () => {
    const feed = new ChangeFeed(10);
    const good = vi.fn();
    const unsubscribe = feed.subscribe(() => {
      throw new Error('socket closed');
    });
    feed.subscribe(good);

    feed.publish('orders');
    vi.advanceTimersByTime(10);
    expect(good).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(feed.subscriberCount).toBe(1);
  });
});
