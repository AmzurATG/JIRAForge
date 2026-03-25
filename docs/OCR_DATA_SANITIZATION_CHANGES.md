# OCR Data Sanitization — Implementation & Changes

**Date:** March 24, 2026  
**Branch:** `fix/time-summary-sync-dashboard`  
**Status:** Implemented — was incorrectly flagged as "CRITICAL GAP", now resolved  

---

## Executive Summary

An audit flagged OCR Data Sanitization as a **critical gap**, claiming the `PrivacyFilter` module was missing. Investigation revealed this was **incorrect** — the `privacy/` module existed, was well-implemented, and was wired into the OCR pipeline. However, the audit uncovered real configuration and coverage issues that have now been fixed.

### What Was Already Working
- Full `privacy/` module with detectors, redactors, and config
- `CustomPatternDetector` — regex-based detection for passwords, API keys, tokens (always active, no external dependencies)
- `PresidioDetector` — PII detection for credit cards, SSN, phone numbers (optional, via `presidio-analyzer`)
- `presidio-analyzer` and `presidio-anonymizer` in `requirements.txt`
- Privacy filter wired into OCR pipeline at `ocr/facade.py` → `_apply_privacy_filter()` runs on every OCR result
- Secure failure mode (`fail_open=false`) — on errors, text is replaced with `[PRIVACY_FILTER_ERROR]`

### What Was Fixed
| Issue | Severity | Resolution |
|-------|----------|------------|
| `PRIVACY_DETECT_PII` defaulted to `false` in `from_env()` | **High** | Changed default to `true` — Presidio now active out of the box |
| Privacy config was not delivered from AI server | **High** | Added privacy config to `POST /api/auth/ocr-config` response |
| Desktop app had no mechanism to receive server privacy config | **High** | Added `set_runtime_privacy_config()` to apply server-delivered config |
| No server-side OCR text sanitization before LLM | **Medium** | Added `sanitizeOcrText()` in `activity-service.js` as defense-in-depth |
| Privacy settings undocumented in AI server `.env.example` | **Low** | Added full `PRIVACY_*` section to AI server `.env.example` |

---

## Architecture Overview

### Two-Layer Sanitization Pipeline

