"""
Test Privacy Filter

Unit tests for the privacy filtering module.
"""
import unittest
import os
import sys

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

from privacy import PrivacyFilter, PrivacyConfig
from privacy.detectors import CustomPatternDetector, Detection


class TestPrivacyConfig(unittest.TestCase):
    """Test PrivacyConfig class"""
    
    def test_default_config(self):
        """Test default configuration values"""
        config = PrivacyConfig()
        
        self.assertTrue(config.enabled)
        self.assertEqual(config.min_confidence, 0.7)
        self.assertTrue(config.detect_pii)  # Enabled by default for PII protection
        self.assertFalse(config.detect_secrets)  # Disabled by default (too aggressive)
        self.assertTrue(config.detect_custom_patterns)  # Passwords/API keys always enabled
        self.assertEqual(config.redaction_strategy.value, 'mask')
    
    def test_config_from_env(self):
        """Test loading config from environment variables"""
        # Set test environment variables
        os.environ['PRIVACY_FILTER_ENABLED'] = 'false'
        os.environ['PRIVACY_MIN_CONFIDENCE'] = '0.9'
        os.environ['PRIVACY_REDACTION_STRATEGY'] = 'entity_type'
        
        try:
            config = PrivacyConfig.from_env()
            
            self.assertFalse(config.enabled)
            self.assertEqual(config.min_confidence, 0.9)
            self.assertEqual(config.redaction_strategy.value, 'entity_type')
        finally:
            # Clean up
            del os.environ['PRIVACY_FILTER_ENABLED']
            del os.environ['PRIVACY_MIN_CONFIDENCE']
            del os.environ['PRIVACY_REDACTION_STRATEGY']
    
    def test_config_validation(self):
        """Test configuration validation"""
        config = PrivacyConfig()
        config.min_confidence = 1.5  # Invalid
        
        issues = config.validate()
        self.assertTrue(len(issues) > 0)
        self.assertTrue(any('min_confidence' in issue for issue in issues))


class TestCustomPatternDetector(unittest.TestCase):
    """Test CustomPatternDetector class"""
    
    def setUp(self):
        """Set up detector for tests"""
        self.detector = CustomPatternDetector()
    
    def test_detect_password_in_url(self):
        """Test detecting password in URL"""
        text = "Connect to https://admin:TestPass000@database.example.com/db"
        detections = self.detector.detect(text)
        
        self.assertTrue(len(detections) > 0)
        password_detections = [d for d in detections if d.entity_type == 'PASSWORD']
        self.assertTrue(len(password_detections) > 0)
        self.assertIn('TestPass000', [d.text for d in password_detections])
    
    def test_detect_password_key_value(self):
        """Test detecting password in key=value format"""
        text = 'DB_PASSWORD=TestPass000!'
        detections = self.detector.detect(text)
        
        password_detections = [d for d in detections if d.entity_type == 'PASSWORD']
        self.assertTrue(len(password_detections) > 0)
    
    def test_detect_aws_key(self):
        """Test detecting AWS access key"""
        text = 'AWS_ACCESS_KEY_ID=AKIATESTTESTTESTTEST'
        detections = self.detector.detect(text)
        
        api_key_detections = [d for d in detections if d.entity_type == 'API_KEY']
        self.assertTrue(len(api_key_detections) > 0)
    
    def test_detect_github_token(self):
        """Test detecting GitHub token"""
        # ghp_ tokens must be exactly 36 chars after prefix
        text = 'GITHUB_TOKEN=ghp_000000000000000000000000000000000000'
        detections = self.detector.detect(text)
        
        api_key_detections = [d for d in detections if d.entity_type == 'API_KEY']
        self.assertTrue(len(api_key_detections) > 0)
    
    def test_detect_jwt_token(self):
        """Test detecting JWT token"""
        text = 'Authorization: Bearer eyJhbGciOiJ0ZXN0In0.eyJ0ZXN0IjoidGVzdCJ9.dGVzdHNpZ25hdHVyZQ'
        detections = self.detector.detect(text)
        
        token_detections = [d for d in detections if d.entity_type == 'BEARER_TOKEN']
        self.assertTrue(len(token_detections) > 0)
    
    def test_detect_private_key(self):
        """Test detecting private key"""
        text = '''-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF...
-----END RSA PRIVATE KEY-----'''
        detections = self.detector.detect(text)
        
        key_detections = [d for d in detections if d.entity_type == 'PRIVATE_KEY']
        self.assertTrue(len(key_detections) > 0)
    
    def test_no_false_positives_on_normal_text(self):
        """Test that normal text doesn't trigger false positives"""
        text = "This is a normal sentence with no sensitive data."
        detections = self.detector.detect(text)
        
        self.assertEqual(len(detections), 0)
    
    def test_empty_text(self):
        """Test handling empty text"""
        detections = self.detector.detect("")
        self.assertEqual(len(detections), 0)
        
        detections = self.detector.detect(None)
        self.assertEqual(len(detections), 0)


