import { settingsPatchSchema } from '@bedex/shared';
import { Router } from 'express';
import type { AppContext } from '../../context';
import { audit } from '../../lib/audit';
import { requireAuth, requireRole } from '../../middleware/auth';
import { getSettings, saveSettings, validateSettingsPatch } from './service';

/** GET for office staff; PATCH is admin-only (PRD §2). */
export function settingsRouter({ db, env }: AppContext) {
  const router = Router();
  router.use(requireAuth(env.JWT_ACCESS_SECRET));

  router.get('/', requireRole('admin', 'office'), async (_req, res) => {
    res.json(await getSettings(db));
  });

  router.patch('/', requireRole('admin'), async (req, res) => {
    const patch = validateSettingsPatch(settingsPatchSchema.parse(req.body));
    await saveSettings(db, patch);
    await audit(db, req, { action: 'settings_changed', entity: 'settings', details: patch });
    res.json(await getSettings(db));
  });

  return router;
}
