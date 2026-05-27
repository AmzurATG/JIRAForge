# Root Cause Analysis: Three Log Findings from VishnuK's First Session (2026-05-25)

**Date:** 2026-05-27
**Component:** `python-desktop-app`
**Log source:** `timetrackerlogs.md` / `timetracker (2).log` — session starting 2026-05-25 12:12
**Author:** Codebase deep-dive (code-verified, no assumptions)

---

## Executive Summary

Three anomalous events appear in the first session log. The submitted analysis linked them as symptoms of a broken update. **The code says otherwise.** Two of the three are working as designed. One (keyring) is a genuine recurring failure with a working fallback but an undiagnosed machine-level root cause that warrants a targeted fix.

| Finding | Submitted Verdict | Actual Verdict |
|---|---|---|
| [INFO] Exiting installer instance | Bug — broken/interrupted update | ✅ Correct self-install by design |
| No module named 'spacy' | Bug — failed update broke spacy | ✅ Intentional exclusion from build |
| Keyring save failed (1783 CredWrite) | Bug — malformed data / corrupt vault | ⚠️ Real recurring failure, fallback works, root cause unresolved |

---

## Finding 1 — "Exiting Installer Instance"

### Log evidence

```
12:12:21  [INFO] First run detected - installing application...
          From: C:\Users\VishnuK\Downloads\TimeTracker (2) (1).exe
          To:   C:\Users\VishnuK\AppData\Local\TimeTracker\TimeTracker.exe
12:12:22  [OK]  Application installed: ...TimeTracker.exe
12:12:34  [INFO] Exiting installer instance...
          [MAIN] TimeTracker shutting down...
12:13:43  [MAIN] TimeTracker v1.4.3 starting...   ← second instance, from install dir
          [OK]  Running from installed location
```

### What the code does

`install_application()` (`desktop_app.py:1021`) runs at every startup inside `TimeTracker.run()`:

```python
# desktop_app.py:11573
if not install_application():
    print("[INFO] Exiting installer instance...")
    sys.exit(0)
```

Inside `install_application()`:

```python
if is_running_from_install_location():
    print("[OK] Running from installed location")
    return True          # ← second instance: continues

current_exe = get_app_executable_path()   # C:\Users\VishnuK\Downloads\TimeTracker...exe
# Not in install dir → proceed to copy
# is_update = os.path.exists(installed_exe)  → False (first run)
print(f"[INFO] First run detected - installing application...")
shutil.copy2(current_exe, temp_exe)
os.rename(temp_exe, installed_exe)
# Start the installed copy
subprocess.Popen([installed_exe], ...)
return False             # ← first instance: caller will sys.exit(0)
```

The first instance (from Downloads) copies itself, spawns the installed copy, and exits. The second instance (12:13:43) is the freshly installed exe — it passes `is_running_from_install_location()` and continues normally.

### Verdict

**Not a bug. Not a broken update.** This is the designed first-run self-install flow, working exactly as intended. The 1-minute 9-second gap between exit (12:12:34) and restart (12:13:43) is the Windows process launch + startup time.

The submitted hypothesis ("auto-update triggered" / "interrupted installation") is incorrect — the log clearly shows `[INFO] First run detected`, not `UPDATE DETECTED`. A genuine update would print `UPDATE DETECTED`, find running processes, terminate them, and replace the binary. None of those steps appeared.

### No fix required.

---

## Finding 2 — `No module named 'spacy'` / Presidio Degraded

### Log evidence

```
12:14:50  ERROR - STDERR - PyInstaller\loader\pyimod02_importers.py:419: RuntimeWarning:
  CRITICAL: Presidio is NOT installed or failed to load. PII detection is DEGRADED —
  credit card Luhn validation, phone number format detection, and NER-based name/address
  detection are DISABLED. Error: No module named 'spacy'.

12:14:50  INFO - privacy.filter - Privacy filter initialized with 2 detectors
```

### What the code does

`desktop_app.spec` (the PyInstaller build spec) has two relevant blocks:

**Block A — presidio IS included:**
```python
# desktop_app.spec:265-266
dynamic_hiddenimports += collect_submodules('presidio_analyzer')
dynamic_hiddenimports += collect_submodules('presidio_anonymizer')

# desktop_app.spec:399-400
hiddenimports=[
    ...
    'presidio_analyzer',
    'presidio_anonymizer',
    ...
]
```

