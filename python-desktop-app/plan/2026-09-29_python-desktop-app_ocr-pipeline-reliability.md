# OCR pipeline reliability (O-1 … O-5)

**Date:** 2026-09-29
**Component:** `python-desktop-app/` (shared by Windows and Linux)
**Source:** `docs/SCREEN_CAPTURE_AND_OCR_FAILURE_ANALYSIS.md` §4. These findings were written against the old Linux build; this spec covers the ones that also exist in the current code. The Linux release depends on it (linux-desktop-app plan §6.8).

## Problem

OCR text is computed and then lost, or reported misleadingly:

1. **O-1:** The batch backfills at most 3 throttled screenshots. The rest are dropped: `get_pending_ocr_entries()` has already cleared them, and their sessions are uploaded with no OCR text. In the sample log this was 262 dropped against 321 processed.
2. **O-2:** `wait_for_ocr()` waits on one shared `Event`. Submitting job B clears it, and job A finishing sets it again while B is still queued. The batch then harvests sessions before B's result lands, and B's `backfill_ocr` finds no row. Separately, `backfill_ocr` writes only when `ocr_method` is empty, so a failed result (`metadata`/`error`) can never be replaced by a later good one.
3. **O-3:** An engine *error* (`success=False` with `error`) is reported as "Confidence too low (0.00 < …)" and never counted as a failure. A screen with no text gets the same message.
4. **O-4:** `get_facade()` has no lock, so two threads can build two facades. One RapidOCR instance is called at the same time from the OCR worker and from the batch backfill (the tracking thread), and its Python pipeline is not documented as thread-safe.
5. **O-5:** RapidOCR (OpenCV convention) expects BGR arrays but receives RGB or RGBA arrays from PIL.

## Root cause / context

- `upload_activity_batch()` runs the backfill in the tracking thread, then immediately calls `harvest_and_clear()`. Re-queueing skipped screenshots (the analysis doc's first idea) would not help, because their sessions are harvested and uploaded in the same batch, so a later backfill finds no row.
- The facade's circuit breaker counts failures but never sets a backoff in this codebase, so the old build's "all OCR off for 120 s" does not occur here. Only the lock issues remain.

## Proposed solution

1. **Time-budgeted backfill:** replace `MAX_BACKFILL_PER_BATCH = 3` with `BACKFILL_TIME_BUDGET_S = 20`. Process pending entries newest first until the budget is used. Log the number skipped. This is extracted into `TimeTracker._backfill_pending_ocr(pending, budget_s, clock)` so it can be tested.
2. **In-flight counter:** `LocalOCRProcessor` counts jobs under a `Condition`. The count goes up before `put_nowait` (and back down on `queue.Full`), and down after the callback. `wait_for_ocr(timeout)` waits until the count is 0.
3. **Failed result replaceable:** `backfill_ocr` also writes when the stored `ocr_method` is `metadata` or `error` and the new result has text.
4. **Honest outcomes in the facade:**
   - `success=False` with an `error` becomes "Engine error: <message>" and increments the engine failure count.
   - `success=True` with empty text becomes "No text found" and is not counted as a failure.
   - Low confidence keeps its current message.
5. **Locks:** `get_facade()` / `reset_facade()` construct under a module lock. `extract_text` serializes each engine's inference with a per-engine lock.
6. **BGR input:** `RapidOCREngine.extract_text` converts 3-channel RGB to BGR, RGBA to BGR, and grayscale to BGR before inference.

## Acceptance criteria

1. With two jobs in flight (one running, one queued), `wait_for_ocr(0.1)` returns False after the first finishes, and True only after the second finishes.
2. A `queue.Full` submit does not change the in-flight count.
3. `backfill_ocr` replaces a stored `metadata`/`error` result that has no text with a successful one, and never overwrites an existing successful result.
4. The backfill processes entries newest first and stops when the time budget is used. All entries within the budget are processed (more than 3 when time allows).
5. An engine error result makes the facade report `Engine error: <message>` and increments that engine's failure count.
6. An engine success with empty text makes the facade report `No text found` and leaves the failure count at 0.
7. Concurrent `get_facade()` calls build exactly one facade.
8. RapidOCR receives a 3-channel BGR array for RGB, RGBA and grayscale input.

## Out of scope

- The 40-line / 2000-character caps (O-6) and the WinRT hard-coded confidence.
- Moving the backfill off the tracking thread (larger refactor; revisit if the 20 s budget causes visible lag).
