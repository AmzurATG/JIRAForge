# Email / Chat Body Redaction (Desktop App)

**Status:** implemented, tested, pushed
**Branch:** `feature/email-chat-redaction-timeline-palette`
**Commit:** `a2d74a0` — `feat(desktop): redact email/chat body to '***' (Gmail, Google Chat, Outlook)`
**Component:** `python-desktop-app/desktop_app.py` (+ test + tooling)
**No DB / schema / migration changes.**

---

## 1. Summary

When a user is in **Gmail, Google Chat, or Outlook**, the desktop tracker now **never
reads the on-screen body**. The activity record's body is stored as the literal
mask **`'***'`** (with `ocr_method='redacted_body'`), while the **window title is
still captured** and the activity is **still tracked** (time is counted). For every
other application the behaviour is unchanged (screen text is OCR'd as before).

The protection is achieved by **skipping OCR entirely** for these surfaces — the
screen is never captured/extracted, so email/chat content cannot be written to
local storage or uploaded. It is not "OCR then mask"; there is nothing to leak.

---

## 2. Requirement

> "Google chat conversations and the emails should also get `***` … capture the
> titles as you already do, just the body should get `***`."

Concretely:
- **Body** (the on-screen conversation/email text) → masked to `***`.
- **Title** → captured exactly as today (including the existing title-level PII filter).
- **Tracking** → the record is still created and uploaded, so time is still logged.

---

## 3. Behaviour: before vs after

| Surface | Before | After |
|---|---|---|
| Gmail / Google Chat / Outlook | OCR'd; body text extracted, per-span PII filter applied, uploaded | **No OCR.** Body stored as `'***'`; title kept; time tracked |
| VS Code / Jira / websites / everything else | OCR'd and uploaded | **Unchanged** — OCR'd and uploaded |
| Apps classified `private` / `non_productive` | No OCR already (body never captured) | Unchanged (no body captured) |

Why whole-body masking (not just PII spans): the existing per-token privacy filter
only masks specific entities (SSN, cards, some emails) and leaves most of an email
body — sender names, subject, message text, salary figures, bank/routing numbers,
meeting attendees — readable. Email/chat surfaces need the **entire** body withheld.

---

## 4. How it fits the capture pipeline

Live capture path (event-based `activity_records` pipeline):

```
tracking loop → get_active_window() → process_window_event(window_info)
   → classification_manager.classify(app, title)
   → redact_body = _should_redact_body(app, title)          # NEW gate
   → if productive/unknown:
        if redact_body:  ocr_result = { text:'***', method:'redacted_body' }   # NEW: no OCR
        else:            capture screenshot + dispatch async OCR                # unchanged
   → session_manager.on_window_switch(title, app, classification, ocr_result)
   → async OCR dispatch  … guarded with `and not redact_body`                  # NEW
→ upload_activity_batch(): classification stays productive/unknown → status='pending'
   → record uploaded with ocr_text='***', ocr_method='redacted_body'
```

Downstream: because the record keeps its `productive`/`unknown` classification, it
still flows to the AI server for matching — the model sees the **title** (which is
kept, still useful for matching a Jira key in a subject) and body `***`. No AI
server, Edge Function, or DB change was required.

---

## 5. Implementation details (`python-desktop-app/desktop_app.py`)

### 5.1 Surface-definition constants (≈ line 5048, next to `BROWSER_PROCESSES`)

```python
REDACTED_BODY_PLACEHOLDER = '***'
REDACTED_BODY_TITLE_MARKERS = (
    'gmail', 'mail.google.com',
    'google chat', 'chat.google.com',
    'outlook',
)
REDACTED_BODY_PROCESSES = {
    'outlook.exe', 'hxoutlook.exe', 'olk.exe',   # classic / new Outlook / newest
}
```

- Browser-based mail/chat (Gmail, Google Chat, Outlook web) all run inside a browser
  process (`chrome.exe`, `msedge.exe`, …) and **cannot be told apart by process
  name**, so they are matched by markers in the **window title**.
- Outlook **desktop** clients are matched by **process name**.
- To add/remove a surface, edit these two lists (single point of change).

### 5.2 The decision — `TimeTracker._should_redact_body()` (≈ line 10880)

```python
def _should_redact_body(self, app_name, window_title):
    app_lower = (app_name or '').lower().strip()
    if app_lower in REDACTED_BODY_PROCESSES:
        return True
    if app_lower in BROWSER_PROCESSES:
        title_lower = (window_title or '').lower()
        return any(m in title_lower for m in REDACTED_BODY_TITLE_MARKERS)
    return False
```

Uses no instance state (which is what lets the tests call it on a bare instance).

### 5.3 Capture gate — `process_window_event()` (≈ line 10898)

- `redact_body = self._should_redact_body(app_name, window_title)` computed right
  after classification (≈ line 10923).
- Inside the `productive`/`unknown` branch (≈ line 10953): when `redact_body`,
  set `ocr_result = {'text': '***', 'method': 'redacted_body', 'confidence': 1.0,
  'error_message': None}` and **skip** the screenshot + OCR entirely; otherwise the
  original capture logic runs.
- The async-OCR dispatch block is guarded with `and not redact_body`, so no
  screenshot is ever submitted for these surfaces.
- The **title** still runs through the existing window-title PII filter (that block
  is unchanged and runs for all non-`private` apps).

### 5.4 Defence in depth — `should_skip_screenshot()` (≈ line 10391)

```python
if self._should_redact_body(app_name, window_title):
    return (True, 'redacted_body_app')
```

The **legacy screenshot path** (`upload_screenshot`) is currently hard-disabled
(`SCREENSHOT_MONITORING_HARD_DISABLED = True`), so it never runs. This guard ensures
that even if screenshot monitoring is ever re-enabled, email/chat screens are still
never captured on that path. The loop's skip-reason log filter was extended to
include `'redacted_body_app'` (≈ line 12840).

---

## 6. Scope & configurability

**Covered surfaces:** Gmail (web), Google Chat (web), Outlook (web + desktop:
`outlook.exe`, `hxoutlook.exe`, `olk.exe`).

**Adjusting scope:** edit `REDACTED_BODY_TITLE_MARKERS` (browser surfaces) and/or
`REDACTED_BODY_PROCESSES` (desktop apps). E.g. remove `'outlook'` to exclude Outlook,
or add `'slack'`/`'teams'` markers / processes to extend to more chat apps.

---

## 7. Limitations / edge cases (by design)

- **Titles are still captured**, and the title-level filter only masks specific PII
  tokens. **People's names in titles are not masked** (`PERSON` is not in the
  privacy filter's `pii_types`), so a chat title like `Alice Smith - Google Chat`
  keeps the name. This matched the requirement ("capture the titles as you already
  do"). Adding `PERSON` masking to titles is a separate, higher-noise change.
- **Inclusive matching:** a browser tab merely *mentioning* a marker (e.g. a YouTube
  video titled "How to use Gmail") is treated as email/chat and masked. This errs
  toward privacy and is documented in the helper's docstring.
- **Outlook desktop process names** (`outlook.exe` / `hxoutlook.exe` / `olk.exe`) are
  the known set; verify against the specific Outlook build in your fleet.
- `private` / `non_productive` email/chat already never capture the body (no OCR), so
  they are unaffected by this change.

---

## 8. Data & DB impact

- **None.** No schema, migration, or table change.
- `activity_records.ocr_text` = `'***'`, `ocr_method` = `'redacted_body'`.
  `ocr_method` is free-text on `activity_records` (no CHECK constraint), so the new
  value inserts cleanly; even the legacy `^[a-z0-9_]+$` format rule would accept it.
- `classification` and `status` values are unchanged (productive/unknown → pending).

---

## 9. Testing

**File:** `python-desktop-app/tests/test_email_chat_body_redaction.py` — exercises the
**real shipped code** (imports `desktop_app`; calls the actual
`TimeTracker._should_redact_body`, the real `REDACTED_BODY_PLACEHOLDER`, and drives the
real `process_window_event`).

**9 pytest tests (all pass):**
- 5 decision-level: mask value is `'***'`; email/chat surfaces redacted; normal apps
  not redacted; empty/unknown inputs safe; target surfaces configured.
- 4 end-to-end: drive `process_window_event` against an in-memory SQLite session DB
  and assert the stored row has `ocr_text == '***'` and `ocr_method == 'redacted_body'`
  for Gmail and Outlook desktop; title preserved verbatim; a normal app is **not**
  masked.

**Human-readable proof report** (run the file directly): prints a 19-check PASS/FAIL
table with a `VERDICT` line and non-zero exit on failure.

**Run it:**
```bat
cd python-desktop-app
.venv\Scripts\python.exe -m pytest tests\test_email_chat_body_redaction.py -v   :: 9 passed
.venv\Scripts\python.exe tests\test_email_chat_body_redaction.py                :: proof report, 19/19
:: or: run_pytest.bat
```

**Tooling added:** `requirements-dev.txt` (pins `pytest`; not bundled into the EXE),
`run_pytest.bat` / `run_pytest.sh` (non-interactive runners that prefer the project
`.venv`). Note: the desktop app has no pre-existing pytest suite wired into
`run_tests.bat/.sh` (those wrap a custom harness), so this test is discovered via
`python -m pytest tests/`.

**Live/visual verification:** a standalone `redaction-sandbox` tool (outside this repo)
captures a real screen, OCRs it, and shows `[A]` what a normal site would capture vs
`[B]` the Gmail/Chat pipeline storing `***`. It is packaged as `RedactionSandbox.exe`
(no Python needed) for sharing proof with reviewers.

---

## 10. Dev-build configuration (bundled in this commit — per request)

This commit **also** points the desktop build at the **dev** environment. `desktop_app.py`
resolves config via `get_env_var()` with precedence `os.env → runtime → EMBEDDED_CONFIG
→ default`, and `EMBEDDED_CONFIG` is the value the PyInstaller build bakes into both the
app and the auto-updater (the build reads `EMBEDDED_CONFIG['AI_SERVER_URL']` as the
single source of truth for the HKLM updater URL).

Changed to dev:
| Setting | Dev value | Location |
|---|---|---|
| `ATLASSIAN_CLIENT_ID` | `Q8HT4Jn205AuTiAarj088oWNDrOqwvM5` | `EMBEDDED_CONFIG` (≈ line 403) |
| `GOOGLE_DESKTOP_CLIENT_ID` | `508843846019-…apps.googleusercontent.com` | `EMBEDDED_CONFIG` (≈ line 407) |
| `AI_SERVER_URL` | `https://forgesync.amzur.com` | `EMBEDDED_CONFIG` (≈ 410) **+** two `get_env_var` fallback defaults (≈ 2089, 3484) |

Notes:
- These are **public** client IDs only; the Atlassian/Google **secrets** stay on the
  AI server and are never in the desktop build.
- `EMBEDDED_CONFIG` wins over the two fallback defaults at runtime, so all
  `get_env_var('AI_SERVER_URL')` calls resolve to forgesync; the defaults are updated
  too for consistency ("all three places").
- The dev `ai-server` (`forgesync.amzur.com`) must be configured with the matching
  `ATLASSIAN_CLIENT_ID` + secret and `GOOGLE_DESKTOP_CLIENT_ID` + secret, or OAuth
  token exchange fails.

**⚠️ Revert for production builds:** before building for prod, set the three
`AI_SERVER_URL` occurrences back to `https://timetracker-forge.amzur.com` and
`ATLASSIAN_CLIENT_ID` back to `k2Xwzy8c1g3Wk6Xpbeev0x70CXEp9lJH` (and the prod Google
ID). Prod-URL fallbacks also exist outside `desktop_app.py` — `build.bat`,
`installer/TimeTracker.iss`, `installer/update_service.ps1` — which were **not**
changed here and would need switching only if you build the dev **installer**.

---

## 11. Files changed in this commit

- `python-desktop-app/desktop_app.py` — feature (constants, `_should_redact_body`,
  `process_window_event`, `should_skip_screenshot`, log filter) **+** dev-build config.
- `python-desktop-app/tests/test_email_chat_body_redaction.py` — new test/proof file.
- `python-desktop-app/requirements-dev.txt` — new (pytest).
- `python-desktop-app/run_pytest.bat`, `run_pytest.sh` — new runners.

Not in this repo/commit: the `redaction-sandbox/` demo tool lives outside `JIRAForge`
by design (it imports none of the app).

---

## 12. Follow-ups / open items

- Decide whether to roll body-masking to more chat apps (Slack/Teams) — one-line list edits.
- If names in email/chat **titles** must also be masked, add `PERSON` to the privacy
  filter `pii_types` (separate change; expect more false positives).
- Revert the dev-build config to prod before any production build/merge (see §10).
- Optional: add an `--env dev|prod` switch or `build_dev.bat` so dev/prod config can't be mixed up.
