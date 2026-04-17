# Privacy Safeguards Integration Plan

## Executive Summary

This document outlines a comprehensive plan to integrate sensitive data detection and redaction into the JIRAForge OCR pipeline to protect user privacy when screenshots may contain passwords, API keys, credentials, and other PII.

---

## 1. Problem Statement

When the desktop app captures screenshots and extracts text via OCR:
- Screenshots may contain **passwords** visible in password managers, terminals, or config files
- **API keys** from IDE, terminal, or browser windows
- **Credit card numbers** from browser forms
- **Personal identifiers** (SSN, email addresses, phone numbers)
- **Private keys/certificates** from terminal sessions
- **Database credentials** from connection strings

This extracted text is stored in SQLite and uploaded to Supabase, creating privacy/compliance risks.

---

## 2. Recommended Free Libraries

### 2.1 Primary: Microsoft Presidio (Apache 2.0 License)
```bash
pip install presidio-analyzer presidio-anonymizer
```

**Capabilities:**
- 50+ built-in recognizers for PII detection
- Customizable confidence thresholds
- Pluggable architecture for custom patterns
- Supports: credit cards, SSN, emails, phone numbers, names, addresses, IBANs, IP addresses, etc.

**Why Presidio:**
- Maintained by Microsoft (active development)
- Production-ready with enterprise adoption
- Excellent for structured PII patterns
- Low false-positive rate with confidence scoring

### 2.2 Secondary: detect-secrets (Apache 2.0 License)
```bash
pip install detect-secrets
```

**Capabilities:**
- Detects high-entropy strings (potential secrets)
- AWS keys, GitHub tokens, private keys, JWT tokens
- Base64-encoded secrets, password patterns
- Keyword-based detection (password=, secret=, api_key=)

**Why detect-secrets:**
- Created by Yelp, widely used in CI/CD pipelines
- Excellent for developer/technical secrets
- Complements Presidio (different detection approaches)
- Low false negatives for secrets

### 2.3 Alternative Options

| Library | Best For | License | Notes |
|---------|----------|---------|-------|
| `scrubadub` | Simple PII | Apache 2.0 | Less comprehensive than Presidio |
| `pii-codex` | GDPR compliance | MIT | Good for EU regulations |
| `piiranha` | ML-based detection | MIT | Higher accuracy, more dependencies |
| `spacy` + patterns | Custom NER | MIT | Build your own with spaCy NER |

---

## 3. Architecture Design

### 3.1 Current Data Flow
```
Screenshot → OCR Engine → Raw Text → SQLite → Supabase
                              ↑
                         [NO FILTERING]
```

### 3.2 Proposed Data Flow with Privacy Safeguards
```
Screenshot → OCR Engine → Raw Text → Privacy Filter → Filtered Text → SQLite → Supabase
                                         ↓
                              [Sensitive Data Redacted]
                              [Audit Log (optional)]
```

### 3.3 Module Architecture
```
python-desktop-app/
├── ocr/
│   ├── __init__.py
│   ├── facade.py              # Integration point
│   ├── config.py              # Add privacy config
│   └── ...
├── privacy/                   # NEW MODULE
│   ├── __init__.py
│   ├── filter.py              # Main filter class
│   ├── config.py              # Privacy configuration
│   ├── detectors/
│   │   ├── __init__.py
│   │   ├── presidio_detector.py   # PII detection
│   │   ├── secrets_detector.py    # Secrets detection
│   │   └── custom_patterns.py     # Custom regex patterns
│   ├── redactors/
│   │   ├── __init__.py
│   │   ├── text_redactor.py       # Text redaction strategies
│   │   └── audit_logger.py        # Optional audit logging
│   └── tests/
│       └── test_privacy_filter.py
```

---

## 4. Detailed Component Design

### 4.1 Privacy Configuration (`privacy/config.py`)

