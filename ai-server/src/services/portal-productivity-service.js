/**
 * Portal Productivity Service (Phase 2 — per-LOB classification consumption)
 *
 * PURE re-derivation of productivity from each LOB's classifications. Given
 * already-fetched activity rows, the shared app catalog, and a single LOB's
 * classification map, it resolves each activity's effective label and computes
 * totals + productivity %.
 *
 * Resolution precedence: per-LOB rule → neutral. There is NO fallback to the
 * catalog default — an app stays Unclassified (neutral) until the LOB sets a
 * rule. Activity that can't be matched to a catalog app is also `neutral`.
 * `neutral` and `private` are excluded from the productive ÷ (productive +
 * non_productive) ratio (time is still totaled).
 *
 * No DB/Express here — inputs are passed in. Gated by PORTAL_LOB_PRODUCTIVITY;
 * see isEnabled(). Until that flag is on and this is wired into the analytics
 * controllers, it has no runtime effect.
 *
 * Matching caveat: there is no captured browser URL — browser apps are matched
 * by site/domain appearing in `application_name` / `window_title`. Best-effort;
 * unmatched activity falls to `neutral` rather than being mislabeled.
 */

'use strict';

const LABELS = ['productive', 'non_productive', 'private', 'neutral'];

/** Phase-2 flag. When off, callers should keep today's classification math. */
function isEnabled() {
  return process.env.PORTAL_LOB_PRODUCTIVITY === 'on';
}

/** Build fast lookup structures from the catalog. */
function buildCatalogIndex(catalog) {
  const processMap = new Map(); // identifier(lower) -> app  (match_by = process)
  const urlEntries = []; // { id, app }                       (match_by = url)
  for (const app of catalog || []) {
    const id = (app.identifier || '').toLowerCase();
    if (!id) continue;
    if (app.match_by === 'process') processMap.set(id, app);
    else if (app.match_by === 'url') urlEntries.push({ id, app });
  }
  return { processMap, urlEntries };
}

/**
 * Match one activity row to a catalog app.
 * Process apps match `application_name` exactly; browser apps match when their
 * site/domain appears in `application_name` or `window_title`.
 * @returns {Object|null} the catalog app, or null if unmatched.
 */
function matchApp(row, index) {
  const appName = (row.application_name || '').toLowerCase().trim();
  const title = (row.window_title || '').toLowerCase();

  if (appName && index.processMap.has(appName)) return index.processMap.get(appName);

  for (const { id, app } of index.urlEntries) {
    if (appName === id || appName.includes(id) || title.includes(id)) return app;
  }
  return null;
}

/**
 * Effective label for one row given a LOB's classification map.
 * @param {Object} row
 * @param {Object} index - from buildCatalogIndex
 * @param {Map<string,string>} lobClassMap - appId -> classification
 */
function resolveEffectiveLabel(row, index, lobClassMap) {
  const app = matchApp(row, index);
  if (!app) return 'neutral';
  // Per-LOB rule is the single source of truth; no catalog-default fallback.
  // Unclassified (and unmatched) activity is neutral and excluded from the ratio.
  return lobClassMap.get(app.id) || 'neutral';
}

/**
 * Compute productivity totals for a set of activity rows under one LOB.
 * @param {Array} activityRows - rows with application_name, window_title, duration_seconds
 * @param {Array} catalog - portal_app_catalog rows
 * @param {Map<string,string>|Object} lobClassifications - appId -> classification
 */
function computeProductivity(activityRows, catalog, lobClassifications) {
  const index = buildCatalogIndex(catalog);
  const lobClassMap =
    lobClassifications instanceof Map
      ? lobClassifications
      : new Map(Object.entries(lobClassifications || {}));

  const totals = { productive: 0, non_productive: 0, private: 0, neutral: 0 };
  for (const row of activityRows || []) {
    const label = resolveEffectiveLabel(row, index, lobClassMap);
    const seconds = row.duration_seconds || 0;
    if (LABELS.includes(label)) totals[label] += seconds;
    else totals.neutral += seconds;
  }

  const denom = totals.productive + totals.non_productive;
  const productivityPercentage = denom > 0 ? (totals.productive / denom) * 100 : 0;

  return {
    productiveHours: totals.productive / 3600,
    nonProductiveHours: totals.non_productive / 3600,
    privateHours: totals.private / 3600,
    neutralHours: totals.neutral / 3600,
    productivityPercentage: Math.round(productivityPercentage * 10) / 10,
  };
}

module.exports = {
  LABELS,
  isEnabled,
  buildCatalogIndex,
  matchApp,
  resolveEffectiveLabel,
  computeProductivity,
};
