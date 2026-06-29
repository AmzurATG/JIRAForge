# Enhancement #12 — "Improve" Button Deep-Link from My Focus

> **Status:** Planning only. No code changes in this commit.
> **Parent spec:** [plan/2026-06-04_forge-app_my-focus-description-quality.md](../../plan/2026-06-04_forge-app_my-focus-description-quality.md)
> **Depends on:** [11_MY_FOCUS_QUALITY_COLUMN.md](./11_MY_FOCUS_QUALITY_COLUMN.md)

---

## 1. Goal

From a low-quality row in My Focus, the user clicks **Improve** and lands
on the relevant ticket with the Description Quality panel **already in the
LOADING_LLM stage** (skipping IDLE and SCORED). One click, no extra
navigation, no re-prompting.

## 2. Why a Redirect Instead of an Inline Modal

| Option | Verdict |
|---|---|
| Inline modal in My Focus that runs the full Improve flow | Rejected — duplicates 300+ LOC of [DescriptionQuality.js](../../forge-app/static/main/src/components/issue-panel/DescriptionQuality.js), splits accept/edit/reject UX into two places, hard to keep in sync, and the modal would have no access to Jira's native description editor for downstream "open in editor" actions. |
| Forge `router.open()` to the Jira issue view with a hint | **Selected** — reuses 100% of existing flow, keeps a single source of truth, leaves user on the ticket page where they would naturally continue working. |
| Open in a new tab | Rejected — Atlassian users in the screenshot already work in multi-tab workflows; we should respect their existing tab and not force a new one. The user can Ctrl/Cmd-click for new-tab if they want it. |

## 3. Mechanism

### 3.1 URL hint

The Improve button calls:

```js
import { router } from '@forge/bridge';

const issueUrl = `${siteBaseUrl}/browse/${issueKey}#dq=improve`;
router.open(issueUrl);
```

- `siteBaseUrl` is retrieved at app init via `view.getContext()` (already
  done elsewhere in the app — confirm exact accessor at impl time).
- The `#dq=improve` fragment is the **hint**. Hash fragments are not sent
  to Jira's backend, so they cannot collide with any Jira URL parsing.

### 3.2 Hint consumption in `DescriptionQuality.js`

A small `useEffect` on mount:

```js
useEffect(() => {
  const hash = (typeof window !== 'undefined' && window.location.hash) || '';
  if (hash.includes('dq=improve')) {
    // Clear the hint so a manual reload returns to IDLE
    try {
      const url = new URL(window.location.href);
      url.hash = '';
      window.history.replaceState({}, '', url.toString());
    } catch (_) { /* no-op */ }
    runAnalysis(true);  // jumps directly to LOADING_LLM → COMPARISON
  }
}, [runAnalysis]);
```

Behaviour:

- Hint consumed **once per mount**.
- A user who manually reloads the issue page after the hint was consumed
  returns to the existing IDLE state — no surprise re-analysis.
- The hint never persists in sessionStorage / KVS / URL params.

### 3.3 Forge context constraints

`@forge/bridge`'s `router.open()` supports same-site URLs. The Jira issue
view (`/browse/<KEY>`) is the same Atlassian site as the Forge app, so this
is permitted. We do **not** need to add any new permission scopes.

## 4. UI Specification

### 4.1 Button styling

- Inline text-style button (no fill) next to the badge: `Improve →`.
- Visible only when the cached score is **< 80**.
- `aria-label="Improve description for {{issueKey}}"`.
- Disabled state while a sibling "Check" is in-flight (prevents double click).

### 4.2 No button when

- Score ≥ 80 (description is already good).
- No cached score (we don't yet know if it needs improving — show "Check"
  instead, per #11).

## 5. Acceptance Criteria (from parent spec)

7. Button visible inline for cached `score < 80`.
8. `router.open()` is called with the correct fragment.
9. Issue panel auto-enters `LOADING_LLM` when `#dq=improve` is present.
10. Hint is consumed once and cleared from the URL.

## 6. Files (planned)

### 6.1 Modified files

| Path | Change |
|---|---|
| [forge-app/static/main/src/components/issue-panel/DescriptionQuality.js](../../forge-app/static/main/src/components/issue-panel/DescriptionQuality.js) | Add hash-hint `useEffect` that triggers `runAnalysis(true)` when `#dq=improve` is present, then clears the hash. |
| `forge-app/static/main/src/components/tabs/QualityCell.js` (new in #11) | Render `Improve →` button when score < 80; call `router.open()`. |

### 6.2 New files

| Path | Purpose |
|---|---|
| `forge-app/static/main/src/components/tabs/__tests__/improveDeepLink.test.js` | Asserts the deep-link URL contains `/browse/<KEY>#dq=improve`. |
| Add to existing `DescriptionQuality.test.js` | Tests that mounting with `window.location.hash = '#dq=improve'` immediately calls `analyzeDescription` with `requestImprovement: true`. |

## 7. Edge Cases

| Case | Handling |
|---|---|
| User clicks Improve while a "Check" is already running for the same row | Disable Improve until Check completes; then the badge updates to a score and Improve becomes available. |
| Issue is deleted between My Focus load and Improve click | `router.open()` still navigates; Jira shows its standard 404; no app-side error. |
| User is offline | `router.open()` opens the issue URL; existing panel error path handles ai-server unreachable. |
| `siteBaseUrl` missing from context | Fallback: use a relative URL `/browse/<KEY>#dq=improve` — same site, `router.open()` resolves it. |
| Browser strips hash on navigation (rare extension behaviour) | Panel stays in IDLE; user clicks "Check quality" → "Improve with AI" manually — same outcome, one extra click. |

## 8. Why Not Persist the Hint Server-Side?

Persisting "auto-improve next" state in app KVS or Supabase was considered
and rejected:

- Adds a database write per click, with no value beyond ~2s of in-browser
  state.
- Risks accidentally auto-triggering improve on a later, unrelated panel
  open.
- Adds storage cleanup obligations (KVS quota is finite).

The URL fragment is ephemeral, scoped to a single navigation, and requires
zero backend state.