```python
@dataclass
class PrivacyConfig:
    """Privacy filtering configuration"""
    
    # Master toggle
    enabled: bool = True
    
    # Detection settings
    min_confidence: float = 0.7          # Minimum confidence to redact
    detect_pii: bool = True              # Use Presidio for PII
    detect_secrets: bool = True          # Use detect-secrets
    detect_custom_patterns: bool = True  # Use custom regex
    
    # PII types to detect (Presidio recognizers)
    pii_types: List[str] = field(default_factory=lambda: [
        'CREDIT_CARD',
        'CRYPTO',
        'EMAIL_ADDRESS',
        'IBAN_CODE',
        'IP_ADDRESS',
        'PHONE_NUMBER',
        'US_SSN',
        'US_BANK_NUMBER',
        'US_DRIVER_LICENSE',
        'US_PASSPORT',
        'PASSWORD',         # Custom
        'API_KEY',          # Custom
        'PRIVATE_KEY',      # Custom
    ])
    
    # Redaction settings
    redaction_strategy: str = 'mask'  # 'mask', 'hash', 'remove', 'entity_type'
    mask_char: str = '*'
    mask_length: int = 8
    
    # Audit settings
    enable_audit_log: bool = False
    audit_log_path: str = 'privacy_audit.log'
    
    # Performance
    skip_short_text: int = 10         # Skip if text < N chars
    max_text_length: int = 50000      # Truncate before processing
    
    @classmethod
    def from_env(cls) -> 'PrivacyConfig':
        """Load from environment variables"""
        return cls(
            enabled=os.getenv('PRIVACY_FILTER_ENABLED', 'true').lower() == 'true',
            min_confidence=float(os.getenv('PRIVACY_MIN_CONFIDENCE', '0.7')),
            detect_pii=os.getenv('PRIVACY_DETECT_PII', 'true').lower() == 'true',
            detect_secrets=os.getenv('PRIVACY_DETECT_SECRETS', 'true').lower() == 'true',
            redaction_strategy=os.getenv('PRIVACY_REDACTION_STRATEGY', 'mask'),
        )
```

### 4.2 Main Privacy Filter (`privacy/filter.py`)

```python
class PrivacyFilter:
    """
    Unified privacy filter combining multiple detection strategies.
    
    Usage:
        filter = PrivacyFilter()
        result = filter.redact(ocr_text)
        
        # Result:
        {
            'text': 'password: [REDACTED_PASSWORD]',
            'original_length': 25,
            'redacted_length': 30,
            'redactions_count': 1,
            'redactions': [
                {'type': 'PASSWORD', 'confidence': 0.95, 'start': 10, 'end': 18}
            ]
        }
    """
    
    def __init__(self, config: Optional[PrivacyConfig] = None):
        self.config = config or PrivacyConfig.from_env()
        self._init_detectors()
    
    def _init_detectors(self):
        """Initialize detection engines"""
        self.detectors = []
        
        if self.config.detect_pii:
            self.detectors.append(PresidioDetector(self.config))
        
        if self.config.detect_secrets:
            self.detectors.append(SecretsDetector(self.config))
        
        if self.config.detect_custom_patterns:
            self.detectors.append(CustomPatternDetector(self.config))
    
    def redact(self, text: str) -> Dict[str, Any]:
        """
        Detect and redact sensitive information from text.
        
        Returns dict with redacted text and metadata.
        """
        if not self.config.enabled or not text:
            return {'text': text, 'redactions_count': 0, 'redactions': []}
        
        # Skip very short text
        if len(text) < self.config.skip_short_text:
            return {'text': text, 'redactions_count': 0, 'redactions': []}
        
        # Truncate very long text for performance
        if len(text) > self.config.max_text_length:
            text = text[:self.config.max_text_length]
        
        # Collect all detections from all detectors
        all_detections = []
        for detector in self.detectors:
            detections = detector.detect(text)
            all_detections.extend(detections)
        
        # Filter by confidence
        all_detections = [
            d for d in all_detections 
            if d['confidence'] >= self.config.min_confidence
        ]
        
        # Merge overlapping detections
        merged = self._merge_overlapping(all_detections)
        
        # Apply redactions
        redacted_text = self._apply_redactions(text, merged)
        
        # Audit log if enabled
        if self.config.enable_audit_log and merged:
            self._log_redactions(merged)
        
        return {
            'text': redacted_text,
            'original_length': len(text),
            'redacted_length': len(redacted_text),
            'redactions_count': len(merged),
            'redactions': merged
        }
    
    def is_sensitive(self, text: str) -> bool:
        """Quick check if text contains any sensitive data"""
        result = self.redact(text)
        return result['redactions_count'] > 0
```

