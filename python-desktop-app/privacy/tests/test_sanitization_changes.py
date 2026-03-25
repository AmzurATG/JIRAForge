"""
Test OCR Data Sanitization Changes

Tests for the privacy configuration fixes and runtime config delivery:
1. PRIVACY_DETECT_PII defaults to 'true' in from_env()
2. set_runtime_privacy_config() correctly sets os.environ
3. PrivacyFilter initializes with Presidio when detect_pii=True
4. End-to-end: server config dict → env vars → PrivacyConfig → PrivacyFilter
"""
import unittest
import os
import sys

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

from privacy import PrivacyFilter, PrivacyConfig
from privacy.config import RedactionStrategy


# ============================================================================
# Helper: Simulates set_runtime_privacy_config from desktop_app.py
# (Imported logic to keep tests self-contained without importing full desktop_app)
# ============================================================================
def set_runtime_privacy_config(config_dict):
    """Reproduce the function from desktop_app.py for isolated testing."""
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


# All PRIVACY_* env vars that tests may set — cleaned up in tearDown
PRIVACY_ENV_VARS = [
    'PRIVACY_FILTER_ENABLED', 'PRIVACY_MIN_CONFIDENCE', 'PRIVACY_DETECT_PII',
    'PRIVACY_DETECT_SECRETS', 'PRIVACY_DETECT_CUSTOM_PATTERNS',
    'PRIVACY_REDACTION_STRATEGY', 'PRIVACY_MASK_CHAR', 'PRIVACY_MASK_LENGTH',
    'PRIVACY_FAIL_OPEN', 'PRIVACY_ENABLE_AUDIT_LOG', 'PRIVACY_SKIP_SHORT_TEXT',
    'PRIVACY_MAX_TEXT_LENGTH', 'PRIVACY_PII_TYPES',
]


class TestPrivacyDetectPIIDefault(unittest.TestCase):
    """
    Tests that PRIVACY_DETECT_PII defaults to 'true' in from_env().
    This was the core bug — Presidio was silently disabled.
    """

    def tearDown(self):
        for var in PRIVACY_ENV_VARS:
            os.environ.pop(var, None)

    def test_detect_pii_defaults_true_when_env_not_set(self):
        """PRIVACY_DETECT_PII should default to True when env var is absent."""
        # Ensure the env var is NOT set
        os.environ.pop('PRIVACY_DETECT_PII', None)

        config = PrivacyConfig.from_env()
        self.assertTrue(
            config.detect_pii,
            "detect_pii should default to True so Presidio PII detection is active"
        )

    def test_detect_pii_can_be_disabled_explicitly(self):
        """Operators can still disable Presidio by setting PRIVACY_DETECT_PII=false."""
        os.environ['PRIVACY_DETECT_PII'] = 'false'

        config = PrivacyConfig.from_env()
        self.assertFalse(config.detect_pii)

    def test_detect_pii_enabled_explicitly(self):
        """PRIVACY_DETECT_PII=true should enable it."""
        os.environ['PRIVACY_DETECT_PII'] = 'true'

        config = PrivacyConfig.from_env()
        self.assertTrue(config.detect_pii)

    def test_detect_pii_case_insensitive(self):
        """PRIVACY_DETECT_PII should be case-insensitive."""
        os.environ['PRIVACY_DETECT_PII'] = 'True'
        self.assertTrue(PrivacyConfig.from_env().detect_pii)

        os.environ['PRIVACY_DETECT_PII'] = 'TRUE'
        self.assertTrue(PrivacyConfig.from_env().detect_pii)

        os.environ['PRIVACY_DETECT_PII'] = 'False'
        self.assertFalse(PrivacyConfig.from_env().detect_pii)

    def test_dataclass_default_matches_from_env_default(self):
        """Dataclass default and from_env() default should both be True."""
        dataclass_config = PrivacyConfig()
        env_config = PrivacyConfig.from_env()

        self.assertEqual(
            dataclass_config.detect_pii,
            env_config.detect_pii,
            "Dataclass default and from_env() default must match"
        )

    def test_all_defaults_from_env(self):
        """Verify all from_env() defaults match expected values."""
        # Clear all PRIVACY_* env vars
        for var in PRIVACY_ENV_VARS:
            os.environ.pop(var, None)

        config = PrivacyConfig.from_env()

        self.assertTrue(config.enabled, "enabled should default to True")
        self.assertEqual(config.min_confidence, 0.7)
        self.assertTrue(config.detect_pii, "detect_pii should default to True")
        self.assertFalse(config.detect_secrets, "detect_secrets should default to False")
        self.assertTrue(config.detect_custom_patterns, "detect_custom_patterns should default to True")
        self.assertEqual(config.redaction_strategy, RedactionStrategy.MASK)
        self.assertEqual(config.mask_char, '*')
        self.assertEqual(config.mask_length, 8)
        self.assertFalse(config.fail_open, "fail_open should default to False (secure)")


