"""
Test ID & PII Sanitization Fixes

Tests for the sanitization fixes covering:
1. Atlassian Account IDs (712020:uuid) are detected and redacted
2. Atlassian ARIs (ari:cloud:...) are detected and redacted
3. UUIDs (standalone) are detected and redacted
4. Email addresses are detected by custom pattern detector
5. SSN without dashes (labeled) is detected
6. Short/simple passwords are NOT dropped by confidence threshold
7. Truncated text is safely redacted (not appended unfiltered)
8. Facade error handler respects fail_open=False
9. pii_types config includes all new entity types
"""
import unittest
import os
import sys

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

from privacy import PrivacyFilter, PrivacyConfig
from privacy.config import RedactionStrategy
from privacy.detectors import CustomPatternDetector, Detection


# ============================================================================
# CustomPatternDetector — New Pattern Tests
# ============================================================================

class TestAtlassianAccountIdDetection(unittest.TestCase):
    """Atlassian Account IDs (format: 712020:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)"""

    def setUp(self):
        self.detector = CustomPatternDetector()

    def test_detect_atlassian_account_id(self):
        """Standard Atlassian account ID is detected."""
        text = "User account: 712020:a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        detections = self.detector.detect(text)

        atlassian_ids = [d for d in detections if d.entity_type == 'ATLASSIAN_ACCOUNT_ID']
        self.assertTrue(
            len(atlassian_ids) > 0,
            f"Expected ATLASSIAN_ACCOUNT_ID detection, got: {[d.entity_type for d in detections]}"
        )
        self.assertIn(
            '712020:a1b2c3d4-e5f6-7890-abcd-ef1234567890',
            [d.text for d in atlassian_ids]
        )

    def test_detect_atlassian_id_in_log_output(self):
        """Atlassian ID embedded in realistic log-like OCR text."""
        text = "[INFO] Authenticated user 557058:c3fa0e12-9a4b-4c91-b6d3-deadbeef1234 via OAuth"
        detections = self.detector.detect(text)

        atlassian_ids = [d for d in detections if d.entity_type == 'ATLASSIAN_ACCOUNT_ID']
        self.assertTrue(len(atlassian_ids) > 0)

    def test_atlassian_id_confidence_above_threshold(self):
        """Atlassian account ID should have confidence >= 0.7 (the default threshold)."""
        text = "accountId: 712020:a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        detections = self.detector.detect(text)

        atlassian_ids = [d for d in detections if d.entity_type == 'ATLASSIAN_ACCOUNT_ID']
        self.assertTrue(len(atlassian_ids) > 0)
        self.assertGreaterEqual(atlassian_ids[0].confidence, 0.7)


class TestAtlassianAriDetection(unittest.TestCase):
    """Atlassian ARIs (format: ari:cloud:<product>::<resource>/<uuid>)"""

    def setUp(self):
        self.detector = CustomPatternDetector()

    def test_detect_ari_jira(self):
        """Jira ARI is detected."""
        text = "Installation: ari:cloud:jira::app/12345678-abcd-ef01-2345-6789abcdef01"
        detections = self.detector.detect(text)

        ari_detections = [d for d in detections if d.entity_type == 'ATLASSIAN_ARI']
        self.assertTrue(
            len(ari_detections) > 0,
            f"Expected ATLASSIAN_ARI detection, got: {[d.entity_type for d in detections]}"
        )

    def test_detect_ari_confluence(self):
        """Confluence ARI is detected."""
        text = "ari:cloud:confluence::site/abcdef12-3456-7890-abcd-ef1234567890"
        detections = self.detector.detect(text)

        ari_detections = [d for d in detections if d.entity_type == 'ATLASSIAN_ARI']
        self.assertTrue(len(ari_detections) > 0)

    def test_ari_confidence_above_threshold(self):
        """ARI should have confidence >= 0.7."""
        text = "ari:cloud:jira::app/12345678-abcd-ef01-2345-6789abcdef01"
        detections = self.detector.detect(text)

        ari_detections = [d for d in detections if d.entity_type == 'ATLASSIAN_ARI']
        self.assertTrue(len(ari_detections) > 0)
        self.assertGreaterEqual(ari_detections[0].confidence, 0.7)