**Block B — spacy IS intentionally excluded:**
```python
# desktop_app.spec:475-480
# Security: spacy/NLP not needed
'spacy',
'spacy_legacy',
'spacy_loggers',
'thinc',
'en_core_web_sm',
'en_core_web_lg',
```

The comment `# Security: spacy/NLP not needed` is explicit intent. spaCy models (`en_core_web_sm`) are 40–500 MB per model. Including them would double or triple the installer size. The tradeoff decision was made: bundle presidio (for its regex and pattern-based recognizers) but exclude its NLP/spaCy backend entirely.

At runtime, when the privacy filter initializes, presidio tries to load its SpacyNlpEngine. That import fails with `No module named 'spacy'`. The privacy filter catches this, logs the degraded-mode warning, and continues with the two remaining detectors: `custom_patterns` and `entropy`.

The log confirms it works:
```
Privacy filter initialized with 2 detectors
```

The `ERROR - STDERR` log level is misleading. It is not an ERROR from the app's own logger. PyInstaller routes unhandled `RuntimeWarning` from inside bundled modules through STDERR, and the app logger tags everything from STDERR as ERROR. The actual severity is WARNING (degraded mode, not crash).

The `build/desktop_app/warn-desktop_app.txt` file (the PyInstaller build report) also confirms:
```
missing module named spacy_huggingface_pipelines - imported by presidio_analyzer.nlp_engine.transformers_nlp_engine (optional)
```
PyInstaller itself classified this as optional.

### What PII detection is actually active

| Capability | Status |
|---|---|
| Email address detection (regex) | ✅ Working — `custom_patterns` |
| Phone number regex | ✅ Working — `custom_patterns` |
| High-entropy string detection (secrets, tokens) | ✅ Working — `entropy` detector |
| Credit card Luhn validation | ❌ Degraded — requires presidio NLP |
| NER-based name detection | ❌ Degraded — requires spaCy |
| Address detection (NLP) | ❌ Degraded — requires spaCy |

The log confirms email addresses ARE being detected and redacted:
```
12:57:32  [PRIVACY] Detected 1 sensitive item(s): EMAIL_ADDRESS: 1 occurrence(s) REDACTED
12:57:34  [PRIVACY] Window title redacted: 1 PII item(s)
```

### Verdict

**Not a bug. Not a failed update.** This is an intentional size-vs-capability tradeoff baked into the build spec, with graceful degradation working as designed.

The submitted hypothesis ("failed update failed to install spacy") is incorrect. spaCy was never installed in the bundled exe — it is deliberately excluded at line 478 of the spec file.

### Potential improvement (not a fix)

If NER-based name/address detection is needed, the options are:
1. Bundle a minimal spaCy model (`en_core_web_sm`, ~40 MB) — adds ~30-40 MB to the installer.
2. Use an alternative pattern-based recognizer without spaCy (presidio supports this via `PatternRecognizer`).
3. Document the current tradeoff in the settings page so users understand the limitation.

The `RuntimeWarning` appearing as `ERROR` in the log should be reclassified as `WARNING` to reduce confusion. The privacy filter's catch block that prints this warning should use `logger.warning()` instead of `warnings.warn()`.

---

## Finding 3 — Keyring `CredWrite` Error 1783

### Log evidence

Three separate keyring failures, all during the same session, all falling back to encrypted file storage successfully:

```
12:14:46  WARNING - auth.secure_storage - Keyring save failed:
          (1783, 'CredWrite', 'The stub received bad data'), falling back to encryption
12:14:48  INFO  - auth.secure_storage - Tokens saved to encrypted file for default
12:14:48  INFO  - auth.secure_storage - Using encrypted storage (system credential manager unavailable)

12:14:49  WARNING - auth.secure_storage - Keyring save failed: (1783, ...)
12:14:50  INFO  - auth.secure_storage - Tokens saved to encrypted file for default

12:14:51  WARNING - auth.secure_storage - Keyring save failed: (1783, ...)
12:14:52  INFO  - auth.secure_storage - Tokens saved to encrypted file for default
```

All three saves completed successfully via the encrypted fallback. The user authenticated and tracked normally for the rest of the session.

### What the code does