### 4.3 Presidio Detector (`privacy/detectors/presidio_detector.py`)

```python
class PresidioDetector:
    """PII detection using Microsoft Presidio"""
    
    def __init__(self, config: PrivacyConfig):
        self.config = config
        self._init_analyzer()
    
    def _init_analyzer(self):
        """Initialize Presidio analyzer with custom recognizers"""
        from presidio_analyzer import AnalyzerEngine, PatternRecognizer, Pattern
        
        self.analyzer = AnalyzerEngine()
        
        # Add custom password pattern recognizer
        password_patterns = [
            Pattern("password_assignment", r"(?i)(password|passwd|pwd|pass)\s*[:=]\s*\S+", 0.8),
            Pattern("password_json", r'"password"\s*:\s*"[^"]+', 0.85),
        ]
        password_recognizer = PatternRecognizer(
            supported_entity="PASSWORD",
            patterns=password_patterns
        )
        self.analyzer.registry.add_recognizer(password_recognizer)
        
        # Add API key pattern recognizer
        api_key_patterns = [
            Pattern("api_key_assignment", r"(?i)(api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*\S+", 0.85),
            Pattern("bearer_token", r"(?i)bearer\s+[a-zA-Z0-9\-_.]+", 0.9),
            Pattern("aws_key", r"(?i)(AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}", 0.95),
            Pattern("github_token", r"gh[ps]_[A-Za-z0-9_]{36}", 0.95),
            Pattern("openai_key", r"sk-[A-Za-z0-9]{48}", 0.95),
        ]
        api_key_recognizer = PatternRecognizer(
            supported_entity="API_KEY",
            patterns=api_key_patterns
        )
        self.analyzer.registry.add_recognizer(api_key_recognizer)
    
    def detect(self, text: str) -> List[Dict]:
        """Detect PII in text"""
        results = self.analyzer.analyze(
            text=text,
            entities=self.config.pii_types,
            language='en'
        )
        
        return [
            {
                'type': r.entity_type,
                'start': r.start,
                'end': r.end,
                'confidence': r.score,
                'detector': 'presidio'
            }
            for r in results
        ]
```

### 4.4 Secrets Detector (`privacy/detectors/secrets_detector.py`)

```python
class SecretsDetector:
    """Secret detection using detect-secrets library"""
    
    def __init__(self, config: PrivacyConfig):
        self.config = config
        self._init_plugins()
    
    def _init_plugins(self):
        """Initialize detect-secrets plugins"""
        from detect_secrets.core.plugins import (
            AWSKeyDetector,
            ArtifactoryDetector,
            AzureStorageKeyDetector,
            Base64HighEntropyString,
            BasicAuthDetector,
            CloudantDetector,
            GitHubTokenDetector,
            HexHighEntropyString,
            IbmCloudIamDetector,
            IbmCosHmacDetector,
            JwtTokenDetector,
            KeywordDetector,
            MailchimpDetector,
            NpmDetector,
            PrivateKeyDetector,
            SendGridDetector,
            SlackDetector,
            SoftlayerDetector,
            SquareOAuthDetector,
            StripeDetector,
            TwilioKeyDetector,
        )
        
        self.plugins = [
            AWSKeyDetector(),
            Base64HighEntropyString(limit=4.5),
            BasicAuthDetector(),
            GitHubTokenDetector(),
            HexHighEntropyString(limit=3.0),
            JwtTokenDetector(),
            KeywordDetector(),
            PrivateKeyDetector(),
            SlackDetector(),
            StripeDetector(),
        ]
    
    def detect(self, text: str) -> List[Dict]:
        """Detect secrets in text using line-by-line scanning"""
        detections = []
        
        for line_num, line in enumerate(text.split('\n')):
            for plugin in self.plugins:
                try:
                    results = plugin.analyze_line(line, line_num)
                    for secret in results:
                        # Calculate absolute position in original text
                        line_start = sum(len(l) + 1 for l in text.split('\n')[:line_num])
                        detections.append({
                            'type': secret.type,
                            'start': line_start + secret.secret_value_start,
                            'end': line_start + secret.secret_value_end,
                            'confidence': 0.85,  # detect-secrets doesn't provide confidence
                            'detector': 'detect_secrets',
                            'plugin': plugin.__class__.__name__
                        })
                except Exception:
                    pass  # Skip plugin errors
        
        return detections
```