```
┌──────────────────────────────────────────────────────────────────────┐
│                     DESKTOP APP (Layer 1)                            │
│                                                                      │
│  Screen Capture → OCR Engine → privacy/filter.py → Clean Text        │
│                                     │                                │
│                    ┌─────────────────┴─────────────────┐             │
│                    │      PrivacyFilter.redact()        │             │
│                    │                                    │             │
│                    │  ┌──────────────────────────────┐  │             │
│                    │  │ CustomPatternDetector         │  │             │
│                    │  │ (always active, no deps)      │  │             │
│                    │  │ • Passwords in URLs/configs   │  │             │
│                    │  │ • AWS access keys (AKIA...)   │  │             │
│                    │  │ • GitHub tokens (ghp_...)     │  │             │
│                    │  │ • API keys & bearer tokens    │  │             │
│                    │  │ • Private keys (PEM)          │  │             │
│                    │  │ • Connection strings           │  │             │
│                    │  │ • Database passwords           │  │             │
│                    │  │ • OAuth secrets                │  │             │
│                    │  └──────────────────────────────┘  │             │
│                    │                                    │             │
│                    │  ┌──────────────────────────────┐  │             │
│                    │  │ PresidioDetector              │  │             │
│                    │  │ (NOW enabled by default)      │  │             │
│                    │  │ • Credit card numbers (Luhn)  │  │             │
│                    │  │ • SSN (US format)             │  │             │
│                    │  │ • Phone numbers               │  │             │
│                    │  │ • Bank account numbers        │  │             │
│                    │  │ • Driver's license numbers    │  │             │
│                    │  │ • Passport numbers            │  │             │
│                    │  │ • IBAN codes                  │  │             │
│                    │  │ • IP addresses                │  │             │
│                    │  │ • Crypto wallet addresses     │  │             │
│                    │  │ • Medical license numbers     │  │             │
│                    │  └──────────────────────────────┘  │             │
│                    └────────────────────────────────────┘             │
│                                     │                                │
│                              Clean text uploaded                     │
│                              to Supabase / sent                      │
│                              to AI Server                            │
└──────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     AI SERVER (Layer 2 — Defense-in-depth)            │
│                                                                      │
│  OCR text received → sanitizeOcrText() → LLM Prompt                 │
│                           │                                          │
│              Server-side regex sanitization catches:                  │
│              • Credentials (password=, pwd=, secret=)                │
│              • AWS keys (AKIA...)                                     │
│              • GitHub tokens (ghp_, gho_, ghs_)                      │
│              • API keys (api_key=, apikey=)                          │
│              • Bearer tokens                                         │
│              • Credit card numbers (13-19 digits)                    │
│              • SSN (XXX-XX-XXXX format)                              │
│              • Private keys (PEM blocks)                             │
│              • Connection strings (mongodb://, postgres://, etc.)     │
│                                                                      │
│  Applied in:                                                         │
│  • buildBatchAnalysisPrompt() — activity-to-Jira matching            │
│  • buildClassificationPrompt() — app classification                  │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Detailed Changes

### 1. Enabled Presidio PII Detection by Default

**File:** `python-desktop-app/privacy/config.py`  
**Lines changed:** 104, 122

**Problem:** The `PrivacyConfig` dataclass had `detect_pii: bool = True`, but the `from_env()` classmethod defaulted the environment variable to `'false'`:

```python
# BEFORE (inconsistent — Presidio was OFF by default via env)
config.detect_pii = os.getenv('PRIVACY_DETECT_PII', 'false').lower() == 'true'
```

This meant that even though `presidio-analyzer` was installed (in `requirements.txt`), it was never activated unless someone explicitly set `PRIVACY_DETECT_PII=true` — which was undocumented.

```python
# AFTER (aligned — Presidio is ON by default)
config.detect_pii = os.getenv('PRIVACY_DETECT_PII', 'true').lower() == 'true'
```

The docstring was also updated to reflect `(default: true)`.

**Impact:** Credit card numbers, SSNs, phone numbers, bank account numbers, and other PII are now detected and redacted from OCR text by default.

---

### 2. Privacy Config Delivered from AI Server

**File:** `ai-server/src/controllers/auth-controller.js`  
**Lines added:** 568–582 (inside `getOcrConfig()`)

**Problem:** The desktop app fetches all OCR configuration from the AI server via `POST /api/auth/ocr-config`, but privacy settings were not included in the response. Since the desktop app doesn't use a local `.env` file, `PrivacyConfig.from_env()` always returned defaults.

**Solution:** Added a `privacy` object to the OCR config response:

```javascript
// Privacy filter configuration (delivered to desktop app alongside OCR config)
const privacyConfig = {
  enabled: (process.env.PRIVACY_FILTER_ENABLED || 'true').toLowerCase() === 'true',
  min_confidence: Number.parseFloat(process.env.PRIVACY_MIN_CONFIDENCE || '0.7'),
  detect_pii: (process.env.PRIVACY_DETECT_PII || 'true').toLowerCase() === 'true',
  detect_secrets: (process.env.PRIVACY_DETECT_SECRETS || 'false').toLowerCase() === 'true',
  detect_custom_patterns: (process.env.PRIVACY_DETECT_CUSTOM_PATTERNS || 'true').toLowerCase() === 'true',
  redaction_strategy: process.env.PRIVACY_REDACTION_STRATEGY || 'mask',
  mask_char: (process.env.PRIVACY_MASK_CHAR || '*').charAt(0) || '*',
  mask_length: Number.parseInt(process.env.PRIVACY_MASK_LENGTH || '8', 10),
  fail_open: (process.env.PRIVACY_FAIL_OPEN || 'false').toLowerCase() === 'true',
};

