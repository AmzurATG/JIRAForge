# PII Detection Gap Analysis & Resolution Plan

**Date**: April 13, 2026  
**Severity**: Critical  
**Status**: Open  
**Component**: Privacy Filter (python-desktop-app/privacy/)

---

## 1. Executive Summary

The JIRAForge desktop time-tracker captures screenshots of user screens and extracts text via OCR. Before this text is uploaded to Supabase or sent to the AI server for analysis, it passes through a **Privacy Filter** that detects and redacts PII (credit cards, SSNs, passwords, API keys, etc.).

**The Problem**: The privacy filter operates exclusively on **plain text strings** extracted by OCR. When a user is working in applications that store data in non-plaintext formats (Excel, Word, PDF, databases, etc.), the OCR engine captures a **visual screenshot** of the screen and extracts visible text. However, this introduces **two categories of PII gaps**:

1. **OCR Accuracy Gap**: OCR may misread structured data (e.g., credit card numbers in Excel cells), producing malformed text that regex/Presidio cannot match.
2. **Contextual Loss Gap**: OCR captures raw visible text without structural context (column headers like "SSN" next to values), making it harder to identify PII that depends on context.

---

## 2. Current Architecture

### 2.1 Data Flow

```
User Screen (Excel, Notepad, Browser, etc.)
    │
    ▼
Screenshot Capture (desktop_app.py → process_window_event)
    │
    ▼
OCR Engine (ocr/facade.py → extract_text)
    │  ┌─ EasyOCR
    │  ├─ Windows OCR
    │  └─ Tesseract
    │
    ▼
Plain Text String
    │
    ▼
Privacy Filter (privacy/filter.py → redact)
    │  ┌─ CustomPatternDetector (regex, always available)
    │  └─ PresidioDetector (NLP + patterns, optional)
    │
    ▼
Redacted Text
    │
    ├──► SQLite (local storage)
    ├──► Supabase (cloud upload)
    └──► AI Server (classification/analysis)
```

### 2.2 Current Detectors

| Detector | File | Dependency | Default | What It Detects |
|----------|------|-----------|---------|----------------|
| **CustomPatternDetector** | `privacy/detectors/custom_patterns.py` | None (built-in) | **ON** | Passwords in URLs, API keys (AWS, GitHub, Stripe, Google, Slack, etc.), JWT/Bearer tokens, PEM private keys, connection strings, OAuth secrets, database passwords, encryption keys, internal IPs, email addresses, credit cards (regex), SSNs (regex) |
| **PresidioDetector** | `privacy/detectors/presidio_detector.py` | `presidio-analyzer` + `spacy` | **ON** (if installed) | Credit cards (Luhn-validated), phone numbers (format-aware), SSNs, email addresses, bank account numbers, driver's licenses, passports, IBAN codes, crypto wallets, NER-based name/location detection |
| **Log Sanitizer** | `desktop_app.py` (embedded) | None | **ON** | Emails, credit cards, phone numbers, JWT tokens, Atlassian account IDs, UUIDs, IPs, API keys, AWS keys, GitHub tokens |

### 2.3 Current Redaction Strategies

Configured via `PRIVACY_REDACTION_STRATEGY` env var (default: `mask`):

| Strategy | Output Example | Config Value |
|----------|---------------|-------------|
| Mask with asterisks | `********` | `mask` |
| Entity type label | `[CREDIT_CARD]` | `entity_type` |
| Truncated hash | `[CREDIT_CARD:a1b2c3d4]` | `hash` |
| Remove entirely | *(empty)* | `remove` |

---

## 3. Identified PII Gaps

### 3.1 Gap Category 1: OCR Misreads Structured Data

**Scenario**: User has an Excel spreadsheet open with credit card numbers in column B.

| What's on screen | OCR extracts | Presidio detects? | Custom regex detects? |
|-----------------|-------------|-------------------|----------------------|
| `4111111111111111` | `4111111111111111` | ✅ Yes (Luhn check) | ✅ Yes |
| `4111-1111-1111-1111` | `4111-1111-1111-1111` | ✅ Yes | ✅ Yes |
| `4111 1111 1111 1111` (Excel cell formatting) | `4111 1111 1111 1111` or `41111111 11111111` | ⚠️ Maybe (spacing) | ⚠️ Maybe |
| Password in cell with no label | `MySecret123` | ❌ No (no context) | ❌ No (no `password=` prefix) |
| SSN `123-45-6789` in a cell | `123-45-6789` | ✅ Yes | ✅ Yes |
| SSN `123456789` (no dashes) | `123456789` | ❌ No (just a number) | ❌ No |