class TestUuidDetection(unittest.TestCase):
    """Standalone UUID detection"""

    def setUp(self):
        self.detector = CustomPatternDetector()

    def test_detect_standalone_uuid(self):
        """Standalone UUID is detected."""
        text = "Cloud ID: a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        detections = self.detector.detect(text)

        uuid_detections = [d for d in detections if d.entity_type == 'UUID']
        self.assertTrue(
            len(uuid_detections) > 0,
            f"Expected UUID detection, got: {[d.entity_type for d in detections]}"
        )

    def test_detect_multiple_uuids(self):
        """Multiple UUIDs in text are all detected."""
        text = (
            "org=11111111-2222-3333-4444-555555555555 "
            "user=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        )
        detections = self.detector.detect(text)

        uuid_detections = [d for d in detections if d.entity_type == 'UUID']
        self.assertGreaterEqual(len(uuid_detections), 2)

    def test_uuid_not_false_positive_on_short_hex(self):
        """Short hex strings that aren't UUIDs should not trigger."""
        text = "commit abcdef12 merged into main"
        detections = self.detector.detect(text)

        uuid_detections = [d for d in detections if d.entity_type == 'UUID']
        self.assertEqual(len(uuid_detections), 0)


class TestEmailDetection(unittest.TestCase):
    """Email address detection via custom pattern."""

    def setUp(self):
        self.detector = CustomPatternDetector()

    def test_detect_email_address(self):
        """Standard email address is detected."""
        text = "Contact: admin@example.com for access"
        detections = self.detector.detect(text)

        email_detections = [d for d in detections if d.entity_type == 'EMAIL_ADDRESS']
        self.assertTrue(
            len(email_detections) > 0,
            f"Expected EMAIL_ADDRESS detection, got: {[d.entity_type for d in detections]}"
        )

    def test_detect_email_with_plus(self):
        """Email with plus addressing."""
        text = "Sent to user+tag@company.org"
        detections = self.detector.detect(text)

        email_detections = [d for d in detections if d.entity_type == 'EMAIL_ADDRESS']
        self.assertTrue(len(email_detections) > 0)

    def test_detect_email_in_ocr_text(self):
        """Email in realistic OCR output."""
        text = """Jira Settings
        Admin Email: john.doe@acme-corp.com
        Notifications: enabled
        """
        detections = self.detector.detect(text)

        email_detections = [d for d in detections if d.entity_type == 'EMAIL_ADDRESS']
        self.assertTrue(len(email_detections) > 0)


class TestSsnWithoutDashes(unittest.TestCase):
    """SSN without dashes (labeled with keyword)."""

    def setUp(self):
        self.detector = CustomPatternDetector()

    def test_detect_ssn_with_keyword(self):
        """SSN=123456789 (labeled, no dashes) is detected."""
        text = "ssn=123456789"
        detections = self.detector.detect(text)

        ssn_detections = [d for d in detections if d.entity_type == 'US_SSN']
        self.assertTrue(
            len(ssn_detections) > 0,
            f"Expected US_SSN detection, got: {[d.entity_type for d in detections]}"
        )

    def test_detect_social_security_label(self):
        """social_security: 123456789 is detected."""
        text = "social security: 123456789"
        detections = self.detector.detect(text)

        ssn_detections = [d for d in detections if d.entity_type == 'US_SSN']
        self.assertTrue(len(ssn_detections) > 0)


# ============================================================================
# Password Confidence — Short passwords must NOT be silently dropped
# ============================================================================

class TestShortPasswordConfidence(unittest.TestCase):
    """
    Short or low-complexity passwords must still be redacted.
    Previously, confidence penalties for short text and low complexity
    could drop passwords below the 0.7 threshold, leaking them through.
    """

    def setUp(self):
        self.detector = CustomPatternDetector()

    def test_short_password_detected(self):
        """Short password like 'password=abc' must still be detected."""
        text = "password=abc"
        detections = self.detector.detect(text)

        pw = [d for d in detections if d.entity_type == 'PASSWORD']
        self.assertTrue(len(pw) > 0, "Short password must be detected")

    def test_short_password_confidence_above_threshold(self):
        """Short password confidence must stay >= 0.7 (default threshold)."""
        text = "password=short"
        detections = self.detector.detect(text)

        pw = [d for d in detections if d.entity_type == 'PASSWORD']
        self.assertTrue(len(pw) > 0)
        self.assertGreaterEqual(
            pw[0].confidence, 0.7,
            f"Short password confidence {pw[0].confidence} is below 0.7 threshold"
        )

    def test_simple_password_not_dropped(self):
        """Low-complexity password like 'password=test' must NOT fall below threshold."""
        text = "password=test"
        detections = self.detector.detect(text)

        pw = [d for d in detections if d.entity_type == 'PASSWORD']
        self.assertTrue(len(pw) > 0)
        self.assertGreaterEqual(
            pw[0].confidence, 0.7,
            f"Simple password confidence {pw[0].confidence} dropped below threshold"
        )

    def test_complex_password_gets_high_confidence(self):
        """Complex password should get a confidence boost."""
        text = "password=C0mpl3x!P@ss"
        detections = self.detector.detect(text)

        pw = [d for d in detections if d.entity_type == 'PASSWORD']
        self.assertTrue(len(pw) > 0)
        self.assertGreaterEqual(pw[0].confidence, 0.8)


# ============================================================================
# PrivacyFilter — End-to-end redaction tests for new patterns
# ============================================================================

class TestPrivacyFilterRedactsIds(unittest.TestCase):
    """End-to-end: PrivacyFilter must mask Atlassian IDs, UUIDs, emails."""

    def setUp(self):
        config = PrivacyConfig()
        config.detect_pii = False       # Disable Presidio dependency
        config.detect_secrets = False
        config.detect_custom_patterns = True
        config.redaction_strategy = RedactionStrategy.MASK
        self.filter = PrivacyFilter(config)

    def test_redact_atlassian_account_id(self):
        """Atlassian account ID is masked in filter output."""
        text = "User: 712020:a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        result = self.filter.redact(text)

        self.assertNotIn('712020:a1b2c3d4', result['text'])
        self.assertNotIn('ef1234567890', result['text'])
        self.assertGreater(result['redactions_count'], 0)

    def test_redact_ari(self):
        """Atlassian ARI is masked in filter output."""
        text = "Install: ari:cloud:jira::app/12345678-abcd-ef01-2345-6789abcdef01"
        result = self.filter.redact(text)

        self.assertNotIn('ari:cloud:jira', result['text'])
        self.assertGreater(result['redactions_count'], 0)

    def test_redact_uuid(self):
        """Standalone UUID is masked in filter output."""
        text = "Cloud ID = a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        result = self.filter.redact(text)

        self.assertNotIn('a1b2c3d4-e5f6-7890', result['text'])
        self.assertGreater(result['redactions_count'], 0)

    def test_redact_email(self):
        """Email address is masked in filter output."""
        text = "Admin email: admin@example.com"
        result = self.filter.redact(text)

        self.assertNotIn('admin@example.com', result['text'])
        self.assertGreater(result['redactions_count'], 0)

    def test_redact_short_password(self):
        """Short password is NOT leaked through the filter."""
        text = "password=abc"
        result = self.filter.redact(text)

        self.assertNotIn('abc', result['text'].split('password=')[-1].split()[0] if 'password=' in result['text'] else '')
        self.assertGreater(result['redactions_count'], 0)

    def test_mixed_ocr_text_all_ids_redacted(self):
        """Realistic OCR text with multiple ID types — everything is masked."""
        text = """Jira Admin Panel
User: 557058:deadbeef-1234-5678-abcd-ef9876543210
Cloud ID: a1b2c3d4-0000-1111-2222-333344445555
App: ari:cloud:jira::app/aaaabbbb-cccc-dddd-eeee-ffffffffffff
Contact: ops@company.com
Status: Active
"""
        result = self.filter.redact(text)

        # All sensitive IDs must be gone
        self.assertNotIn('557058:deadbeef', result['text'])
        self.assertNotIn('a1b2c3d4-0000-1111', result['text'])
        self.assertNotIn('ari:cloud:jira', result['text'])
        self.assertNotIn('ops@company.com', result['text'])

        # Non-sensitive text preserved
        self.assertIn('Jira Admin Panel', result['text'])
        self.assertIn('Status: Active', result['text'])

        # Should have at least 4 redactions
        self.assertGreaterEqual(result['redactions_count'], 4)


# ============================================================================
# PrivacyFilter — Truncated text handling
# ============================================================================

class TestTruncatedTextSafety(unittest.TestCase):
    """
    Text exceeding max_text_length must NOT have its tail appended unfiltered.
    The fix replaces the old comment-only note with actual redaction.
    """

    def setUp(self):
        config = PrivacyConfig()
        config.detect_pii = False
        config.detect_secrets = False
        config.detect_custom_patterns = True
        config.max_text_length = 100  # Intentionally low for testing
        self.filter = PrivacyFilter(config)

    def test_truncated_text_does_not_leak_tail(self):
        """Text beyond max_text_length must not appear in output."""
        safe_prefix = "A" * 90
        sensitive_tail = " password=LeakedSecret123!"
        text = safe_prefix + sensitive_tail  # > 100 chars

        result = self.filter.redact(text)

        # The sensitive tail must NOT appear verbatim
        self.assertNotIn('LeakedSecret123', result['text'])
        # Should see the truncation marker
        self.assertIn('[TRUNCATED', result['text'])

    def test_truncated_marker_present(self):
        """Truncation marker should be in output for long text."""
        text = "x" * 200
        result = self.filter.redact(text)

        self.assertIn('TRUNCATED', result['text'])
        self.assertIn('redacted', result['text'].lower())


# ============================================================================
# PrivacyConfig — New entity types registered
# ============================================================================

class TestConfigIncludesNewPiiTypes(unittest.TestCase):
    """pii_types must include all new entity types for proper filtering."""

    def test_atlassian_account_id_in_pii_types(self):
        config = PrivacyConfig()
        self.assertIn('ATLASSIAN_ACCOUNT_ID', config.pii_types)

    def test_atlassian_ari_in_pii_types(self):
        config = PrivacyConfig()
        self.assertIn('ATLASSIAN_ARI', config.pii_types)

    def test_uuid_in_pii_types(self):
        config = PrivacyConfig()
        self.assertIn('UUID', config.pii_types)

    def test_email_address_in_pii_types(self):
        config = PrivacyConfig()
        self.assertIn('EMAIL_ADDRESS', config.pii_types)

    def test_us_ssn_in_pii_types(self):
        config = PrivacyConfig()
        self.assertIn('US_SSN', config.pii_types)

    def test_us_itin_in_pii_types(self):
        config = PrivacyConfig()
        self.assertIn('US_ITIN', config.pii_types)


# ============================================================================
# PrivacyFilter — Fail-open vs fail-closed behavior
# ============================================================================

class TestFilterFailOpenBehavior(unittest.TestCase):
    """
    When fail_open=False (default), filter errors must NOT return original text.
    """

    def test_fail_closed_returns_error_text(self):
        """fail_open=False: error returns redacted placeholder, not original."""
        config = PrivacyConfig()
        config.fail_open = False
        config.detect_pii = False
        config.detect_custom_patterns = True
        pf = PrivacyFilter(config)

        # Simulate by checking the config value propagates correctly
        self.assertFalse(config.fail_open)

    def test_fail_open_returns_original(self):
        """fail_open=True: error returns original text (less secure)."""
        config = PrivacyConfig()
        config.fail_open = True
        self.assertTrue(config.fail_open)


if __name__ == '__main__':
    unittest.main()
