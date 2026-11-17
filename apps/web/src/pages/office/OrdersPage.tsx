import {
  DELETABLE_ORDER_STATUSES,
  ORDER_SOURCES,
  ORDER_STATUSES,
  ORDER_STATUS_META,
  type DriverOption,
  type OrderDeleteResult,
  type OrderListItem,
  type Paginated,
  type RouteOption,
  formatUkDate,
} from '@bedex/shared';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, SlidersHorizontal, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { confirmDialog } from '../../components/ConfirmDialog';
import { ExportMenu } from '../../components/ExportMenu';
import { StatusBadge } from '../../components/StatusBadge';
import { ApiError, api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useDebounced } from '../../lib/hooks';

const FILTER_KEYS = ['q', 'status', 'date', 'driverId', 'routeId', 'postcodePrefix', 'source'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

/** Status shortcuts used by the dashboard cards. */
const STATUS_GROUPS = [
  { value: 'awaiting_scheduling,in_warehouse,rescheduled', label: 'Awaiting allocation (all)' },
  { value: 'failed,partially_delivered', label: 'Needs a decision (failed + partial)' },
];

/** Only orders that never reached a route can be deleted (the API re-checks, including past routes). */
const canDelete = (o: OrderListItem) => DELETABLE_ORDER_STATUSES.includes(o.status) && !o.currentRouteId;

/** ORD-03/04 + DSH-05: search and filters, kept in the URL so views can be linked and shared. */
export function OrdersPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
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
  /** Active filters other than the search box, which is always visible. */
  const filterCount = FILTER_KEYS.filter((k) => k !== 'q' && filters[k]).length;
  const [showFilters, setShowFilters] = useState(false);

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

  // --- delete orders created by mistake ---
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [deleteResult, setDeleteResult] = useState<{ ok: boolean; text: string; items: string[] } | null>(null);
  useEffect(() => setSelected(new Set()), [queryString]);
  const deletableRows = rows.filter(canDelete);
  const allSelected = deletableRows.length > 0 && deletableRows.every((o) => selected.has(o.id));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function deleteOrders(targets: OrderListItem[]) {
    if (targets.length === 0) return;
    const one = targets.length === 1;
    const shown = targets.slice(0, 8).map((o) => `${o.orderNumber} · ${o.customerName}`);
    if (targets.length > shown.length) shown.push(`…and ${targets.length - shown.length} more`);
    const ok = await confirmDialog({
      title: one ? `Delete order ${targets[0]!.orderNumber}?` : `Delete ${targets.length} orders?`,
      message: `This permanently removes ${one ? 'the order' : 'these orders'}, ${one ? 'its' : 'their'} items and history. Use it only for orders created by mistake; otherwise cancel the order. This can't be undone.`,
      details: one ? undefined : shown,
      confirmLabel: one ? 'Delete order' : `Delete ${targets.length} orders`,
      tone: 'danger',
    });
    if (!ok) return;
    setDeleting(true);
    setDeleteResult(null);
    try {
      const res = await api<OrderDeleteResult>('/orders/delete', { method: 'POST', json: { ids: targets.map((o) => o.id) } });
      setDeleteResult({
        ok: res.skipped.length === 0,
        text:
          `Deleted ${res.deleted} order${res.deleted === 1 ? '' : 's'}.` +
          (res.skipped.length ? ` ${res.skipped.length} could not be deleted:` : ''),
        items: res.skipped.map((x) => `${x.orderNumber}: ${x.reason}`),
      });
      setSelected(new Set());
    } catch (err) {
      setDeleteResult({ ok: false, text: err instanceof ApiError ? err.message : 'Could not delete. Try again.', items: [] });
    } finally {
      setDeleting(false);
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
    }
  }
  const statusIsCustom =
    filters.status && !ORDER_STATUSES.includes(filters.status as never) && !STATUS_GROUPS.some((g) => g.value === filters.status);

  return (
    // On desktop, fill the viewport (minus <main>'s 24px padding top and bottom) so only the table scrolls.
    // On small screens the page scrolls normally.
    <div className="flex flex-col lg:h-[calc(100dvh-3rem)]">
      <div className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Orders</h1>
        <div className="flex flex-wrap items-center gap-3">
          <ExportMenu path={(f) => `/exports/orders?${queryString}${queryString ? '&' : ''}format=${f}`} />
          <Link to="/office/orders/import" className="btn-primary px-3 py-1.5">
            <Upload className="h-4 w-4" aria-hidden />
            Import orders
          </Link>
        </div>
      </div>

      <div className="card mb-4 grid shrink-0 gap-3 p-3 md:grid-cols-2 xl:grid-cols-6">
        <div className="flex gap-2 md:col-span-2">
          <div className="relative min-w-0 flex-1">
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
          {/* Phones: the filters fold away behind this button. */}
          <button
            type="button"
            className="btn-secondary shrink-0 px-3 md:hidden"
            aria-expanded={showFilters}
            aria-controls="order-filters"
            onClick={() => setShowFilters((v) => !v)}
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden />
            Filters{filterCount > 0 && ` (${filterCount})`}
          </button>
        </div>
        <div id="order-filters" className={cn('md:contents', showFilters ? 'grid gap-3' : 'hidden')}>
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
        <select aria-label="Filter by source" value={filters.source} onChange={(e) => setFilter('source', e.target.value)} className="input capitalize">
          <option value="">All sources</option>
          {ORDER_SOURCES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
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
      </div>

      {deleteResult && (
        <div
          role="status"
          className={`mb-3 flex shrink-0 items-start justify-between gap-3 rounded-md px-3 py-2 text-sm ${deleteResult.ok ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}
        >
          <div>
            <p className="font-medium">{deleteResult.text}</p>
            {deleteResult.items.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-ink">
                {deleteResult.items.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            )}
          </div>
          <button type="button" onClick={() => setDeleteResult(null)} aria-label="Dismiss" className="shrink-0 rounded p-0.5 hover:bg-black/5">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      )}

      {selected.size > 0 && (
        <div className="mb-3 flex shrink-0 flex-wrap items-center gap-3 rounded-md border border-brand-primary/30 bg-brand-primary/5 px-3 py-2 text-sm">
          <span className="font-medium">
            {selected.size} order{selected.size === 1 ? '' : 's'} selected
          </span>
          <button
            type="button"
            className="btn bg-danger px-3 py-1 text-white hover:bg-danger/90"
            disabled={deleting}
            onClick={() => deleteOrders(rows.filter((o) => selected.has(o.id)))}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
          <button type="button" className="text-slate-600 underline-offset-2 hover:underline" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      <div className="card relative min-h-[300px] flex-1 overflow-auto" aria-label="Orders" tabIndex={0}>
        <table className="w-full text-left">
          {/* Sticky header; a shadow stands in for the border, which wouldn't stick with collapsed borders. */}
          <thead className="sticky top-0 z-10 bg-surface text-xs uppercase tracking-wide text-slate-500 shadow-[0_1px_0_0_rgb(var(--border))]">
            <tr>
              <th className="w-10 py-2.5 pl-4">
                <input
                  type="checkbox"
                  aria-label="Select all orders that can be deleted"
                  title="Select all orders that can be deleted"
                  checked={allSelected}
                  disabled={deletableRows.length === 0}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(deletableRows.map((o) => o.id)))}
                  className="h-4 w-4 accent-brand-primary disabled:opacity-40"
                />
              </th>
              <th className="px-4 py-2.5 font-medium">Order</th>
              <th className="hidden px-4 py-2.5 font-medium md:table-cell">Tracking ref</th>
              <th className="px-4 py-2.5 font-medium">Customer</th>
              <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Postcode</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Date</th>
              <th className="hidden px-4 py-2.5 font-medium md:table-cell">Source</th>
              <th className="w-12 px-2 py-2.5">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((o) => (
              <tr
                key={o.id}
                className={cn('cursor-pointer', selected.has(o.id) ? 'bg-brand-primary/5' : 'hover:bg-surface')}
                // Whole row opens the order; the checkbox, delete button and link handle their own clicks.
                onClick={(e) => {
                  if (!(e.target as HTMLElement).closest('a, button, input, label')) navigate(`/office/orders/${o.id}`);
                }}
              >
                <td className="py-2.5 pl-4" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`Select order ${o.orderNumber}`}
                    checked={selected.has(o.id)}
                    disabled={!canDelete(o)}
                    title={canDelete(o) ? undefined : 'Only orders not yet on a route can be deleted'}
                    onChange={() => toggle(o.id)}
                    className="h-4 w-4 accent-brand-primary disabled:opacity-30"
                  />
                </td>
                <td className="px-4 py-2.5 font-medium">
                  <Link to={`/office/orders/${o.id}`} className="text-brand-primary hover:underline">
                    {o.orderNumber}
                  </Link>
                </td>
                <td className="hidden px-4 py-2.5 font-mono text-xs md:table-cell">{o.trackingRef}</td>
                <td className="px-4 py-2.5">
                  {o.customerName}
                  <span className="block text-xs text-slate-500">
                    {o.town}
                    {/* The postcode column is hidden on phones. */}
                    <span className="sm:hidden"> · {o.postcode}</span>
                  </span>
                </td>
                <td className="hidden px-4 py-2.5 sm:table-cell">{o.postcode}</td>
                <td className="px-4 py-2.5">
                  <StatusBadge status={o.status} />
                </td>
                <td className="px-4 py-2.5">{o.scheduledDate ? formatUkDate(o.scheduledDate) : '–'}</td>
                <td className="hidden px-4 py-2.5 capitalize text-slate-600 md:table-cell">{o.source}</td>
                <td className="px-2 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                  {canDelete(o) && (
                    <button
                      type="button"
                      onClick={() => deleteOrders([o])}
                      disabled={deleting}
                      aria-label={`Delete order ${o.orderNumber}`}
                      title="Delete order"
                      className="rounded-md p-1.5 text-slate-400 hover:bg-danger/10 hover:text-danger"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  )}
                </td>
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