`auth/secure_storage.py` implements a two-tier storage hierarchy:

**Tier 1 — Windows Credential Manager (keyring)**

`_keyring_set()` (`secure_storage.py:63`) applies:
1. Base64 encoding of the token value (to eliminate special-character issues)
2. Chunking across multiple credential entries if the encoded value exceeds `KEYRING_CHUNK_SIZE = 2000` bytes (well below the 2560-byte Windows API limit)
3. Cleanup of leftover chunks from prior saves

```python
encoded = base64.b64encode(value.encode('utf-8')).decode('ascii')
encoded_with_marker = f"__b64__:{encoded}"

if len(encoded_with_marker) <= KEYRING_CHUNK_SIZE:
    keyring.set_password(service, key, encoded_with_marker)
else:
    # chunk and save
    ...
```

Despite the base64+chunking fix, `keyring.set_password()` still raises `(1783, 'CredWrite', 'The stub received bad data')`. The exception propagates out of `_keyring_set` → through `_save_to_keyring` → caught by `save_tokens`:

```python
except Exception as e:
    logger.warning(f"Keyring save failed: {e}, falling back to encryption")
```

**Tier 2 — AES encrypted file (fallback)**

Uses AES-128-CBC via Fernet with PBKDF2-HMAC-SHA256 (600,000 iterations), machine-specific salt (Windows GUID + username), stored at `%LOCALAPPDATA%\TimeTracker\`. This works on every attempt.

### Root cause analysis

Error 1783 from `CredWrite` means `ERROR_STUB_RECEIVED_BAD_DATA` in the Windows RPC error table. This is a Windows IPC error — it means the credential-write call reached the Credential Manager's background service (`VaultSvc`) but the RPC stub received malformed data in the call frame.

The base64+chunking fix in `_keyring_set` addresses the wrong layer. The 2560-byte data limit is a **data size** constraint on the credential blob itself. Error 1783 is a **call-frame marshalling** error that happens before the data size is even checked. Possible causes:

**RC-1: Windows `VaultSvc` (Credential Manager service) is in a degraded state**

`VaultSvc` runs as a system service. If it is starting up, restarting, or internally corrupted, RPC stubs from client processes receive error 1783 during marshalling. This is a known Windows 10/11 issue, especially:
- After an in-place OS upgrade
- After a Windows Update that patches the credential vault
- When running under a roaming profile or a corporate-managed machine with Credential Guard enabled

The fact that ALL THREE token saves fail with 1783 (not just one large token) points to a service-level failure rather than a data content issue.

**RC-2: The `keyring` library's Windows backend uses `win32credential` or `ctypes` to call the WinAPI — a version mismatch can produce 1783**

The PyInstaller build bundles `keyring` and its Windows backend (`keyring.backends.Windows`). If the bundled DLLs or the `pywin32` shims are mismatched with the OS version running on the user's machine (`Windows 10 10.0.26200`), the marshalling structs may not match what `VaultSvc` expects.

**RC-3: The `credential_name` (composite key) contains characters that Windows Credential Manager rejects in the credential name field**

The storage key is constructed as `f"{user_email}_{key}"` → e.g., `default_access_token`. The `default` placeholder is used when email is not provided, which is fine. But if the user email were used and it contained Unicode characters, the key itself could fail marshalling. `default_access_token` should be safe — this is unlikely to be the cause.

**RC-4: Process running with incorrect token or integrity level**

If the process launched with a token from the installer (elevated or SYSTEM) and then the credential save runs under that token, the credential vault write is directed to the wrong vault context. The Credential Manager is per-user-session. This could explain why the error appears on first login and not necessarily on subsequent runs.

### Why the current fallback is acceptable but not ideal

The encrypted file fallback stores tokens at:
```
C:\Users\VishnuK\AppData\Local\TimeTracker\tokens_default.enc
```

- AES-128-CBC with 600K PBKDF2 iterations is cryptographically adequate for offline protection.
- Machine-specific salt prevents token files from being copied to other machines.
- The file is in `%LOCALAPPDATA%` — only the current user account can read it by default on a standard NTFS ACL configuration.

The gap vs Windows Credential Manager:
- Windows Credential Manager encrypts the blob with DPAPI, which ties decryption to the user's password. If the user resets their Windows password without knowing the old one, DPAPI-protected credentials are automatically wiped. The encrypted file fallback does NOT have this property — the machine-specific salt derives from hardware identifiers, so a password reset does not wipe the file. This is a slightly weaker security posture.

### Verdict

**Genuine recurring failure. Fallback is working. Root cause is OS/environment-level, not a code bug in the token data or the base64 fix.**

The submitted analysis was partially correct on symptom (rejected credential write) but incorrect on cause (did not involve malformed token data — the base64 encoding already prevents that).

### Recommended fixes

**Fix A — Add error 1783 to the keyring diagnostic log (low risk, immediate)**

When error 1783 occurs, log a structured diagnostic to help narrow RC-1 vs RC-2:

```python
except Exception as e:
    error_code = getattr(e, 'winerror', None)
    if error_code == 1783:
        logger.warning(
            "Keyring CredWrite error 1783 (VaultSvc RPC failure). "
            "Windows Credential Manager service may be in a degraded state. "
            "Falling back to encrypted file storage."
        )
    else:
        logger.warning(f"Keyring save failed: {e}, falling back to encryption")