**Root Cause**: OCR produces a linear text stream — column headers, cell boundaries, and formatting are lost. A value like `MySecret123` in column "Password" has no detectable pattern without the header context.

### 3.2 Gap Category 2: File-Specific Content Not Captured

These scenarios involve content that OCR **cannot see** because it's not rendered on screen:

| Scenario | Visible to OCR? | PII Risk |
|---------|-----------------|----------|
| Hidden Excel columns/rows with PII | ❌ Not visible | HIGH — data exists but is not scanned |
| Excel Sheet 2 (user is on Sheet 1) | ❌ Not visible | HIGH — other sheets are not captured |
| Collapsed sections in Word/PDF | ❌ Not visible | MEDIUM |
| PDF form fields (not visually filled) | ❌ Not visible | MEDIUM |
| Email attachments (closed) | ❌ Not visible | LOW — but could be opened |
| Password manager (vault locked) | ❌ Not visible | LOW |
| Notepad file not in focus | ❌ Not visible | LOW |

### 3.3 Gap Category 3: Context-Dependent PII

PII that requires **context** to identify:

| Data | With Context | Without Context | Detected? |
|------|------------|-----------------|-----------|
| `John Smith` | Name in "Employee" column | Common words | ❌ (OCR loses column context) |
| `123 Main St` | Address field | Random text | ❌ (unless Presidio NER is active) |
| `DOB: 03/15/1990` | Date of birth | Date string | ⚠️ (only with `DOB:` prefix visible) |
| `$85,000` | Salary in payroll sheet | Currency amount | ❌ (not PII by pattern) |
| `A+` | Blood type in medical form | Grade/rating | ❌ (too ambiguous) |

### 3.4 Gap Category 4: Non-English PII

The current system is English-only (`language='en'` in Presidio):

| Data | Language | Detected? |
|------|---------|-----------|
| German IBAN: `DE89370400440532013000` | DE | ✅ (pattern-based) |
| Japanese phone: `090-1234-5678` | JP | ❌ |
| Indian Aadhaar: `1234 5678 9012` | IN | ❌ |
| Spanish name: `José García` | ES | ❌ (NER trained on English) |
| French SSN: `1 85 07 75 012 045 18` | FR | ❌ |

---

## 4. Risk Assessment

### 4.1 Impact Matrix

| Gap | Likelihood | Impact | Risk Level | Affected Applications |
|-----|-----------|--------|------------|----------------------|
| Passwords without context labels | **High** | **Critical** | 🔴 CRITICAL | Notepad, Excel, config editors |
| OCR misreads breaking patterns | **Medium** | **High** | 🟠 HIGH | Excel (formatted cells), PDFs |
| Hidden Excel data not scanned | **Medium** | **High** | 🟠 HIGH | Excel (hidden sheets/columns) |
| Names/addresses without context | **Medium** | **Medium** | 🟡 MEDIUM | Any document |
| Non-English PII | **Low** | **Medium** | 🟡 MEDIUM | Multi-language environments |
| Locked/collapsed content | **Low** | **Low** | 🟢 LOW | Password managers, collapsed docs |

### 4.2 What Is Currently Protected

| Data Type | Custom Patterns | Presidio | Confidence |
|-----------|:---------------:|:--------:|:----------:|
| Credit card numbers | ✅ | ✅ (Luhn) | **High** |
| SSNs (XXX-XX-XXXX) | ✅ | ✅ | **High** |
| Email addresses | ✅ | ✅ | **High** |
| API keys (AWS, GitHub, Stripe, etc.) | ✅ | — | **High** |
| Passwords in `key=value` format | ✅ | — | **High** |
| JWT/Bearer tokens | ✅ | — | **High** |
| PEM private keys | ✅ | — | **Very High** |
| Connection strings | ✅ | — | **High** |
| Phone numbers | — | ✅ | **Medium** |
| Bank account numbers | — | ✅ | **Medium** |
| Passport/license numbers | — | ✅ | **Medium** |
| IBAN codes | — | ✅ | **High** |
| IP addresses (internal) | ✅ | ✅ | **High** |
| **Unlabeled passwords** | ❌ | ❌ | **None** |
| **Names/addresses (NER)** | ❌ | ⚠️ (if installed) | **Low-Medium** |
| **Non-English PII** | ❌ | ❌ | **None** |