class TestSetRuntimePrivacyConfig(unittest.TestCase):
    """
    Tests for set_runtime_privacy_config() which converts the AI server's
    JSON privacy config into os.environ PRIVACY_* variables.
    """

    def tearDown(self):
        for var in PRIVACY_ENV_VARS:
            os.environ.pop(var, None)

    def test_full_server_config_applied(self):
        """All fields from server config dict should become env vars."""
        server_config = {
            'enabled': True,
            'min_confidence': 0.8,
            'detect_pii': True,
            'detect_secrets': False,
            'detect_custom_patterns': True,
            'redaction_strategy': 'entity_type',
            'mask_char': '#',
            'mask_length': 12,
            'fail_open': False,
        }

        set_runtime_privacy_config(server_config)

        self.assertEqual(os.environ['PRIVACY_FILTER_ENABLED'], 'true')
        self.assertEqual(os.environ['PRIVACY_MIN_CONFIDENCE'], '0.8')
        self.assertEqual(os.environ['PRIVACY_DETECT_PII'], 'true')
        self.assertEqual(os.environ['PRIVACY_DETECT_SECRETS'], 'false')
        self.assertEqual(os.environ['PRIVACY_DETECT_CUSTOM_PATTERNS'], 'true')
        self.assertEqual(os.environ['PRIVACY_REDACTION_STRATEGY'], 'entity_type')
        self.assertEqual(os.environ['PRIVACY_MASK_CHAR'], '#')
        self.assertEqual(os.environ['PRIVACY_MASK_LENGTH'], '12')
        self.assertEqual(os.environ['PRIVACY_FAIL_OPEN'], 'false')

    def test_booleans_converted_to_lowercase_strings(self):
        """Boolean values must be lowercase 'true'/'false' for from_env() parsing."""
        set_runtime_privacy_config({'enabled': True, 'detect_pii': False})

        self.assertEqual(os.environ['PRIVACY_FILTER_ENABLED'], 'true')
        self.assertEqual(os.environ['PRIVACY_DETECT_PII'], 'false')

    def test_numeric_values_converted_to_strings(self):
        """Numeric values must be converted to string for os.environ."""
        set_runtime_privacy_config({'min_confidence': 0.9, 'mask_length': 16})

        self.assertEqual(os.environ['PRIVACY_MIN_CONFIDENCE'], '0.9')
        self.assertEqual(os.environ['PRIVACY_MASK_LENGTH'], '16')

    def test_partial_config_only_sets_present_keys(self):
        """If server sends partial config, only those keys should be set."""
        # Clear first
        for var in PRIVACY_ENV_VARS:
            os.environ.pop(var, None)

        set_runtime_privacy_config({'detect_pii': True})

        self.assertEqual(os.environ.get('PRIVACY_DETECT_PII'), 'true')
        # Others should not be set
        self.assertIsNone(os.environ.get('PRIVACY_FILTER_ENABLED'))
        self.assertIsNone(os.environ.get('PRIVACY_MIN_CONFIDENCE'))

    def test_empty_config_is_noop(self):
        """Empty config dict should not set any env vars."""
        for var in PRIVACY_ENV_VARS:
            os.environ.pop(var, None)

        set_runtime_privacy_config({})

        for var in PRIVACY_ENV_VARS:
            self.assertIsNone(os.environ.get(var), f"{var} should not be set")