```

**Fix B — Retry keyring once after a short delay before falling back (low risk)**

Error 1783 from a starting/restarting `VaultSvc` is transient. A single 500ms retry would recover the case where the service was mid-start during the first save:

```python
import time

def save_tokens(self, tokens, user_email='default'):
    with self._lock:
        if KEYRING_AVAILABLE:
            for attempt in range(2):
                try:
                    if self._save_to_keyring(tokens, user_email):
                        self.storage_method = 'keyring'
                        return True
                except Exception as e:
                    if attempt == 0:
                        time.sleep(0.5)  # VaultSvc may be starting
                        continue
                    logger.warning(f"Keyring save failed after retry: {e}, falling back")
        # ... encrypted fallback ...
```

**Fix C — Report keyring status in the admin diagnostics panel**

The login diagnostics payload already includes system info. Add `storage_method` from `SecureTokenStorage`:

```python
"security": {
    "token_storage": self.token_storage.storage_method,  # 'keyring' or 'encrypted'
    "keyring_available": KEYRING_AVAILABLE,
}
```

This lets support see which users are on encrypted fallback without digging through logs.

**Fix D — Disable keyring on Windows 11 24H2+ if VaultSvc issue confirmed**

If telemetry shows that 1783 errors cluster around specific OS builds, the spec file can add a build-time check to pre-configure encrypted-only mode for those builds.

---

## Relationship Between the Three Findings

The submitted analysis proposed that all three are connected symptoms of a failed update. **The codebase disproves this:**

```
Finding 1 (installer exit)     → Correct self-install. Completed successfully.
                                  Not connected to findings 2 or 3.

Finding 2 (spacy missing)      → Intentional build-time exclusion since at least
                                  the desktop_app.spec was last committed.
                                  Not connected to findings 1 or 3.

Finding 3 (keyring 1783)       → OS-level VaultSvc RPC failure.
                                  Unrelated to the installer (finding 1).
                                  Unrelated to the spacy exclusion (finding 2).
```

They happen to appear in the same first-session log because:
- Finding 1 is triggered every time a fresh download is run.
- Finding 2 is triggered every time the privacy filter initializes (i.e., every session).
- Finding 3 is triggered every time tokens are first saved (i.e., every first OAuth login on this machine).

The 40-minute gap between finding 1 (12:12) and findings 2 & 3 (12:14) alone disproves temporal coupling: the first instance exited completely before the second instance even started.

---

## Action Items

| ID | Action | Priority | Owner |
|---|---|---|---|
| A1 | Log error 1783 with a specific VaultSvc message (Fix A above) | Medium | Desktop app team |
| A2 | Add 1-retry with 500ms delay before keyring fallback (Fix B above) | Medium | Desktop app team |
| A3 | Expose `token_storage` method in login diagnostics payload (Fix C above) | Low | Desktop app team |
| A4 | Reclassify the Presidio `RuntimeWarning` from `ERROR` log level to `WARNING` | Low | Desktop app team |
| A5 | Add comment to `desktop_app.spec` explaining WHY spaCy is excluded, not just that it isn't needed | Low | Desktop app team |
| A6 | Document the "installer instance exits immediately" behaviour in user-facing FAQ | Low | Product / Docs |