---

## 5. Recommended Fixes

### Fix 1: Context-Aware OCR Pre-Processing (HIGH PRIORITY)

**Problem**: OCR extracts text without structure. Column headers are disconnected from values.

**Solution**: Add a **spatial-aware post-processor** that uses OCR bounding boxes (already captured — see `boxes` in `facade.py` return) to reconstruct tabular structure before privacy filtering.

**File to modify**: `python-desktop-app/ocr/facade.py`

```python
# NEW: Add after OCR extraction, before privacy filter
class TabularContextEnricher:
    """
    Reconstruct tabular structure from OCR bounding boxes.
    If a value appears below a header like 'Password', 'SSN', 'Credit Card',
    prefix the value with the header context for better detection.
    """
    
    SENSITIVE_HEADERS = [
        'password', 'pwd', 'pass', 'secret', 'ssn', 'social security',
        'credit card', 'card number', 'account', 'routing', 'cvv', 'cvc',
        'pin', 'dob', 'date of birth', 'salary', 'bank', 'iban',
        'passport', 'license', 'dl number', 'tax id', 'ein', 'itin',
        'phone', 'mobile', 'email', 'address', 'zip code',
    ]
    
    def enrich(self, text: str, boxes: list) -> str:
        """
        Analyze OCR bounding boxes to detect tabular layout.
        If a header column contains a sensitive keyword,
        prefix corresponding data cells with context.
        
        Args:
            text: Raw OCR text
            boxes: OCR bounding boxes with coordinates and text
            
        Returns:
            Context-enriched text for better PII detection
        """
        if not boxes:
            return text
        
        # Group boxes by rows (similar Y coordinate)
        rows = self._group_by_rows(boxes)
        
        # Identify header row (first row or row with sensitive keywords)
        header_row = self._find_header_row(rows)
        if not header_row:
            return text
        
        # Map column positions to headers
        column_headers = self._map_columns(header_row)
        
        # For each data cell under a sensitive header, prefix with context
        enriched_lines = []
        for row in rows:
            if row == header_row:
                continue
            for cell in row:
                col_header = self._find_column_header(cell, column_headers)
                if col_header and any(h in col_header.lower() for h in self.SENSITIVE_HEADERS):
                    enriched_lines.append(f"{col_header}={cell['text']}")
                else:
                    enriched_lines.append(cell['text'])
        
        return '\n'.join(enriched_lines) if enriched_lines else text
    
    def _group_by_rows(self, boxes, y_tolerance=15):
        """Group bounding boxes into rows by Y coordinate proximity."""
        if not boxes:
            return []
        sorted_boxes = sorted(boxes, key=lambda b: (b.get('y', 0), b.get('x', 0)))
        rows = []
        current_row = [sorted_boxes[0]]
        for box in sorted_boxes[1:]:
            if abs(box.get('y', 0) - current_row[0].get('y', 0)) <= y_tolerance:
                current_row.append(box)
            else:
                rows.append(sorted(current_row, key=lambda b: b.get('x', 0)))
                current_row = [box]
        if current_row:
            rows.append(sorted(current_row, key=lambda b: b.get('x', 0)))
        return rows
    
    def _find_header_row(self, rows):
        """Find the row most likely to be a header."""
        for row in rows[:3]:  # Check first 3 rows
            row_text = ' '.join(cell.get('text', '').lower() for cell in row)
            if any(h in row_text for h in self.SENSITIVE_HEADERS):
                return row
        return None
    
    def _map_columns(self, header_row):
        """Create column position → header text mapping."""
        return [{'x': cell.get('x', 0), 'width': cell.get('w', 100), 'text': cell.get('text', '')} 
                for cell in header_row]
    
    def _find_column_header(self, cell, column_headers, x_tolerance=30):
        """Find which column header a data cell belongs to."""
        cell_x = cell.get('x', 0)
        for header in column_headers:
            if abs(cell_x - header['x']) <= x_tolerance:
                return header['text']
        return None
```