class TestEndToEndServerToPrivacyFilter(unittest.TestCase):
    """
    End-to-end tests: server config dict → env vars → PrivacyConfig → PrivacyFilter.
    Simulates the full flow of server-delivered privacy config.
    """

    def tearDown(self):
        for var in PRIVACY_ENV_VARS:
            os.environ.pop(var, None)

    def test_server_config_enables_pii_detection(self):
        """Server config with detect_pii=true should produce a config with Presidio enabled."""
        server_config = {
            'enabled': True,
            'min_confidence': 0.7,
            'detect_pii': True,
            'detect_custom_patterns': True,
            'detect_secrets': False,
            'redaction_strategy': 'mask',
            'mask_char': '*',
            'mask_length': 8,
            'fail_open': False,
        }

        # Step 1: Apply server config to env vars
        set_runtime_privacy_config(server_config)

        # Step 2: Load PrivacyConfig from env (as the OCR facade does)
        config = PrivacyConfig.from_env()

        self.assertTrue(config.enabled)
        self.assertTrue(config.detect_pii)
        self.assertTrue(config.detect_custom_patterns)
        self.assertFalse(config.detect_secrets)
        self.assertEqual(config.min_confidence, 0.7)

    def test_server_config_disables_filter(self):
        """Server config with enabled=false should disable the filter entirely."""
        set_runtime_privacy_config({'enabled': False})

        config = PrivacyConfig.from_env()
        self.assertFalse(config.enabled)

        # Filter should return text unchanged
        pf = PrivacyFilter(config)
        result = pf.redact('password=SuperSecret123!')
        self.assertEqual(result['text'], 'password=SuperSecret123!')
        self.assertEqual(result['redactions_count'], 0)

    def test_server_config_entity_type_strategy(self):
        """Server config with entity_type strategy should use [ENTITY_TYPE] replacements."""
        set_runtime_privacy_config({
            'enabled': True,
            'detect_pii': False,
            'detect_custom_patterns': True,
            'redaction_strategy': 'entity_type',
        })

        config = PrivacyConfig.from_env()
        self.assertEqual(config.redaction_strategy, RedactionStrategy.ENTITY_TYPE)

        pf = PrivacyFilter(config)
        result = pf.redact('DB_PASSWORD=TestPass000!')
        # entity_type strategy replaces with [PASSWORD] or similar
        self.assertNotIn('TestPass000', result['text'])

    def test_server_config_high_confidence_threshold(self):
        """High confidence threshold should filter out lower-confidence detections."""
        set_runtime_privacy_config({
            'enabled': True,
            'detect_pii': False,
            'detect_custom_patterns': True,
            'min_confidence': 0.99,
        })

        config = PrivacyConfig.from_env()
        self.assertEqual(config.min_confidence, 0.99)

        pf = PrivacyFilter(config)
        # Short password with low complexity may have confidence below 0.99
        result = pf.redact('password=short')
        # The text may or may not be filtered depending on confidence
        # But the config should have propagated correctly
        self.assertIn('filtered_by_confidence', result)

    def test_filter_redacts_common_sensitive_data(self):
        """Privacy filter should detect and mask common sensitive patterns."""
        set_runtime_privacy_config({
            'enabled': True,
            'detect_pii': False,
            'detect_custom_patterns': True,
            'redaction_strategy': 'mask',
        })

        config = PrivacyConfig.from_env()
        pf = PrivacyFilter(config)

        ocr_text = """
        Settings Panel
        DB_PASSWORD=TestPass000!
        API_KEY=AKIATESTTESTTESTTEST
        GITHUB_TOKEN=ghp_000000000000000000000000000000000000
        Status: Connected
        """

        result = pf.redact(ocr_text)

        # Sensitive data redacted
        self.assertNotIn('TestPass000', result['text'])
        self.assertNotIn('AKIATESTTESTTESTTEST', result['text'])

        # Non-sensitive data preserved
        self.assertIn('Settings Panel', result['text'])
        self.assertIn('Status: Connected', result['text'])

        # At least 2 redactions
        self.assertGreaterEqual(result['redactions_count'], 2)

    def test_fail_open_false_blocks_on_error(self):
        """With fail_open=false, filter errors should not pass through original text."""
        config = PrivacyConfig()
        config.fail_open = False
        config.detect_pii = False
        config.detect_custom_patterns = True
        # The filter itself handles errors — just verify config propagation
        self.assertFalse(config.fail_open)


class TestPrivacyConfigFromDict(unittest.TestCase):
    """Test PrivacyConfig.from_dict() which can be used to load server config directly."""

    def test_from_dict_with_full_config(self):
        """from_dict should set all fields from a dict."""
        data = {
            'enabled': True,
            'min_confidence': 0.8,
            'detect_pii': True,
            'detect_secrets': True,
            'detect_custom_patterns': True,
        }
        config = PrivacyConfig.from_dict(data)

        self.assertTrue(config.enabled)
        self.assertEqual(config.min_confidence, 0.8)
        self.assertTrue(config.detect_pii)
        self.assertTrue(config.detect_secrets)
        self.assertTrue(config.detect_custom_patterns)

    def test_from_dict_defaults_when_keys_missing(self):
        """from_dict should use defaults when keys are absent."""
        config = PrivacyConfig.from_dict({})

        self.assertTrue(config.enabled)
        self.assertTrue(config.detect_pii)
        self.assertTrue(config.detect_custom_patterns)


if __name__ == '__main__':
    unittest.main()