### 4.5 Custom Pattern Detector (`privacy/detectors/custom_patterns.py`)

```python
class CustomPatternDetector:
    """Custom regex-based detection for domain-specific secrets"""
    
    PATTERNS = {
        'CONNECTION_STRING': [
            (r'(?i)(mongodb|postgres|mysql|redis|amqp)://[^\s]+', 0.9),
            (r'(?i)Server=[^;]+;.*Password=[^;]+', 0.9),
        ],
        'PRIVATE_KEY': [
            (r'-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----', 0.95),
            (r'-----BEGIN PGP PRIVATE KEY BLOCK-----', 0.95),
        ],
        'CERTIFICATE': [
            (r'-----BEGIN CERTIFICATE-----', 0.7),
        ],
        'SSH_KEY': [
            (r'ssh-(rsa|dss|ed25519)\s+[A-Za-z0-9+/=]+', 0.85),
        ],
        'BEARER_TOKEN': [
            (r'(?i)authorization:\s*bearer\s+\S+', 0.9),
        ],
        'WEBHOOK_URL': [
            (r'https://hooks\.slack\.com/[^\s]+', 0.9),
            (r'https://discord\.com/api/webhooks/[^\s]+', 0.9),
        ],
        'ENV_SECRET': [
            (r'(?i)^[A-Z_]+_(SECRET|KEY|TOKEN|PASSWORD|CREDENTIALS)\s*=\s*\S+', 0.85),
        ],
    }
    
    def __init__(self, config: PrivacyConfig):
        self.config = config
        self.compiled_patterns = self._compile_patterns()
    
    def _compile_patterns(self):
        """Pre-compile regex patterns for performance"""
        compiled = {}
        for entity_type, patterns in self.PATTERNS.items():
            compiled[entity_type] = [
                (re.compile(pattern, re.MULTILINE), confidence)
                for pattern, confidence in patterns
            ]
        return compiled
    
    def detect(self, text: str) -> List[Dict]:
        """Detect custom patterns in text"""
        detections = []
        
        for entity_type, patterns in self.compiled_patterns.items():
            for regex, confidence in patterns:
                for match in regex.finditer(text):
                    detections.append({
                        'type': entity_type,
                        'start': match.start(),
                        'end': match.end(),
                        'confidence': confidence,
                        'detector': 'custom_pattern'
                    })
        
        return detections
```

---

## 5. Integration Points

### 5.1 Integration into OCR Facade

**File:** `python-desktop-app/ocr/facade.py`

```python
# At top of file
from privacy import PrivacyFilter, PrivacyConfig

class OCRFacade:
    def __init__(self, config: Optional[OCRConfig] = None):
        self.config = config or OCRConfig.from_env()
        self._primary_engine = None
        self._fallback_engines = []
        
        # NEW: Initialize privacy filter
        privacy_config = PrivacyConfig.from_env()
        self._privacy_filter = PrivacyFilter(privacy_config) if privacy_config.enabled else None
        
        self._initialize_engines()
    
    def extract_text(self, image, window_title='', app_name='', ...):
        # ... existing extraction code ...
        
        result = engine.extract_text(img_array)
        
        if result.get('success'):
            text = result.get('text', '')
            
            # NEW: Apply privacy filtering
            if self._privacy_filter:
                filter_result = self._privacy_filter.redact(text)
                text = filter_result['text']
                result['privacy_redactions'] = filter_result['redactions_count']
            
            # Continue with existing flow...
```

### 5.2 Configuration Environment Variables

Add to `.env.example`:
```bash
# Privacy Filter Configuration
PRIVACY_FILTER_ENABLED=true
PRIVACY_MIN_CONFIDENCE=0.7
PRIVACY_DETECT_PII=true
PRIVACY_DETECT_SECRETS=true
PRIVACY_DETECT_CUSTOM_PATTERNS=true
PRIVACY_REDACTION_STRATEGY=mask  # mask, hash, remove, entity_type
PRIVACY_ENABLE_AUDIT_LOG=false
```

### 5.3 Dependencies Update