**Expected Impact**: Catches unlabeled passwords, SSNs, credit cards in Excel/table layouts by associating column headers with cell values.

---

### Fix 2: Application-Specific PII Rules (HIGH PRIORITY)

**Problem**: When a user opens Excel, the privacy filter doesn't know the content is tabular data.

**Solution**: Add application-aware detection rules in the privacy filter based on the `app_name` already captured by the tracker.

**File to modify**: `python-desktop-app/privacy/filter.py`

```python
# Application-specific elevated detection rules
APP_ELEVATED_DETECTION = {
    # Spreadsheet apps: more aggressive PII scanning
    'excel.exe': {
        'lower_confidence': 0.5,    # Lower threshold (default 0.7)
        'extra_patterns': [
            # Standalone numeric patterns that could be SSNs without dashes
            (r'\b\d{9}\b', 'POSSIBLE_SSN', 0.5),
            # Standalone 15-16 digit numbers (possible credit cards)
            (r'\b\d{15,16}\b', 'POSSIBLE_CREDIT_CARD', 0.6),
        ],
    },
    'notepad.exe': {
        'extra_patterns': [
            # Lines that look like key:value pairs
            (r'^(.+?)[\s]*[=:]+[\s]*(.+)$', 'POSSIBLE_CREDENTIAL', 0.5),
        ],
    },
    'code.exe': {  # VS Code
        'lower_confidence': 0.6,
    },
}
```

---

### Fix 3: Ensure Presidio Is Always Available (MEDIUM PRIORITY)

**Problem**: Presidio is optional (`PRESIDIO_AVAILABLE` flag). If not installed, the system loses NLP-based entity recognition (names, addresses, phone number format awareness, Luhn credit card validation).

**Solution**: Bundle Presidio as a **required** dependency in the desktop app build.

**Files to modify**:

1. `python-desktop-app/requirements.txt`:
```
presidio-analyzer>=2.2.0
presidio-anonymizer>=2.2.0
spacy>=3.5.0
```

2. `python-desktop-app/build.bat` — Add post-install step:
```batch
python -m spacy download en_core_web_sm
```

3. `python-desktop-app/privacy/detectors/__init__.py` — Change from silent fallback to hard warning:
```python
if not PRESIDIO_AVAILABLE:
    import warnings
    warnings.warn(
        "CRITICAL: Presidio is NOT installed. PII detection is degraded. "
        "Credit card Luhn validation, phone number format detection, and "
        "NER-based name/address detection are DISABLED. "
        "Install with: pip install presidio-analyzer && python -m spacy download en_core_web_sm",
        RuntimeWarning,
        stacklevel=2
    )
```

---

### Fix 4: High-Entropy String Detection (MEDIUM PRIORITY)

**Problem**: Standalone passwords like `MySecret@123` in a Notepad file or Excel cell are not detected because they don't match `password=...` patterns.

**Solution**: Add a **high-entropy detector** that flags strings with mixed character classes (uppercase + lowercase + digits + special) that exceed a length threshold.

**File to create**: `python-desktop-app/privacy/detectors/entropy_detector.py`

