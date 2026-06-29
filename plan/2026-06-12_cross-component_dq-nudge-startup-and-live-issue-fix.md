# DQ Nudge Startup + Live Issue Scoring Reliability Fix

## Problem
Desktop description-quality nudges are unreliable during startup/restart and periodic runs. Live Jira issue scoring often receives only issue titles (missing description/file context), which drives very low scores and suppresses accurate popup behavior.

## Root cause / context
- In `ai-server/src/controllers/desktop-dq-nudges-controller.js`, live Jira issue analysis currently uses `fields.description` only when it is a string. Jira commonly returns ADF JSON, so description becomes empty.
- The same live path does not include attachment context in scoring input, so associated file signal is lost.
- In `python-desktop-app/desktop_app.py`, DQ poller startup is gated on a Supabase token and startup sync is a one-shot call. During restart/update/login transitions, token availability timing can skip startup nudge generation.
- Poll requests use a short timeout (`poll_once` default 10s), while live sync may take longer under load, causing missed interval cycles.

## Proposed solution
1. ai-server:
- Convert Jira ADF descriptions to plain text in the desktop live nudge controller using existing `extractDescriptionText` utility.
- Include lightweight attachment context (filename, mime type, size) in analysis input text and request the Jira `attachment` field in live fetches.
- Reuse the same normalized description handling for cached issue refresh paths (support plain string, ADF object, JSON-stringified ADF).

2. python-desktop-app:
- Start DQ poller even when tokens are not immediately available; let per-request auth header resolution handle token readiness.
- Make startup sync retry briefly when token/network is not ready so restart/update/login race conditions do not suppress the initial popup.
- Increase poll timeout to better tolerate live refresh latency while preserving interval behavior.

3. Tests:
- Add ai-server controller tests covering ADF description conversion and attachment-context inclusion in `analyzeDescription` calls.
- Add python desktop tests for startup sync retry behavior and interval poll timeout wiring.

## Acceptance criteria
1. Live desktop nudge analysis sends parsed Jira description text (not empty when description is ADF).
2. Live desktop nudge analysis includes attachment metadata context in the analysis payload.
3. On startup/restart/update, desktop app attempts startup nudge sync robustly and can still trigger popup once auth becomes ready.
4. The periodic poll path no longer drops cycles due to overly aggressive client timeout under normal server latency.
5. New/updated automated tests fail before changes and pass after implementation.

## Out of scope
- Reworking the core scoring rubric/prompts in `description-service`.
- Full binary ingestion of Jira attachments for desktop nudge live polling.
- UI redesign of popup/tray flows.