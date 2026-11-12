import { auditLog, type DbOrTx } from '@bedex/db';
import type { Request } from 'express';

export interface AuditEntry {
  action: string;
  actorId?: string | null;
  entity?: string;
  entityId?: string;
  details?: Record<string, unknown>;
}

/** ACC-03: logins, permission changes, exports and data edits. */
export async function audit(db: DbOrTx, req: Request, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    action: entry.action,
    actorId: entry.actorId ?? req.user?.id ?? null,
    entity: entry.entity,
    entityId: entry.entityId,
    details: entry.details,
    ip: req.ip ?? null,
  });
}