res.json({
  success: true,
  config: ocrConfig,
  privacy: privacyConfig   // <-- NEW
});
```

**API Response Change:**

```json
{
  "success": true,
  "config": { /* OCR engine config (unchanged) */ },
  "privacy": {
    "enabled": true,
    "min_confidence": 0.7,
    "detect_pii": true,
    "detect_secrets": false,
    "detect_custom_patterns": true,
    "redaction_strategy": "mask",
    "mask_char": "*",
    "mask_length": 8,
    "fail_open": false
  }
}
```

---

### 3. Desktop App Applies Server Privacy Config

**File:** `python-desktop-app/desktop_app.py`  
**Function added:** `set_runtime_privacy_config()` (lines 448–493)  
**Call site:** Inside `get_ocr_config()` (line 1957)

**Problem:** `PrivacyConfig.from_env()` reads `os.environ`, but no PRIVACY_* env vars were ever set because the desktop app doesn't use a local `.env` file.

**Solution:** Following the same pattern as `set_runtime_ocr_config()` (which converts server OCR config into `os.environ` keys), a new `set_runtime_privacy_config()` function was added:

```python
def set_runtime_privacy_config(config_dict):
    """
    Set privacy filter config fetched from AI server.
    Converts the privacy config dict into PRIVACY_* environment variables
    so PrivacyConfig.from_env() picks them up when the OCR facade reinitialises.
    """
    env_mapping = {
        'enabled': 'PRIVACY_FILTER_ENABLED',
        'min_confidence': 'PRIVACY_MIN_CONFIDENCE',
        'detect_pii': 'PRIVACY_DETECT_PII',
        'detect_secrets': 'PRIVACY_DETECT_SECRETS',
        'detect_custom_patterns': 'PRIVACY_DETECT_CUSTOM_PATTERNS',
        'redaction_strategy': 'PRIVACY_REDACTION_STRATEGY',
        'mask_char': 'PRIVACY_MASK_CHAR',
        'mask_length': 'PRIVACY_MASK_LENGTH',
        'fail_open': 'PRIVACY_FAIL_OPEN',
    }

    for key, env_var in env_mapping.items():
        if key in config_dict:
            value = config_dict[key]
            if isinstance(value, bool):
                value = str(value).lower()
            os.environ[env_var] = str(value)
```

And in `get_ocr_config()`:

```python
# Store the OCR config in runtime config
ocr_config = result.get('config', {})
set_runtime_ocr_config(ocr_config)

# Apply privacy filter config from server (delivered alongside OCR config)
privacy_config = result.get('privacy', {})
if privacy_config:
    set_runtime_privacy_config(privacy_config)
```

**Config Flow:**

```
AI Server .env                 AI Server                 Desktop App
┌────────────────┐    ┌─────────────────────┐    ┌──────────────────────┐
│ PRIVACY_DETECT │───▶│ getOcrConfig()       │───▶│ set_runtime_privacy  │
│ _PII=true      │    │ reads process.env    │    │ _config()            │
│                │    │ builds privacyConfig │    │ sets os.environ      │
│ PRIVACY_FILTER │    │ sends in JSON        │    │ PRIVACY_* vars       │
│ _ENABLED=true  │    └─────────────────────┘    └──────────┬───────────┘
└────────────────┘                                          │
                                                            ▼
                                                 ┌──────────────────────┐
                                                 │ PrivacyConfig        │
                                                 │   .from_env()        │
                                                 │ reads os.environ     │
                                                 │ → PrivacyFilter init │
                                                 └──────────────────────┘
```

---

### 4. Server-Side OCR Text Sanitization (Defense-in-Depth)

**File:** `ai-server/src/services/activity-service.js`  
**Lines added:** 18–56 (sanitization patterns + function)  
**Lines modified:** 114, 170 (applied in prompt builders)

**Problem:** Even though the desktop app sanitizes OCR text, the AI server had zero filtering before sending OCR text to the LLM. If the desktop filter failed, missed something, or a future code path bypassed it, credentials and PII could leak to the LLM provider.

**Solution:** Added a `sanitizeOcrText()` function with regex patterns applied to OCR text before it enters any LLM prompt:

```javascript
const SANITIZATION_PATTERNS = [
  // Passwords in URLs/configs: password=xxx, pwd=xxx, passwd=xxx, secret=xxx
  { pattern: /(?:password|passwd|pwd|secret|token)\s*[=:]\s*\S+/gi,
    replacement: '[REDACTED_CREDENTIAL]' },
  // AWS access keys (AKIA...)
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED_AWS_KEY]' },
  // GitHub tokens (ghp_, gho_, ghs_, ghr_)
  { pattern: /\bgh[posru]_[A-Za-z0-9_]{36,255}\b/g,
    replacement: '[REDACTED_GITHUB_TOKEN]' },
  // Generic API keys
  { pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*\S+/gi,
    replacement: '[REDACTED_API_KEY]' },
  // Bearer tokens
  { pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/gi,
    replacement: 'Bearer [REDACTED_TOKEN]' },
  // Credit card numbers (13-19 digits)
  { pattern: /\b(?:\d[ -]*?){13,19}\b/g,
    replacement: '[REDACTED_CARD]' },
  // SSN (US format)
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: '[REDACTED_SSN]' },
  // Private keys (PEM blocks)
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]' },
  // Connection strings with embedded passwords
  { pattern: /(?:mongodb|postgres|mysql|redis|amqp):\/\/[^\s]+:[^\s@]+@[^\s]+/gi,
    replacement: '[REDACTED_CONNECTION_STRING]' },
];
```

Applied in both prompt builders:

```javascript
// In buildBatchAnalysisPrompt():
const ocrSnippet = record.ocr_text
  ? sanitizeOcrText(record.ocr_text.substring(0, 500))   // sanitized
  : '(no text extracted)';