```python
import math
import re
from typing import List
from .base import BaseDetector, Detection


class EntropyDetector(BaseDetector):
    """
    Detect potential secrets by analyzing string entropy.
    
    Flags strings that have high character diversity (mixed case + digits + 
    special chars) which are common in passwords and secrets but rare in
    natural language.
    """
    
    MIN_LENGTH = 8
    MIN_ENTROPY = 3.5  # bits per character
    MIN_CHAR_CLASSES = 3  # out of 4: upper, lower, digit, special
    
    def detect(self, text: str) -> List[Detection]:
        detections = []
        # Split text into word-like tokens
        tokens = re.findall(r'\S+', text)
        
        for token in tokens:
            if len(token) < self.MIN_LENGTH:
                continue
            
            # Skip known non-secret patterns (URLs, paths, etc.)
            if token.startswith(('http://', 'https://', 'C:\\', '/', './')):
                continue
                
            char_classes = self._count_char_classes(token)
            entropy = self._shannon_entropy(token)
            
            if char_classes >= self.MIN_CHAR_CLASSES and entropy >= self.MIN_ENTROPY:
                start = text.find(token)
                if start >= 0:
                    detections.append(Detection(
                        entity_type='HIGH_ENTROPY_SECRET',
                        start=start,
                        end=start + len(token),
                        confidence=min(0.5 + (entropy - self.MIN_ENTROPY) * 0.1, 0.85),
                        text=token,
                        detector=self.get_name(),
                    ))
        
        return detections
    
    def _shannon_entropy(self, text: str) -> float:
        if not text:
            return 0.0
        freq = {}
        for c in text:
            freq[c] = freq.get(c, 0) + 1
        length = len(text)
        return -sum((count / length) * math.log2(count / length) for count in freq.values())
    
    def _count_char_classes(self, text: str) -> int:
        classes = 0
        if re.search(r'[a-z]', text): classes += 1
        if re.search(r'[A-Z]', text): classes += 1
        if re.search(r'[0-9]', text): classes += 1
        if re.search(r'[^a-zA-Z0-9]', text): classes += 1
        return classes
    
    def get_name(self) -> str:
        return "entropy"
    
    def is_available(self) -> bool:
        return True
```

**Expected Impact**: Catches standalone passwords like `MyP@ssw0rd!`, `Admin$ecret123`, `xK9#mW2!pL7` even without `password=` context.

**Trade-off**: Increased false positives on complex filenames, URLs, and encoded strings. Confidence scoring (0.5–0.85) keeps these at the lower end, so they only redact when the `min_confidence` threshold is relaxed (e.g., for Excel apps per Fix 2).

---

### Fix 5: Window Title PII Check (LOW PRIORITY)

**Problem**: Window titles often contain sensitive data. Example: `Payroll_Q4_2026.xlsx - Excel` or `password_list.txt - Notepad`.

**Current state**: Private apps get title redacted (`[PRIVATE]`), but productive/unknown apps pass window titles through unfiltered.

**Solution**: Apply the privacy filter to window titles before storing them.

**File to modify**: `python-desktop-app/desktop_app.py` (in `process_window_event`)

```python
# After line: display_title = window_title
# Add:
if self._privacy_filter and window_title:
    title_result = self._privacy_filter.redact(window_title)
    if title_result.get('redactions_count', 0) > 0:
        display_title = title_result['text']
        print(f"[PRIVACY] Window title redacted: {title_result['redactions_count']} items")
```

---

### Fix 6: OCR Confidence-Based Flagging (LOW PRIORITY)

**Problem**: Low-confidence OCR output may contain garbled PII that neither detector catches.

**Solution**: When OCR confidence is below a threshold AND the text contains partial patterns (e.g., sequences of digits that almost look like credit cards), flag the entire text region as potentially containing PII.

**File to modify**: `python-desktop-app/ocr/facade.py`

```python
# After privacy filter application, add:
if result.get('confidence', 0) < 0.6:
    # Low confidence OCR — check for partial PII patterns
    partial_patterns = [
        (r'\d{12,16}', 'POSSIBLE_CREDIT_CARD'),  # Long digit sequences
        (r'\d{3}.*\d{2}.*\d{4}', 'POSSIBLE_SSN'),  # SSN-like fragments
    ]
    for pattern, entity_type in partial_patterns:
        if re.search(pattern, filtered_text):
            # Flag this capture as potentially containing unredacted PII
            logger.warning(
                f"LOW_CONFIDENCE_PII_RISK: OCR confidence {result['confidence']:.2f}, "
                f"potential {entity_type} detected in garbled text"
            )
```

---

## 6. Implementation Priority

