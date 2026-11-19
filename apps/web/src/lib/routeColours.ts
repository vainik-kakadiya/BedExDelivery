/** One colour per route: polyline, pins and swatches. The planner and the tracking map use the same order (by name), so a van keeps its colour. */
export const ROUTE_COLOURS = ['#2563EB', '#DC2626', '#16A34A', '#D97706', '#7C3AED', '#0891B2', '#DB2777', '#65A30D', '#475569', '#EA580C'];
export const routeColour = (index: number) => ROUTE_COLOURS[index % ROUTE_COLOURS.length]!;
