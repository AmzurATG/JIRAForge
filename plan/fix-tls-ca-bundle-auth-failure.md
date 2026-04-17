# Fix: TLS CA Certificate Bundle Authentication Failure

## Problem

Users with PostgreSQL 14-17 installed on Windows see **"Authentication Failed"** (error type `UNKNOWN`) when logging into the desktop app. The detail line reads:

```
Could not find a suitable TLS CA certificate bundle, invalid path:
C:\Program Files\PostgreSQL\17\ssl\certs\ca-bundle.crt
```

The PostgreSQL Windows installer (EnterpriseDB build) sets the system environment variable `CURL_CA_BUNDLE` (and sometimes `REQUESTS_CA_BUNDLE`) to that path, but never ships the file. Python's `requests` library checks `REQUESTS_CA_BUNDLE` first, then `CURL_CA_BUNDLE` before falling back to `certifi`. When either variable points to a missing file, `requests` raises an `OSError` before any TCP connection is attempted, killing the very first HTTPS call the app makes.

## Affected code path

1. User completes Atlassian OAuth and is redirected to `localhost:51777/auth/callback?code=...&state=...`
2. `auth_callback()` (`desktop_app.py:4815`) enters the `try` block
3. `handle_callback()` (`desktop_app.py:1588`) calls `requests.post()` to `https://forgesync.amzur.com/api/auth/atlassian/callback` (`desktop_app.py:1616`)
4. `requests` resolves the CA bundle via env vars and raises `OSError` before the socket opens
5. The retry loop (`desktop_app.py:1614-1634`) only catches `ConnectTimeout`, `ConnectionError`, and `Timeout` -- `OSError` is not a subclass of any of these, so it propagates out
6. The outer `except Exception` (`desktop_app.py:4926`) catches it. The error message contains none of the category keywords (`timeout`, `connection`, `token`, `state`, `access denied`, `not found`) so it falls into `unknown`
7. User sees "Please try again. If the problem persists, contact support." with no actionable guidance

## Changes

Three changes in a single file: `python-desktop-app/desktop_app.py`.

---

### Change 1 -- Sanitize CA-bundle env vars at startup

**File:** `desktop_app.py`  
**Location:** After the existing `import os` (line 6), before `import requests` (line 27)  
**What:** Insert an early block that detects broken CA-bundle env vars and overrides them with `certifi.where()`.

Insert after line 6 (`import os`), before any other imports that pull in `requests` or `urllib3`:

```python
import certifi as _certifi_startup

_certifi_bundle = _certifi_startup.where()
for _var in ('REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'SSL_CERT_FILE'):
    _existing = os.environ.get(_var)
    if not _existing or not os.path.isfile(_existing):
        os.environ[_var] = _certifi_bundle
del _certifi_startup, _certifi_bundle, _var, _existing
```

**Why each variable:**

| Variable | Who reads it | Why include |
|---|---|---|
| `REQUESTS_CA_BUNDLE` | `requests` (highest priority) | Primary fix for the failing `requests.post()` call |
| `CURL_CA_BUNDLE` | `requests` (fallback if `REQUESTS_CA_BUNDLE` unset) | This is the one PostgreSQL actually sets |
| `SSL_CERT_FILE` | `urllib3`, Python `ssl` stdlib module | `supabase-py` and other libs that use `urllib3` directly |

**Safety:** Only overwrites if the existing value is empty or points to a non-existent file. A corporate user with a legitimate internal CA bundle (ZScaler, Netskope, etc.) will have a real file and won't be affected.

**PyInstaller compatibility:** `certifi` data is already collected into the exe bundle via `desktop_app.spec` line 226 (`runtime_datas += collect_data_files('certifi')`), so `certifi.where()` resolves to a physical `.pem` file in both dev and packaged builds.

---

### Change 2 -- Add `tls_config` error category

**File:** `desktop_app.py`  
**Location:** Error categorizer at lines 4934-4946  
**What:** Add a new `elif` branch after the existing `'not_found'` check so TLS/SSL errors get their own category instead of falling into `unknown`.

After line 4946 (`error_category = 'not_found'`), add:

```python
elif ('ca certificate' in error_lower
      or 'certificate bundle' in error_lower
      or 'ca-bundle' in error_lower
      or 'ca_bundle' in error_lower
      or 'ssl: certificate_verify_failed' in error_lower):
    error_category = 'tls_config'
```

This covers:
- The exact PostgreSQL error: `"could not find a suitable tls ca certificate bundle"`
- Generic SSL verification failures: `"ssl: certificate_verify_failed"`
- Variations in bundle naming: `ca-bundle`, `ca_bundle`

---

### Change 3 -- Add user-facing hint for `tls_config` category

**File:** `desktop_app.py`  
**Location:** Hint messages at lines 4966-4977  
**What:** Add a new `elif` branch before the final `else` to display an actionable message when `error_category == 'tls_config'`.

Before line 4976 (`else:`), add:

```python
elif error_category == 'tls_config':
    retry_hint = (
        "Your system's TLS certificate configuration is broken. "
        "Another program (often PostgreSQL) set the CURL_CA_BUNDLE or "
        "REQUESTS_CA_BUNDLE environment variable to a file that doesn't exist. "
        "Open Windows System Properties > Environment Variables, delete "
        "the CURL_CA_BUNDLE and REQUESTS_CA_BUNDLE entries, then restart the app."
    )
```

