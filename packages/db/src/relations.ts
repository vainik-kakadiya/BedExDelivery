import { relations } from 'drizzle-orm';
import {
  attemptPhotos,
  deliveryAttempts,
  depots,
  drivers,
  orderEvents,
  orderItems,
  orders,
  routeStops,
  routes,
  users,
  vans,
} from './schema';

export const usersRelations = relations(users, ({ one }) => ({
  driver: one(drivers, { fields: [users.id], references: [drivers.userId] }),
}));

export const driversRelations = relations(drivers, ({ one }) => ({
  user: one(users, { fields: [drivers.userId], references: [users.id] }),
  defaultVan: one(vans, { fields: [drivers.defaultVanId], references: [vans.id] }),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  items: many(orderItems),
  events: many(orderEvents),
  attempts: many(deliveryAttempts),
  currentRoute: one(routes, { fields: [orders.currentRouteId], references: [routes.id] }),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
}));

export const orderEventsRelations = relations(orderEvents, ({ one }) => ({
  order: one(orders, { fields: [orderEvents.orderId], references: [orders.id] }),
  actor: one(users, { fields: [orderEvents.actorId], references: [users.id] }),
}));

export const routesRelations = relations(routes, ({ one, many }) => ({
  stops: many(routeStops),
  depot: one(depots, { fields: [routes.depotId], references: [depots.id] }),
  driver: one(drivers, { fields: [routes.driverId], references: [drivers.id] }),
  van: one(vans, { fields: [routes.vanId], references: [vans.id] }),
}));

export const routeStopsRelations = relations(routeStops, ({ one }) => ({
  route: one(routes, { fields: [routeStops.routeId], references: [routes.id] }),
  order: one(orders, { fields: [routeStops.orderId], references: [orders.id] }),
}));

export const deliveryAttemptsRelations = relations(deliveryAttempts, ({ one, many }) => ({
  order: one(orders, { fields: [deliveryAttempts.orderId], references: [orders.id] }),
  photos: many(attemptPhotos),
}));

export const attemptPhotosRelations = relations(attemptPhotos, ({ one }) => ({
  attempt: one(deliveryAttempts, { fields: [attemptPhotos.attemptId], references: [deliveryAttempts.id] }),
}));
