# Fix Plan: SSL Certificate, PGRST102 Batch Poisoning & Session Timer

**Date:** 2026-05-27  
**Branch:** `fix/ssl-pgrst102-session-timer`  
**Files Changed:** `desktop_app.py`, `desktop_app.spec`

---

## Overview

Three bugs were identified from production logs (`timetracker (3).log`, user MuraliP, 2026-05-26).  
Two required source-code fixes; one is resolved by a binary rebuild from current source.

---

## Bug 1 — PGRST102 "All object keys must match" (Root Cause)

**Severity:** High — silently drops idle time records on every batch upload  
**File:** `desktop_app.py` → `_create_idle_record()` (~line 10079)

### Root Cause
`_create_idle_record()` produced idle records with two extra top-level keys that no work
record ever has:

```python
# OLD — caused PGRST102
'idle_start_time': self.idle_start_time.isoformat(),
'idle_end_time':   idle_end.isoformat(),
```

PostgREST (`PGRST102`) rejects a bulk `INSERT` array when different objects in the array
carry different key sets. Mixing work records (no `idle_start_time`) with idle records
(has `idle_start_time`) caused every combined-batch request to return HTTP 400.

The existing fallback (retry work sessions without idle records) masked the symptom but
idle time was silently discarded every cycle.

### Fix Applied
Removed `idle_start_time` and `idle_end_time` from the idle record dict.  
Both fields are **fully redundant** with `start_time` and `end_time`, which are already
present in idle records and match the work-record schema exactly.

```python
# NEW — all records now have identical top-level keys
# idle_start_time / idle_end_time intentionally omitted.
# start_time / end_time carry the same information.
```

### Verification
- All records in a batch now share the same key set → no PGRST102.
- `start_time` / `end_time` on idle records still correctly bound the idle window.
- The work-only fallback retry path is kept as a safety net for unrelated schema errors.

---

## Bug 2 — SSL/TLS Certificate Bundle Not Found (Two-Layer Fix)

**Severity:** Critical (when triggered) — all HTTPS calls fail, no data syncs  
**Files:** `desktop_app.py` (startup), `desktop_app.spec` (build)

### Root Cause
When running as a PyInstaller `.exe`, `certifi.where()` returns the expected path inside
the temporary extraction directory (`_MEI…\certifi\cacert.pem`). If the `.pem` file is
missing from the bundle (e.g., built from an older spec), the existing startup fix:

```python
# OLD — sets env var unconditionally, even to a non-existent path
os.environ[_var] = _certifi_bundle
```

…would set `REQUESTS_CA_BUNDLE` to a path that does not exist, making every subsequent
`requests` / `httpx` call raise:

```
OSError: Could not find a suitable TLS CA certificate bundle,
         invalid path: C:\…\_MEI107402\certifi\cacert.pem
```

### Fix 1 — `desktop_app.py` startup hardening (~line 28)

```python
import certifi as _certifi_startup
import sys as _sys_certifi
_certifi_bundle = _certifi_startup.where()
if not os.path.isfile(_certifi_bundle):
    # PyInstaller bundle: fall back to canonical extraction path
    _meipass = getattr(_sys_certifi, '_MEIPASS', None)
    if _meipass:
        _candidate = os.path.join(_meipass, 'certifi', 'cacert.pem')
        if os.path.isfile(_candidate):
            _certifi_bundle = _candidate
for _var in ('REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'SSL_CERT_FILE'):
    _existing = os.environ.get(_var)
    if not _existing or not os.path.isfile(_existing):
        if os.path.isfile(_certifi_bundle):   # ← guard added
            os.environ[_var] = _certifi_bundle
del _certifi_startup, _sys_certifi, _certifi_bundle, _var, _existing
```

**Changes:**
- Validates `certifi.where()` is a real file before using it.
- If not, probes `sys._MEIPASS/certifi/cacert.pem` (the canonical PyInstaller location).
- Only sets the env var when the resolved path is confirmed to exist on disk.

### Fix 2 — `desktop_app.spec` explicit bundling (~line 287)

```python
runtime_datas += collect_data_files('certifi')
# Belt-and-suspenders: explicit copy of cacert.pem
try:
    import certifi as _certifi_spec
    _cacert_src = _certifi_spec.where()
    if os.path.isfile(_cacert_src):
        runtime_datas.append((_cacert_src, 'certifi'))
    del _certifi_spec, _cacert_src
except Exception as _e:
    print(f"[WARN] Could not explicitly bundle certifi cacert.pem: {_e}")
```

**Why:** `collect_data_files('certifi')` can silently return an incorrect or empty list on
some build environments. The explicit `append` ensures `cacert.pem` is placed at
`<_MEIPASS>/certifi/cacert.pem` regardless.

---

## Bug 3 — AttributeError: `'ActiveSessionManager' object has no attribute 'start_new_timer'`

**Severity:** High — tracking loop crashes and restarts on every idle→active transition  
**File:** `desktop_app.py` → `ActiveSessionManager` / `resume_from_idle()`

### Root Cause
The log was produced by a **compiled binary built before `start_new_timer` was added**
to `ActiveSessionManager`. The current source (line 4590) already has the method:

```python
def start_new_timer(self):
    """Reset _current_key so the next window switch starts a fresh session."""
    with self._lock:
        self._current_key = None
```

And `resume_from_idle()` (line ~9979) calls it correctly.

### Fix
**No source code change required.** The binary must be rebuilt from the current source.

---

## Action Items

| # | Action | Owner | Status |
|---|--------|-------|--------|
| 1 | Remove `idle_start_time` / `idle_end_time` from `_create_idle_record` | Dev | ✅ Done |
| 2 | Harden certifi startup fix with `_MEIPASS` fallback (`desktop_app.py`) | Dev | ✅ Done |
| 3 | Add explicit `cacert.pem` copy in `desktop_app.spec` | Dev | ✅ Done |
| 4 | Rebuild and distribute new `.exe` from current source | Build | ⏳ Pending |
| 5 | Verify idle records appear in Supabase after next batch upload | QA | ⏳ Pending |
| 6 | Confirm no SSL errors in next production log | QA | ⏳ Pending |

---

## Out of Scope (Noted, No Code Change)

- **Jira zero-issue context** — Expected for new users with no active in-progress issues.
  The fallback to the full browsable project list is correct behaviour.
- **Presidio/spaCy PII degradation** — `presidio-analyzer` and `spacy` are optional
  dependencies intentionally excluded from the EXE bundle due to size. Custom pattern
  and entropy detectors remain active. No fix needed at code level.
