import type { StatsCtx } from './filters';

/** RevenueCat lifecycle event names (see `lifecycleEventName` in ../revenuecat.ts). */
export const TRIAL_STARTED = 'rc_trial_started';
export const TRIAL_CONVERTED = 'rc_trial_converted';

/**
 * Distinct installs that started a trial / converted a trial to paid, as two columns `trials` and `converted`.
 * Use with `trialsFrom`. Trials are credited to the install's own attribution (rc events have no session).
 */
export const TRIAL_COUNTS = `COUNT(DISTINCT CASE WHEN e.name = '${TRIAL_STARTED}' THEN e.install_id END) AS trials,
  COUNT(DISTINCT CASE WHEN e.name = '${TRIAL_CONVERTED}' THEN e.install_id END) AS converted`;

/**
 * FROM/WHERE over trial events dated in [?, ?), binds: app id, from, to, then the filter binds.
 * Only events matched to an install exist in `events`, so the inner join loses nothing.
 */
export const trialsFrom = (ctx: StatsCtx) =>
  `FROM events e JOIN installs i ON i.app_id = e.app_id AND i.id = e.install_id
   WHERE e.app_id = ? AND e.type = 'event' AND e.name IN ('${TRIAL_STARTED}', '${TRIAL_CONVERTED}')
     AND e.ts >= ? AND e.ts < ?${ctx.eventSandbox}${ctx.filter.where}`;
