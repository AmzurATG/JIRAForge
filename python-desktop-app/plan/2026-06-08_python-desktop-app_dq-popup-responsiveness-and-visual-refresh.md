# DQ Popup Responsiveness And Visual Refresh

## Problem
The Description Quality Nudge popup is currently hard to use on smaller window sizes: it appears in the bottom-right corner, clips content when constrained, uses oversized typography, and has noisy visual treatments (especially score display) that reduce readability.

## Root Cause / Context
- `dq_nudge/popup.py` uses fixed geometry anchored to bottom-right.
- The window is not horizontally resizable and has no explicit minimum dimensions.
- Card layout uses fixed wrap assumptions and non-adaptive button placement.
- Visual hierarchy and color usage make secondary actions too prominent and score rendering distracting.

## Proposed Solution
- Center the popup on show and apply minimum width/height constraints.
- Make the window resizable and update card internals to adapt to available width.
- Replace text-based score pattern with a clean solid progress bar and score badge.
- Refine typography scale and color palette for better contrast and lower visual fatigue.
- Make `Open in Jira` the only strong primary action; render `Snooze` and `Dismiss` as secondary ghost/outlined actions.

## Acceptance Criteria
1. Popup opens centered on screen rather than bottom-right.
2. Popup enforces minimum dimensions so title/buttons do not overlap.
3. Card content and action row remain usable when width shrinks; action buttons stack/reflow instead of clipping.
4. Score display uses a clean solid progress bar with semantic color gradient and readable text.
5. Typography and spacing are reduced/refined so text fits naturally within cards.
6. Action hierarchy is clear: primary open action is visually strongest, snooze/dismiss are secondary.

## Out Of Scope
- Changes to nudge generation logic, polling cadence, or server-side API behavior.
- New user settings for theming, font scaling, or custom popup placement.
