# Phase 1 gate results — Atlassian repeated-authorization behavior

Run: 2026-06-12T11:53:40.305691+00:00  
AI server: https://timetracker-forge.amzur.com  

| Step | Outcome | Detail |
|---|---|---|
| authorize A (attempt 1) | OK | code exchanged, chain established |
| authorize B (attempt 1) | OK | code exchanged, chain established |
| T1: refresh chain A AFTER authorization B was created | OK | refresh succeeded (chain alive, rotated) |
| T2: refresh chain B (newest grant) | OK | refresh succeeded (chain alive, rotated) |
| T3: refresh chain A again after chain B rotated | OK | refresh succeeded (chain alive, rotated) |
| T4: REUSE chain B's consumed token within the 10-min window | OK | refresh succeeded (chain alive, rotated) |

## Interpretation

- **T1 OK** -> old chains survive re-authorization: multi-device users are unaffected during rollout.
- **T1 REJECTED** -> a new login kills prior chains: a second-device login forces a one-time re-login on the first device (handled by the re-login prompt).
- **T4 OK** -> the 10-minute reuse interval is confirmed; the server-side same-token retry is safe.