**Note:** This hint only fires if Change 1 (startup sanitization) didn't prevent the error -- e.g. certifi bundle itself is corrupt. Since Changes 1-3 ship together, this is a last-resort fallback with actionable manual steps, not a prompt to update.

---

## Spec file and requirements.txt -- NO changes needed

**`desktop_app.spec`:** Already handles `certifi` completely:
- Line 226: `runtime_datas += collect_data_files('certifi')` -- bundles the `.pem` CA bundle into the exe
- Lines 282 and 322: `'certifi'` in `hiddenimports` -- ensures PyInstaller includes the module

So `certifi.where()` resolves to the real `.pem` file inside the unpacked `_MEI...` directory at runtime. No spec changes.

**`requirements.txt`:** `certifi` is not explicitly listed, but it is a mandatory transitive dependency of `requests==2.31.0` (requests requires `certifi>=2017.4.17`), so it is always installed via `pip install -r requirements.txt`. No changes required. Optionally you could add `certifi>=2017.4.17` for explicitness since we now import it directly, but it is not functionally necessary.

## Impact on existing functionality -- NONE

All three changes are strictly additive and only activate when something is already broken:

| Change | When it fires | Effect on normal (happy-path) users |
|---|---|---|
| Env var sanitization | Only when an env var is empty OR points to a non-existent file (`os.path.isfile()` returns False) | **None.** If no env var is set, `requests` already uses `certifi` as default -- we just make that explicit. If a valid corporate CA bundle is set, `isfile()` returns True and we leave it alone. |
| New `tls_config` error category | Only when the error string contains `'ca certificate'`, `'certificate bundle'`, etc. -- strings that previously fell into `unknown` | **None.** All existing categories (`timeout`, `connection`, `token_exchange`, `state_mismatch`, `access_denied`, `not_found`) are checked first via earlier `elif` branches. The new branch only catches errors that were previously bucketed as `unknown`. |
| New hint message | Only when `error_category == 'tls_config'` | **None.** Existing `if/elif/else` chain is untouched. New branch sits before `else` and only fires for the new category. All existing hints remain identical. |

For any user without a broken `CURL_CA_BUNDLE`/`REQUESTS_CA_BUNDLE` env var, all three changes are invisible -- the code paths that exist today produce identical results.

## Changes NOT needed

- **AI server (`ai-server/`):** No changes. The server is not involved; the HTTPS call fails before leaving the desktop machine.
- **Forge app (`forge-app/`):** No changes. The Forge app runs in Atlassian's cloud, not on the user's machine.
- **Supabase migrations:** No changes. The database and RLS policies are not involved.
- **`handle_callback` retry loop (lines 1614-1634):** Not necessary to add `OSError` to the retry catch list. After Change 1, the `OSError` will never be raised because the env var is sanitized before any HTTPS call. Adding it to the retry loop would mask the symptom without fixing the root cause and could retry on unrelated filesystem errors.
- **`initialize_supabase` silent failure (line 4737-4743):** Separate issue (JWT not being set still returns `True`). Worth fixing eventually but unrelated to this TLS bug.

## Testing

1. **Reproduce:** On a Windows machine, set `CURL_CA_BUNDLE=C:\nonexistent\ca-bundle.crt` as a system env var. Launch the desktop app and attempt login. Confirm "Authentication Failed" with the TLS error detail.
2. **Verify Change 1:** Apply the startup block. Restart the app (same broken env var still set). Login should now succeed because `certifi.where()` overrides the broken value at runtime.
3. **Verify Changes 2+3:** Temporarily comment out Change 1. Retry login. Confirm the error page now shows category `TLS_CONFIG` with the actionable hint instead of `UNKNOWN`.
4. **Verify no regression with corporate CA:** Set `REQUESTS_CA_BUNDLE` to a valid `.pem` file. Confirm the startup block leaves it untouched (the `os.path.isfile` check passes, so no override).

## User-side workaround (immediate, no code change)

For the affected user before the next release ships:

1. Open **Command Prompt** and run:
   ```cmd
   set | findstr /I "CA_BUNDLE SSL_CERT"
   ```
   Identify which variable points to the PostgreSQL path.

2. Open **System Properties > Environment Variables** (`Win+R` > `sysdm.cpl` > Advanced > Environment Variables).

3. Under System variables, find `CURL_CA_BUNDLE` (and `REQUESTS_CA_BUNDLE` if present). **Delete** both entries.

4. Close and reopen the desktop app. Retry login.

## References

- [Medium -- Resolving TLS CA Certificate Bundle Issue in Windows 11](https://medium.com/@augustusinyang/resolving-tls-ca-certificate-bundle-issue-in-windows-11-cd32038f7c90)
- [Azure CLI #29872 -- PostgreSQL folder CA bundle path](https://github.com/Azure/azure-cli/issues/29872)
- [python-poetry #9388 -- Same PostgreSQL 16 error](https://github.com/orgs/python-poetry/discussions/9388)
- [PyInstaller #6352 -- CA bundle with frozen apps](https://github.com/pyinstaller/pyinstaller/issues/6352)
- [psf/requests #2899 -- SSL_CERT_FILE support discussion](https://github.com/psf/requests/issues/2899)
- [Requests docs -- Advanced Usage, CA bundle](https://requests.readthedocs.io/en/latest/user/advanced/)