| # | Fix | Priority | Effort | Impact | Files Changed |
|---|-----|----------|--------|--------|---------------|
| 1 | Context-Aware OCR (tabular) | 🔴 HIGH | 3-5 days | Catches unlabeled PII in Excel/tables | `ocr/facade.py` |
| 2 | App-Specific PII Rules | 🔴 HIGH | 1-2 days | Better detection for Excel, Notepad, VS Code | `privacy/filter.py` |
| 3 | Bundle Presidio as Required | 🟠 MEDIUM | 1 day | Ensures NLP detection always active | `requirements.txt`, `build.bat`, `detectors/__init__.py` |
| 4 | High-Entropy Detection | 🟠 MEDIUM | 2-3 days | Catches standalone passwords | New: `detectors/entropy_detector.py`, `filter.py` |
| 5 | Window Title PII Check | 🟢 LOW | 0.5 day | Redacts PII in window titles | `desktop_app.py` |
| 6 | OCR Confidence Flagging | 🟢 LOW | 0.5 day | Flags low-confidence PII risk | `ocr/facade.py` |

**Total estimated scope**: 8-12 days of development + testing.

---

## 7. Testing Plan

### 7.1 Test Scenarios

Each fix requires verification against these scenarios:

| Test ID | Scenario | Input | Expected Redaction |
|---------|---------|-------|-------------------|
| T1 | Excel with "Password" header + value | Screenshot of Excel with Column A="Password", Cell A2="MySecret123" | `password=MySecret123` → `password=********` |
| T2 | Excel with plain credit card | Screenshot of cell with `4111111111111111` | `********` |
| T3 | Excel with formatted credit card | Screenshot of cell with `4111 1111 1111 1111` | `********` |
| T4 | Notepad with `password=letmein` | Screenshot of Notepad | `password=********` |
| T5 | Notepad with standalone `MyP@ssw0rd!` | Screenshot of Notepad | `********` (entropy detector) |
| T6 | Window title `salary_data.xlsx - Excel` | Window switch event | Passes through (no PII in title) |
| T7 | Window title `john.doe@company.com - Email` | Window switch event | `******** - Email` |
| T8 | Low confidence OCR with digit sequences | Blurry screenshot with `41111...` | Warning logged |
| T9 | Non-English IBAN | Screenshot with `DE89370400440532013000` | `********` (already works) |
| T10 | Hidden Excel sheet | User on Sheet1, PII on Sheet2 | **Not detectable** (documented limitation) |

### 7.2 Regression Tests

Ensure existing detections are not broken:

```bash
cd python-desktop-app
python -m pytest privacy/tests/ -v
```

### 7.3 False Positive Monitoring

After deploying each fix, monitor `privacy_audit.log` for:
- Redaction count increase (expected: 10-30% more for Fixes 1, 2, 4)
- False positive rate (monitor for legitimate text being redacted)
- Processing time impact (entropy detection adds ~5-15ms per OCR result)

---

## 8. Known Limitations (Cannot Be Fixed)

These limitations are **inherent** to the OCR-based architecture and cannot be resolved without fundamentally changing how the app works:

| Limitation | Reason | Mitigation |
|-----------|--------|-----------|
| Hidden Excel sheets/columns | OCR only sees what's rendered on screen | Document as limitation; recommend users don't leave PII in non-visible areas |
| Password-protected files (unopened) | Content not visible | N/A — this is actually a security feature |
| PII in closed applications | Only active window is captured | By design — no background scanning |
| Binary file content | OCR works on visual pixels, not file bytes | Would require file system scanning (out of scope, privacy concern) |
| Obfuscated/encoded PII | Base64-encoded PII, encrypted values | Cannot decode without context |
| PII in non-English NER | Presidio's spaCy model is English-only | Future: add multi-language spaCy models |
| Image-embedded PII (logos, watermarks) | OCR may not extract text from images-within-screenshots | Nested OCR is impractical |

---

## 9. Summary

The current privacy filter provides **strong protection** for explicitly-patterned sensitive data (API keys, labeled passwords, credit cards, SSNs in standard formats). The primary gaps are:

1. **Unlabeled sensitive data** — Passwords or PII in cells/fields without recognizable prefixes
2. **OCR accuracy degradation** — Misread characters breaking detection patterns
3. **Context loss** — Tabular headers disconnected from values

The recommended fixes (especially Fix 1: Context-Aware OCR and Fix 4: Entropy Detection) address the most critical gaps while maintaining the existing architecture. The known limitations (hidden content, non-English NER) should be documented for stakeholders as accepted risks inherent to screenshot-based tracking.