class TestDetection(unittest.TestCase):
    """Test Detection class"""
    
    def test_detection_overlap(self):
        """Test detection overlap checking"""
        d1 = Detection('TYPE1', 0, 10, 0.8, 'text1', 'detector1')
        d2 = Detection('TYPE2', 5, 15, 0.9, 'text2', 'detector2')
        d3 = Detection('TYPE3', 20, 30, 0.7, 'text3', 'detector3')
        
        self.assertTrue(d1.overlaps(d2))
        self.assertTrue(d2.overlaps(d1))
        self.assertFalse(d1.overlaps(d3))
    
    def test_detection_to_dict(self):
        """Test detection serialization"""
        d = Detection('PASSWORD', 10, 20, 0.85, 'secret', 'custom')
        result = d.to_dict()
        
        self.assertEqual(result['entity_type'], 'PASSWORD')
        self.assertEqual(result['start'], 10)
        self.assertEqual(result['end'], 20)
        self.assertEqual(result['confidence'], 0.85)
        self.assertNotIn('text', result)  # Should not include actual text


class TestPrivacyFilter(unittest.TestCase):
    """Test PrivacyFilter class"""
    
    def setUp(self):
        """Set up filter for tests"""
        config = PrivacyConfig()
        config.detect_pii = False  # Disable to avoid needing presidio
        config.detect_secrets = False  # Disable to avoid needing detect-secrets
        config.detect_custom_patterns = True
        self.filter = PrivacyFilter(config)
    
    def test_redact_password(self):
        """Test redacting password from text"""
        text = 'Database password=TestPass000!'
        result = self.filter.redact(text)
        
        self.assertNotIn('TestPass000', result['text'])
        self.assertIn('********', result['text'])
        self.assertTrue(result['redactions_count'] > 0)
    
    def test_redact_api_key(self):
        """Test redacting API key from text"""
        text = 'api_key=FAKE_TEST_KEY_00000000'
        result = self.filter.redact(text)
        
        self.assertNotIn('FAKE_TEST_KEY_00000000', result['text'])
        self.assertTrue(result['redactions_count'] > 0)
    
    def test_filter_disabled(self):
        """Test that disabled filter returns original text"""
        config = PrivacyConfig()
        config.enabled = False
        filter_disabled = PrivacyFilter(config)
        
        text = 'password=secret123'
        result = filter_disabled.redact(text)
        
        self.assertEqual(result['text'], text)
        self.assertEqual(result['redactions_count'], 0)
    
    def test_short_text_skipped(self):
        """Test that short text is skipped"""
        config = PrivacyConfig()
        config.skip_short_text = 100  # Set high threshold
        config.detect_pii = False
        config.detect_secrets = False
        filter_skip = PrivacyFilter(config)
        
        text = 'password=secret'  # Below threshold
        result = filter_skip.redact(text)
        
        self.assertEqual(result['text'], text)
    
    def test_processing_time_included(self):
        """Test that processing time is included in result"""
        result = self.filter.redact('some text with password=test123')
        
        self.assertIn('processing_time_ms', result)
        self.assertIsInstance(result['processing_time_ms'], float)
    
    def test_confidence_filtering(self):
        """Test that low-confidence detections are filtered"""
        config = PrivacyConfig()
        config.min_confidence = 0.99  # Very high threshold
        config.detect_pii = False
        config.detect_secrets = False
        filter_strict = PrivacyFilter(config)
        
        # This should have moderate confidence, below 0.99
        text = 'password=short'
        result = filter_strict.redact(text)
        
        # Should be filtered due to confidence
        self.assertIn('filtered_by_confidence', result)


class TestIntegration(unittest.TestCase):
    """Integration tests for the privacy module"""
    
    def test_ocr_like_text(self):
        """Test filtering OCR-like text with mixed content"""
        config = PrivacyConfig()
        config.detect_pii = False
        config.detect_secrets = False
        filter = PrivacyFilter(config)
        
        ocr_text = """
        JIRAForge Settings Panel
        
        Database Configuration:
        Host: db.example.com
        Port: 5432
        Username: admin
        Password: TestPass000!
        
        API Settings:
        API_KEY=FAKE_TEST_KEY_00000000
        
        Status: Connected
        """
        
        result = filter.redact(ocr_text)
        
        # Sensitive data should be redacted
        self.assertNotIn('TestPass000', result['text'])
        self.assertNotIn('FAKE_TEST_KEY_00000000', result['text'])
        
        # Non-sensitive data should remain
        self.assertIn('JIRAForge', result['text'])
        self.assertIn('db.example.com', result['text'])
        self.assertIn('Status: Connected', result['text'])
    
    def test_multiple_secrets_in_text(self):
        """Test handling multiple secrets in same text"""
        config = PrivacyConfig()
        config.detect_pii = False
        config.detect_secrets = False
        filter = PrivacyFilter(config)
        
        text = """
        password=testpass000
        api_key=AKIATESTTESTTESTTEST
        token=ghp_000000000000000000000000000000000000
        """
        
        result = filter.redact(text)
        
        self.assertTrue(result['redactions_count'] >= 2)


if __name__ == '__main__':
    unittest.main()
