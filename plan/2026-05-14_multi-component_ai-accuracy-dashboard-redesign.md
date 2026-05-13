# AI Accuracy Dashboard Redesign — Time-Weighted, Reconciled Metrics

**Date**: 2026-05-14
**Components**: forge-app (frontend + resolver), ai-server (controller), supabase (migrations)
**Status**: In progress
**Related**: `plan/AI_ACCURACY_TRACKING_IMPLEMENTATION_PLAN.md` (original implementation)

---

## Problem

The current AI accuracy dashboard (shipped per the original plan above) is functionally correct but presents data in ways that mislead the alpha testers it's built for:

1. **Four panels use four different definitions of "AI was wrong."** The headline accuracy, by-application table, calibration chart, and top-wrong-pairs panel each bucket events differently. Numbers across panels do not reconcile — a tester computing headline accuracy from by-app rows gets a different answer than the headline shows.

2. **Accuracy is event-count, but worklog impact is time-weighted.** A 5-second AI-right event counts the same as a 4-hour AI-wrong event. The dashboard shows "Approved time" and "Reassigned time" alongside an event-count accuracy %, inviting (but never computing) the time-weighted comparison that actually matters for billable correctness.

3. **The "Total events" card mixes denominators.** It sums all event types, including `manually_assigned` events where the AI didn't make a suggestion (which are excluded from the accuracy denominator). The card invites the reader to mentally reconstruct what relates to what.

4. **The wrong-pairs table is ranked by event count.** A single bulk reassign creating 50 events dominates the panel over a high-leverage single mistake.

5. **The calibration chart says "lines up diagonally" but never draws the diagonal.** Buckets with sample_count=3 have the same visual weight as buckets with sample_count=300. Drift between expected and actual is invisible at a glance.

6. **No `(new)` signal in the wrong-pairs table.** When the user creates a brand-new issue because the AI's pick was wrong, that's the strongest signal of AI failure — but it looks identical to "moved to a different existing issue" in the current display.

## Root cause / context

The original implementation prioritized shipping a measurement tool fast. Event-count math was easier; the four panels were sliced independently; no single "definition of wrong" was committed across the system. The redesign locks in a single definition, reframes around time, and adds the visual aids that turn raw numbers into actionable signal.

The dashboard remains an internal-only REMOVABLE LAYER. Allowlist gating (`accuracy_dashboard_users`), FIT auth, RLS posture, and the `ai_accuracy_events` schema are sound — this work touches only the aggregation and presentation layer.

## Proposed solution

### Three time buckets

Every reviewed second of activity falls into exactly one bucket. The buckets sum to total reviewed time, so all panels reconcile by construction.

| Bucket | Source events | Meaning |
|---|---|---|
| **Matched** | `approved_as_is` | AI's pick was kept |
| **Reassigned** | `reassigned` ∪ (`manually_assigned` where `ai_suggested_issue_key IS NOT NULL`) | AI suggested, user overrode |
| **Unmatched** | `manually_assigned` where `ai_suggested_issue_key IS NULL` | AI didn't classify — user assigned from scratch |

### Headline metric

**Match rate = matched_seconds / (matched_seconds + reassigned_seconds)**.

Unmatched time is reported separately, not folded in — the AI didn't try.

### Display

- 3 KPI cards: Match rate · Reassigned time · Unmatched time
- Visual breakdown bar under the cards (Matched / Reassigned / Unmatched as proportions of total reviewed time)
- Reassignments panel: ranked by **total time**, with a `(new)` tag where the destination was a newly-created issue
- By-app: time totals per category + match rate, sorted by total time descending
- Calibration: actual vs. expected (bucket midpoint), drift column (color-coded), low-sample (`n < 20`) buckets greyed-out
- Recent reassignments: renamed from "Recent mistakes" to match the rest of the dashboard's vocabulary

## Acceptance criteria

1. The dashboard's KPI row shows three cards (Match rate, Reassigned time, Unmatched time) plus a total reviewed time line. The previous four-card layout is removed.
2. A visual breakdown bar under the cards shows Matched, Reassigned, and Unmatched as proportional segments of total reviewed time, with absolute time and percentage labels per segment.
3. The "Reassignments" panel (renamed from "Top wrong pairs") includes a `Total time` column and is sorted by total time descending.
4. Rows in Reassignments where the destination issue was created from the AI suggestion (`metadata.reassign_reason='created_new_issue'`) render the destination key with a `(new)` tag.
5. The "Accuracy by application" panel returns six numeric columns: matched count + time, reassigned count + time, unmatched count + time, plus a total time and match-rate column. Sorted by total time descending.
6. The Confidence calibration table shows for each bucket: bucket label, sample size, actual accuracy, expected (bucket midpoint), drift (`actual − expected`), and a visual bar comparing actual against expected. Drift is colored: green within ±5pp, amber within ±15pp, red beyond.
7. Calibration buckets with `sample_count < 20` render greyed-out with a "low sample" tag and hide the drift value.
8. "Recent mistakes" is renamed "Recent reassignments" to align with the rest of the dashboard's vocabulary.
9. All panels reconcile: summing per-app matched/reassigned/unmatched counts equals the corresponding KPI totals, and per-app time totals sum to the breakdown-bar totals.
10. No changes to the allowlist gate, FIT auth, resolver layer, or `ai_accuracy_events` schema.

## Implementation