// In buildClassificationPrompt():
const textSnippet = ocrText
  ? sanitizeOcrText(ocrText.substring(0, 800))            // sanitized
  : '(no text available)';
```

---

### 5. AI Server `.env.example` Updated

**File:** `ai-server/.env.example`  
**Lines added:** After the LOG_SANITIZE section

Added a full documented section so operators know how to configure privacy settings:

```env
# =============================================================================
# PRIVACY FILTER (OCR Data Sanitization - Delivered to Desktop App)
# =============================================================================
PRIVACY_FILTER_ENABLED=true
PRIVACY_DETECT_PII=true
PRIVACY_DETECT_CUSTOM_PATTERNS=true
PRIVACY_MIN_CONFIDENCE=0.7
PRIVACY_REDACTION_STRATEGY=mask
PRIVACY_FAIL_OPEN=false
```

---

## Configuration Reference

### Environment Variables (set on AI Server)

| Variable | Default | Description |
|----------|---------|-------------|
| `PRIVACY_FILTER_ENABLED` | `true` | Master toggle for all privacy filtering |
| `PRIVACY_DETECT_PII` | `true` | Enable Presidio PII detection (credit cards, SSN, phone numbers, bank accounts, etc.) |
| `PRIVACY_DETECT_CUSTOM_PATTERNS` | `true` | Enable regex pattern detection (passwords, API keys, tokens, private keys) |
| `PRIVACY_DETECT_SECRETS` | `false` | Enable detect-secrets library (high-entropy strings) — disabled by default due to false positives |
| `PRIVACY_MIN_CONFIDENCE` | `0.7` | Minimum confidence threshold (0.0–1.0) to trigger redaction |
| `PRIVACY_REDACTION_STRATEGY` | `mask` | How to redact: `mask` (********), `entity_type` ([PASSWORD]), `hash` (a1b2c3d4), `remove` (delete) |
| `PRIVACY_MASK_CHAR` | `*` | Character used for masking |
| `PRIVACY_MASK_LENGTH` | `8` | Fixed length for masked output (0 = variable based on original) |
| `PRIVACY_FAIL_OPEN` | `false` | If `false` (recommended), errors cause text to be blocked. If `true`, original text passes through on error |

### Detected Entity Types

**Custom Pattern Detector (always active, no dependencies):**
- `PASSWORD` — passwords in URLs, config files, environment variables
- `API_KEY` — AWS access keys, Stripe keys, generic `api_key=` patterns
- `PRIVATE_KEY` — PEM-encoded private keys and certificates
- `CONNECTION_STRING` — database URLs with embedded credentials
- `BEARER_TOKEN` — OAuth bearer tokens
- `OAUTH_SECRET` — OAuth client secrets
- `INTERNAL_IP` — private network IP addresses
- `DATABASE_PASSWORD` — database connection passwords
- `ENCRYPTION_KEY` — encryption/signing keys

**Presidio Detector (enabled by default, requires `presidio-analyzer`):**
- `CREDIT_CARD` — credit card numbers with Luhn validation
- `PHONE_NUMBER` — phone numbers in international formats
- `IP_ADDRESS` — IPv4 and IPv6 addresses
- `US_BANK_NUMBER` — US bank account numbers
- `US_DRIVER_LICENSE` — US driver's license numbers
- `US_PASSPORT` — US passport numbers
- `IBAN_CODE` — International Bank Account Numbers
- `CRYPTO` — cryptocurrency wallet addresses
- `NRP` — National Registration Numbers
- `MEDICAL_LICENSE` — Medical license numbers

---

## Verification Steps

### Verify Privacy Filter Is Active

Check desktop app logs after OCR initialization for:
```
[INFO] Privacy filter initialized with detectors: ['custom_patterns', 'presidio']
```

If Presidio is not available (missing dependency), you'll see:
```
[INFO] Presidio not available - install with: pip install presidio-analyzer
[INFO] Privacy filter initialized with detectors: ['custom_patterns']
```

### Verify Privacy Config Is Delivered From Server

Check desktop app startup output for:
```
[OK] Privacy config loaded from AI server (PII detection: enabled)
```

### Verify Redactions Are Happening

When sensitive data is detected in OCR text, the desktop app logs:
```
[PRIVACY] Detected 3 sensitive item(s) in OCR text from rapidocr
[PRIVACY]   - PASSWORD: 1 occurrence(s) REDACTED
[PRIVACY]   - CREDIT_CARD: 2 occurrence(s) REDACTED
[PRIVACY] Redaction complete: 3 items masked (detectors: ['custom_patterns', 'presidio'], time: 15.2ms)
```

### Verify Server-Side Sanitization

Server-side sanitization is transparent — no logging by default. To verify, check that LLM prompts contain `[REDACTED_*]` placeholders instead of actual credentials if any slipped through Layer 1.

---

## Files Modified

| File | Change |
|------|--------|
| `python-desktop-app/privacy/config.py` | `PRIVACY_DETECT_PII` default changed from `false` to `true` in `from_env()` |
| `ai-server/src/controllers/auth-controller.js` | Added `privacy` config block to `getOcrConfig()` response |
| `python-desktop-app/desktop_app.py` | Added `set_runtime_privacy_config()` function; called after fetching OCR config |
| `ai-server/src/services/activity-service.js` | Added `sanitizeOcrText()` with regex patterns; applied in both LLM prompt builders; exported for testing |
| `ai-server/.env.example` | Added `PRIVACY_*` environment variable documentation |
| `python-desktop-app/ocr/facade.py` | Updated docstring to reflect `PRIVACY_DETECT_PII=true` default |

---

## Automated Test Suite

### Test Files Created

| Test File | Framework | Tests | What It Covers |
|-----------|-----------|-------|----------------|
| `python-desktop-app/privacy/tests/test_sanitization_changes.py` | unittest | 19 | Config defaults, runtime config, end-to-end flow |
| `ai-server/tests/services/activity-sanitization.test.js` | Jest | 44 | Server-side sanitization patterns, prompt builder integration |
| `ai-server/tests/controllers/auth-controller.test.js` | Jest | 6 new | Privacy config delivery in OCR config endpoint |

### Test Files Updated

| Test File | Change |
|-----------|--------|
| `python-desktop-app/privacy/tests/test_filter.py` | Updated `detect_pii` default assertion from `False` to `True` |
| `ai-server/tests/controllers/auth-controller.test.js` | Fixed existing assertions to use `expect.objectContaining` for top-level response (accepts new `privacy` key) |

### Running the Tests

**Python tests (desktop app):**
```bash
cd python-desktop-app

