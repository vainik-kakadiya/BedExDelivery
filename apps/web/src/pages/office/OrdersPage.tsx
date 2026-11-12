import {
  ORDER_STATUSES,
  ORDER_STATUS_META,
  type DriverOption,
  type OrderListItem,
  type Paginated,
  type RouteOption,
  formatUkDate,
} from '@bedex/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ExportButtons } from '../../components/ExportButtons';
import { StatusBadge } from '../../components/StatusBadge';
import { ApiError, api } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';

const FILTER_KEYS = ['q', 'status', 'date', 'driverId', 'routeId', 'postcodePrefix'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

/** Status shortcuts used by the dashboard cards. */
const STATUS_GROUPS = [
  { value: 'awaiting_scheduling,in_warehouse,rescheduled', label: 'Awaiting allocation (all)' },
  { value: 'failed,partially_delivered', label: 'Needs a decision (failed + partial)' },
];

/** ORD-03/04 + DSH-05: search and filters, kept in the URL so views can be linked and shared. */
export function OrdersPage() {
  const [params, setParams] = useSearchParams();
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])) as Record<FilterKey, string>;

  // The search box is typed into locally and pushed to the URL after a pause.
  const [search, setSearch] = useState(filters.q);
  const debouncedSearch = useDebounced(search.trim(), 300);
  useEffect(() => {
    if (debouncedSearch !== filters.q) setFilter('q', debouncedSearch);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to the debounced value
  }, [debouncedSearch]);
  // Follow the URL when it changes from outside (back button, dashboard search).
  const urlQ = params.get('q') ?? '';
  useEffect(() => setSearch(urlQ), [urlQ]);

  function setFilter(key: FilterKey, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    // A route only makes sense for the chosen date.
    if (key === 'date') next.delete('routeId');
    setParams(next, { replace: true });
  }

  const query = new URLSearchParams();
  for (const k of FILTER_KEYS) if (filters[k]) query.set(k, filters[k]);
  const queryString = query.toString();
  const activeCount = FILTER_KEYS.filter((k) => filters[k]).length;

  const orders = useInfiniteQuery({
    queryKey: ['orders', queryString],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(query);
      p.set('limit', '50');
      if (pageParam) p.set('cursor', pageParam);
      return api<Paginated<OrderListItem>>(`/orders?${p}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
  const drivers = useQuery({ queryKey: ['drivers'], queryFn: () => api<DriverOption[]>('/drivers'), staleTime: 5 * 60_000 });
  const routes = useQuery({
    queryKey: ['routes', filters.date],
    queryFn: () => api<RouteOption[]>(`/routes?date=${filters.date}`),
    enabled: Boolean(filters.date),
  });

  const rows = orders.data?.pages.flatMap((p) => p.data) ?? [];
  const statusIsCustom =
    filters.status && !ORDER_STATUSES.includes(filters.status as never) && !STATUS_GROUPS.some((g) => g.value === filters.status);

  return (
    // Fill the viewport (minus <main>'s 24px padding top and bottom) so only the table scrolls.
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      <div className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Orders</h1>
        <ExportButtons label="Export" path={(f) => `/exports/orders?${queryString}${queryString ? '&' : ''}format=${f}`} />
      </div>

      <div className="card mb-4 grid shrink-0 gap-3 p-3 md:grid-cols-2 xl:grid-cols-6">
        <div className="relative md:col-span-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input
            type="search"
            aria-label="Search orders"
            placeholder="Order no., tracking ref, name, postcode, address, phone"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input pl-9"
          />
        </div>
        <select aria-label="Filter by status" value={filters.status} onChange={(e) => setFilter('status', e.target.value)} className="input">
          <option value="">All statuses</option>
          <optgroup label="Groups">
            {STATUS_GROUPS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Status">
            {ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ORDER_STATUS_META[s].label}
              </option>
            ))}
          </optgroup>
          {statusIsCustom && <option value={filters.status}>Custom selection</option>}
        </select>
        <input
          type="date"
          aria-label="Filter by delivery date"
          value={filters.date}
          onChange={(e) => setFilter('date', e.target.value)}
          className="input"
        />
        <select aria-label="Filter by driver" value={filters.driverId} onChange={(e) => setFilter('driverId', e.target.value)} className="input">
          <option value="">All drivers</option>
          {drivers.data?.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by route"
          value={filters.routeId}
          onChange={(e) => setFilter('routeId', e.target.value)}
          disabled={!filters.date}
          title={filters.date ? undefined : 'Pick a date to filter by route'}
          className="input disabled:bg-surface disabled:text-slate-400"
        >
          <option value="">{filters.date ? 'All routes' : 'Route (pick a date)'}</option>
          {routes.data?.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <input
          aria-label="Filter by postcode prefix"
          placeholder="Postcode prefix (e.g. NW10)"
          value={filters.postcodePrefix}
          onChange={(e) => setFilter('postcodePrefix', e.target.value.toUpperCase().replace(/\s+/g, ' '))}
          maxLength={8}
          className="input uppercase"
        />
        {activeCount > 0 && (
          <button
            type="button"
            className="btn-secondary justify-self-start"
            onClick={() => {
              setSearch('');
              setParams({}, { replace: true });
            }}
          >
            <X className="h-4 w-4" aria-hidden />
            Clear filters ({activeCount})
          </button>
        )}
      </div>

      <div className="card min-h-[300px] flex-1 overflow-auto" aria-label="Orders" tabIndex={0}>
        <table className="w-full text-left">
          {/* Sticky header; a shadow stands in for the border, which wouldn't stick with collapsed borders. */}
          <thead className="sticky top-0 z-10 bg-surface text-xs uppercase tracking-wide text-slate-500 shadow-[0_1px_0_0_rgb(var(--border))]">
            <tr>
              <th className="px-4 py-2.5 font-medium">Order</th>
              <th className="px-4 py-2.5 font-medium">Tracking ref</th>
              <th className="px-4 py-2.5 font-medium">Customer</th>
              <th className="px-4 py-2.5 font-medium">Postcode</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Date</th>
              <th className="px-4 py-2.5 font-medium">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((o) => (
              <tr key={o.id} className="hover:bg-surface">
                <td className="px-4 py-2.5 font-medium">{o.orderNumber}</td>
                <td className="px-4 py-2.5 font-mono text-xs">{o.trackingRef}</td>
                <td className="px-4 py-2.5">
                  {o.customerName}
                  <span className="block text-xs text-slate-500">{o.town}</span>
                </td>
                <td className="px-4 py-2.5">{o.postcode}</td>
                <td className="px-4 py-2.5">
                  <StatusBadge status={o.status} />
                </td>
                <td className="px-4 py-2.5">{o.scheduledDate ? formatUkDate(o.scheduledDate) : '–'}</td>
                <td className="px-4 py-2.5 capitalize text-slate-600">{o.source}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {orders.isPending && <p className="p-6 text-center text-slate-500">Loading orders…</p>}
        {orders.isError && (
          <p role="alert" className="p-6 text-center text-danger">
            {orders.error instanceof ApiError ? orders.error.message : 'Could not load orders.'}
          </p>
        )}
        {orders.isSuccess && rows.length === 0 && (
          <p className="p-6 text-center text-slate-500">{activeCount ? 'No orders match these filters.' : 'No orders yet.'}</p>
        )}
        {orders.hasNextPage && (
          <div className="border-t border-border p-4 text-center">
            <button type="button" className="btn-secondary" onClick={() => orders.fetchNextPage()} disabled={orders.isFetchingNextPage}>
              {orders.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