### Migration — `supabase/migrations/20260514_ai_accuracy_dashboard_redesign.sql`

New RPCs added; the v1 RPCs from the original migration are left in place during the cut-over (drop in a follow-up after verification):

- `get_accuracy_summary_v2(p_org, p_since)` — single row with matched/reassigned/unmatched count + seconds, plus the `reassigned_new_issue_*` subset.
- `get_accuracy_reassignments(p_org, p_since, p_limit)` — wrong-pair shape extended with `total_seconds` and `is_new_issue`. Sorted by total_seconds desc, then pair_count desc.
- `get_accuracy_by_app_v2(p_org, p_since, p_limit)` — per-app matched/reassigned/unmatched count + seconds, total_seconds. Sorted by total_seconds desc.

Calibration RPC (`get_accuracy_calibration`) is unchanged — drift / low-sample handling is a presentation concern.

### AI server controller — `ai-server/src/controllers/accuracy-dashboard-controller.js`

- `getSummary` calls `get_accuracy_summary_v2`. Returns `{ matched, reassigned, unmatched, match_rate, total_events, total_seconds, days }` where each bucket object is `{ count, seconds }` (reassigned also carries `new_issue_count`, `new_issue_seconds`).
- `getWrongPairs` calls `get_accuracy_reassignments`. Returns pairs with `{ from, to, is_new_issue, seconds, count }`.
- `getByApp` calls `get_accuracy_by_app_v2`. Returns apps with per-category count + seconds, total_seconds, match_rate.
- `getCalibration` unchanged.
- `getRecentMistakes` unchanged in shape; the frontend simply renames it for display.

### Resolver — `forge-app/src/resolvers/accuracyDashboardResolvers.js`

No changes. Pure pass-through.

### Frontend — `forge-app/static/main/src/components/tabs/AdminAccuracyDashboardTab.{js,css}`

Layout rewrite of the render block. State shape adjusts to the new response shape. CSS gets:
- `.accuracy-breakdown-bar` + per-segment classes for the visual breakdown
- `.new-issue-tag` for the `(new)` chip in Reassignments
- `.cal-drift-good` / `.cal-drift-mid` / `.cal-drift-bad` for calibration drift coloring
- `.cal-row-low-sample` for low-sample greying
- `.cal-expected-marker` for the expected-midpoint line over the calibration bar

## Out of scope (deferred to follow-ups)

- **Time-series chart** of accuracy over time — the most-requested next feature, intentionally separated so this change stays surgical.
- **Row-click drill-down** on Recent Reassignments (screenshot + OCR + prompt context).
- **`ai_original_issue_key` column** on `activity_records` so the wrong-pairs panel reflects the AI's *original* suggestion, not the most recent edit of `user_assigned_issue_key`. The current behavior is acknowledged in code at `assignmentResolvers.js:1191-1198`.
- **Selection-bias annotation** ("measured on N reviewed records, X% of total classifications in window").
- **Filtering reassignments by source** (e.g., excluding `metadata.source = 'bulk_time_interval'`).
- **Wilson confidence intervals** on calibration buckets — drift coloring + low-sample greying covers the alpha-period need.
- **Org-level summary in the All-orgs view** — the org dropdown serves that need today.

## Removal

This redesign does not change the removal procedure. To retire the entire AI accuracy tracking layer:
1. Drop the v1 + v2 RPCs (`get_accuracy_*` and `get_accuracy_*_v2`)
2. Drop tables `ai_accuracy_events` and `accuracy_dashboard_users`
3. Delete the controller, resolver, tab component, CSS, and call sites that invoke `recordAccuracyEvents`
See `plan/AI_ACCURACY_TRACKING_IMPLEMENTATION_PLAN.md` for the canonical procedure.

## Test plan

### Reconciliation checks (manual, post-deploy)

- [ ] Open the dashboard with `Last 7 days · All organizations`. Confirm: `Matched seconds + Reassigned seconds + Unmatched seconds == Total reviewed time` (within rounding).
- [ ] In the By-application panel: `SUM(matched_count) == summary.matched.count`. Same for reassigned and unmatched.
- [ ] In the By-application panel: `SUM(matched_seconds + reassigned_seconds + unmatched_seconds) == summary.total_seconds`.
- [ ] Match rate from headline `summary.match_rate` equals `SUM(matched_seconds) / (SUM(matched_seconds) + SUM(reassigned_seconds))` over by-app rows.

### Visual checks

- [ ] Reassignment rows tagged `(new)` correspond to entries in `created_issues_log` with matching destination issue keys (spot-check).
- [ ] Calibration rows with `n < 20` render greyed; drift column shows `—` for those rows.
- [ ] Calibration drift colors: a bucket where actual is within 5pp of expected renders green; 5–15pp renders amber; >15pp renders red.

### Automated

- Update / add controller unit tests (`ai-server/tests/controllers/accuracy-dashboard-controller.test.js` if present, else new) that mock `supabase.rpc` and assert the response shape for each endpoint.

## Rollout

1. Apply the new migration to the dev Supabase instance.
2. Deploy the ai-server change. The frontend still renders correctly during the brief mismatch window because the new controller is backward-additive: old fields aren't dropped, new ones are added.
3. Deploy the forge-app build with the new frontend.
4. Run the reconciliation checks above against a known-data org.
5. After 1–2 days of stability, schedule a cleanup migration to drop the v1 RPCs.