# New sanitization change tests (19 tests)
python -m unittest privacy.tests.test_sanitization_changes -v

# Existing privacy filter tests (21 tests)
python -m unittest privacy.tests.test_filter -v
```

**JavaScript tests (AI server):**
```bash
cd ai-server

# Server-side OCR sanitization tests (44 tests)
npx jest tests/services/activity-sanitization.test.js --verbose

# Auth controller privacy config delivery tests (14 getOcrConfig tests)
npx jest tests/controllers/auth-controller.test.js --testNamePattern="getOcrConfig" --verbose
```

### Test Coverage by Area

#### 1. Privacy Config Defaults (`test_sanitization_changes.py` — `TestPrivacyDetectPIIDefault`)

| Test | Description |
|------|-------------|
| `test_detect_pii_defaults_true_when_env_not_set` | Verifies `PRIVACY_DETECT_PII` defaults to `True` (the core bug fix) |
| `test_detect_pii_can_be_disabled_explicitly` | Verifies operators can still set `PRIVACY_DETECT_PII=false` |
| `test_detect_pii_enabled_explicitly` | Verifies `PRIVACY_DETECT_PII=true` works |
| `test_detect_pii_case_insensitive` | Verifies `True`, `TRUE`, `False` all parse correctly |
| `test_dataclass_default_matches_from_env_default` | Verifies dataclass and `from_env()` defaults are aligned |
| `test_all_defaults_from_env` | Full audit of every `from_env()` default value |

#### 2. Runtime Config from Server (`test_sanitization_changes.py` — `TestSetRuntimePrivacyConfig`)

| Test | Description |
|------|-------------|
| `test_full_server_config_applied` | All 9 fields from server dict → `os.environ` |
| `test_booleans_converted_to_lowercase_strings` | `True/False` → `'true'/'false'` for env var parsing |
| `test_numeric_values_converted_to_strings` | `0.9` → `'0.9'` for `os.environ` |
| `test_partial_config_only_sets_present_keys` | Partial server response doesn't corrupt existing env |
| `test_empty_config_is_noop` | Empty dict sets nothing |

#### 3. End-to-End Flow (`test_sanitization_changes.py` — `TestEndToEndServerToPrivacyFilter`)

| Test | Description |
|------|-------------|
| `test_server_config_enables_pii_detection` | Server dict → env vars → `PrivacyConfig.from_env()` → config.detect_pii is `True` |
| `test_server_config_disables_filter` | Server sends `enabled=false` → `PrivacyFilter.redact()` passes text through |
| `test_server_config_entity_type_strategy` | Server sends `entity_type` strategy → redactions use `[PASSWORD]` format |
| `test_server_config_high_confidence_threshold` | Server sends `min_confidence=0.99` → low-confidence matches filtered out |
| `test_filter_redacts_common_sensitive_data` | Full integration: server config → filter → OCR text with passwords/keys → redacted |
| `test_fail_open_false_blocks_on_error` | Verifies fail_open=false config propagation |

#### 4. Server-Side Sanitization (`activity-sanitization.test.js`)

| Category | Tests | Patterns Verified |
|----------|-------|-------------------|
| Edge cases | 5 | null, undefined, empty, whitespace, normal text passthrough |
| Credentials | 6 | `password=`, `pwd=`, `secret=`, `token=`, `password:`, case-insensitivity |
| AWS keys | 2 | `AKIA...` matching, wrong-length rejection |
| GitHub tokens | 4 | `ghp_`, `ghs_`, `gho_` tokens, standalone vs. prefixed |
| API keys | 3 | `api_key=`, `apikey=`, `api-key:` |
| Bearer tokens | 2 | Standard format, case-insensitivity |
| Credit cards | 3 | Plain digits, dashes, spaces |
| SSN | 2 | `XXX-XX-XXXX` format, non-SSN rejection |
| Private keys | 2 | RSA and generic PEM blocks |
| Connection strings | 4 | MongoDB, PostgreSQL, MySQL, Redis |
| Multiple patterns | 1 | All sensitive items redacted, non-sensitive preserved |
| False positives | 3 | Work text, Jira keys, file paths unchanged |
| Repeated calls | 1 | Regex `lastIndex` reset between calls |

#### 5. Prompt Builder Integration (`activity-sanitization.test.js`)

| Test | Description |
|------|-------------|
| `buildBatchAnalysisPrompt - sanitize OCR text` | Password in OCR record → `[REDACTED_CREDENTIAL]` in prompt |
| `buildBatchAnalysisPrompt - no OCR text` | null OCR → `(no text extracted)` |
| `buildBatchAnalysisPrompt - multiple records` | API key + SSN in separate records → both redacted |
| `buildClassificationPrompt - sanitize OCR text` | Password in classification → `[REDACTED_CREDENTIAL]` |
| `buildClassificationPrompt - null OCR` | null → `(no text available)` |
| `buildClassificationPrompt - empty OCR` | empty string → `(no text available)` |

#### 6. Auth Controller Privacy Config (`auth-controller.test.js`)

| Test | Description |
|------|-------------|
| `should include privacy config with defaults` | Response has full `privacy` object with correct defaults |
| `should read privacy config from environment variables` | Custom env vars → response reflects them |
| `should default PRIVACY_DETECT_PII to true` | No env var → `detect_pii: true` |
| `should parse PRIVACY_MASK_LENGTH as integer` | String env var → integer in JSON |
| `should parse PRIVACY_MIN_CONFIDENCE as float` | String env var → float in JSON |
| `should return OCR config for authenticated user` | Full response includes both `config` and `privacy` |