Add to `requirements.txt`:
```
# Privacy & Security
presidio-analyzer>=2.2.0
presidio-anonymizer>=2.2.0
detect-secrets>=1.4.0
```

---

## 6. Implementation Phases

### Phase 1: Core Module (2-3 days)
- [ ] Create `privacy/` module structure
- [ ] Implement `PrivacyConfig` with environment loading
- [ ] Implement `PrivacyFilter` base class
- [ ] Implement `CustomPatternDetector` (no external deps)
- [ ] Add unit tests for custom patterns

### Phase 2: Presidio Integration (2 days)
- [ ] Add Presidio to requirements
- [ ] Implement `PresidioDetector` with custom recognizers
- [ ] Add password/API key custom recognizers
- [ ] Test with sample OCR outputs
- [ ] Configure confidence thresholds

### Phase 3: detect-secrets Integration (1-2 days)
- [ ] Add detect-secrets to requirements
- [ ] Implement `SecretsDetector`
- [ ] Test with developer-focused content
- [ ] Tune high-entropy detection settings

### Phase 4: OCR Facade Integration (1 day)
- [ ] Integrate `PrivacyFilter` into `OCRFacade.extract_text()`
- [ ] Add privacy metrics to result dict
- [ ] Update configuration loading
- [ ] End-to-end testing

### Phase 5: Testing & Documentation (2 days)
- [ ] Comprehensive unit tests
- [ ] Integration tests with real screenshots
- [ ] Performance benchmarking
- [ ] False positive/negative analysis
- [ ] Documentation updates

### Phase 6: Optional Enhancements
- [ ] Audit logging implementation
- [ ] Admin dashboard for privacy stats
- [ ] User notification for heavy redaction
- [ ] Per-user/per-project privacy settings

---

## 7. Testing Strategy

### 7.1 Test Cases

```python
# Test data samples
TEST_CASES = [
    # API Keys
    ("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE", "API_KEY"),
    ("api_key: sk-1234567890abcdef1234567890abcdef12345678abcd", "API_KEY"),
    ("Authorization: Bearer eyJhbGciOiJIUzI1NiIs...", "API_KEY"),
    
    # Passwords
    ("password=MyS3cr3tP@ssw0rd!", "PASSWORD"),
    ('{"password": "hunter2"}', "PASSWORD"),
    ("POSTGRES_PASSWORD=db_secret_123", "PASSWORD"),
    
    # Connection Strings
    ("mongodb://user:pass@localhost:27017/db", "CONNECTION_STRING"),
    ("postgres://admin:secret@db.example.com/prod", "CONNECTION_STRING"),
    
    # Credit Cards
    ("Card: 4111-1111-1111-1111", "CREDIT_CARD"),
    
    # Social Security
    ("SSN: 123-45-6789", "US_SSN"),
    
    # Private Keys
    ("-----BEGIN RSA PRIVATE KEY-----", "PRIVATE_KEY"),
    
    # Email/Phone
    ("Contact: john.doe@example.com", "EMAIL_ADDRESS"),
    ("Phone: (555) 123-4567", "PHONE_NUMBER"),
]
```

### 7.2 Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Filter latency | < 50ms | For typical OCR output (~500 chars) |
| Memory overhead | < 50MB | Including Presidio models |
| False positive rate | < 5% | Minimize over-redaction |
| False negative rate | < 1% | Critical for actual secrets |

### 7.3 Test Commands

```bash
# Run privacy filter tests
pytest python-desktop-app/privacy/tests/ -v

# Test with real OCR output
python -m privacy.test_real_ocr --input sample_ocr_output.txt

# Benchmark performance
python -m privacy.benchmark --iterations 1000
```

---

## 8. Redaction Strategies

| Strategy | Example | Use Case |
|----------|---------|----------|
| `mask` | `password: ********` | Default, preserves structure |
| `entity_type` | `password: [PASSWORD]` | Debugging, shows what was removed |
| `hash` | `password: a1b2c3d4` | Audit trails needing consistency |
| `remove` | `password: ` | Minimal output size |

---

## 9. Handling False Positives

Common false positive scenarios and mitigations:

1. **High-entropy code variables**: Increase entropy threshold
2. **Base64-encoded non-secrets**: Whitelist known patterns
3. **UUIDs detected as secrets**: Add UUID exclusion pattern
4. **URLs with path params**: Context-aware detection
5. **Code snippets with example secrets**: Consider app context (is it an IDE?)

```python
# Example: Context-aware filtering
def should_skip_filtering(app_name: str, window_title: str) -> bool:
    """Skip filtering for certain trusted contexts"""
    safe_apps = ['notepad++', 'sublime_text']  # Example: note-taking
    if any(app.lower() in app_name.lower() for app in safe_apps):
        return False  # Still filter these
    return False
```

---

## 10. Monitoring & Observability

### 10.1 Metrics to Track
- `privacy_filter_latency_ms` - Processing time
- `privacy_redactions_total` - Count by entity type
- `privacy_false_positive_reports` - User-reported false positives
- `privacy_filter_errors` - Processing errors

### 10.2 Logging
```python
logger.info(f"Privacy filter: {redactions_count} redactions in {latency_ms}ms")
logger.debug(f"Redacted types: {[r['type'] for r in redactions]}")
```

---

## 11. Security Considerations

1. **Filter runs locally** - Sensitive data never leaves the device unfiltered
2. **No training on user data** - Pattern-based, not ML on user content
3. **Audit logs are optional** - Disabled by default
4. **Redaction is irreversible** - Original text not stored post-filter
5. **Configurable strictness** - Users can adjust sensitivity

---

## 12. Rollout Plan

### Week 1: Development
- Implement core privacy module
- Unit tests passing
- Local testing complete

### Week 2: Integration
- Integrate with OCR facade
- End-to-end testing
- Performance optimization

### Week 3: Beta Release
- Feature flag enabled for beta users
- Monitor false positive/negative rates
- Gather feedback

### Week 4: General Availability
- Enable by default for all users
- Documentation published
- Support channels ready

---

## 13. Files to Create

```
python-desktop-app/
├── privacy/
│   ├── __init__.py              # Module exports
│   ├── config.py                # PrivacyConfig dataclass
│   ├── filter.py                # PrivacyFilter main class
│   ├── detectors/
│   │   ├── __init__.py
│   │   ├── base.py              # BaseDetector interface
│   │   ├── presidio_detector.py # Presidio implementation
│   │   ├── secrets_detector.py  # detect-secrets implementation
│   │   └── custom_patterns.py   # Custom regex patterns
│   ├── redactors/
│   │   ├── __init__.py
│   │   └── text_redactor.py     # Redaction strategies
│   └── tests/
│       ├── __init__.py
│       ├── test_filter.py
│       ├── test_presidio.py
│       ├── test_secrets.py
│       ├── test_patterns.py
│       └── test_integration.py
```

---

## 14. Success Criteria

- [ ] Zero sensitive data reaches Supabase unfiltered (when enabled)
- [ ] Processing overhead < 100ms per OCR result
- [ ] False positive rate < 5% in production
- [ ] False negative rate < 1% for known secret patterns
- [ ] No impact on OCR accuracy or existing functionality
- [ ] Users can disable/configure via environment variables

---

## Appendix A: Sample Redacted Output

**Before:**
```
Terminal - PowerShell
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
Database: postgres://admin:SuperSecret123@db.prod.example.com:5432/myapp
Contact: john.doe@company.com | SSN: 123-45-6789
```

**After (mask strategy):**
```
Terminal - PowerShell
AWS_ACCESS_KEY_ID=********
AWS_SECRET_ACCESS_KEY=********
Database: postgres://********@db.prod.example.com:5432/myapp
Contact: ******** | SSN: ********
```

---

## Appendix B: Quick Start for Implementation

```bash
# 1. Install dependencies
pip install presidio-analyzer presidio-anonymizer detect-secrets

# 2. Create module structure
mkdir -p python-desktop-app/privacy/detectors python-desktop-app/privacy/redactors python-desktop-app/privacy/tests

# 3. Set environment variables
export PRIVACY_FILTER_ENABLED=true
export PRIVACY_MIN_CONFIDENCE=0.7

# 4. Run tests
pytest python-desktop-app/privacy/tests/ -v
```

---

*Document Version: 1.0*  
*Created: 2026-02-24*  
*Author: JIRAForge Development Team*
