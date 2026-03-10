"""
Unit Tests for Secure Logger

Tests PII detection and redaction patterns in the Python desktop app.
"""

import os
import sys
import unittest

# Set test environment variables before imports
os.environ['SECURE_LOG_ENABLED'] = 'true'
os.environ['SECURE_LOG_LEVEL'] = 'standard'

from secure_logger import (
    sanitize_value,
    sanitize_dict,
    secure_log,
    SecureLogger,
    get_redaction_stats,
    reset_redaction_stats,
    SANITIZATION_PATTERNS
)


class TestSanitizeValue(unittest.TestCase):
    """Test sanitize_value function"""
    
    def setUp(self):
        reset_redaction_stats()
    
    def test_redact_email(self):
        """Should redact email addresses"""
        result = sanitize_value('Sent to user@example.com', 'standard')
        self.assertEqual(result, 'Sent to [EMAIL]')
    
    def test_redact_multiple_emails(self):
        """Should redact multiple email addresses"""
        result = sanitize_value('From: admin@company.com To: user@example.org', 'standard')
        self.assertEqual(result, 'From: [EMAIL] To: [EMAIL]')
    
    def test_redact_uuid(self):
        """Should redact UUIDs at standard level"""
        result = sanitize_value('User ID: fa23333e-9e8f-4b13-bda9-833ca4f7c3cc', 'standard')
        self.assertEqual(result, 'User ID: [UUID]')
    
    def test_no_redact_uuid_minimal(self):
        """Should NOT redact UUIDs at minimal level"""
        result = sanitize_value('User ID: fa23333e-9e8f-4b13-bda9-833ca4f7c3cc', 'minimal')
        self.assertEqual(result, 'User ID: fa23333e-9e8f-4b13-bda9-833ca4f7c3cc')
    
    def test_redact_atlassian_account(self):
        """Should redact Atlassian account IDs"""
        result = sanitize_value('Account: 712020:2e67c2ea-92ca-451d-9686-bb830a8da0af', 'standard')
        self.assertEqual(result, 'Account: [ATLASSIAN_ACCOUNT]')
    
    def test_redact_jwt(self):
        """Should redact JWT tokens"""
        jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
        result = sanitize_value(f'Token: {jwt}', 'minimal')
        self.assertEqual(result, 'Token: [JWT]')
    
    def test_redact_ip_address(self):
        """Should redact IP addresses at standard level"""
        result = sanitize_value('Request from 192.168.1.100', 'standard')
        self.assertEqual(result, 'Request from [IP]')
    
    def test_no_redact_ip_minimal(self):
        """Should NOT redact IP addresses at minimal level"""
        result = sanitize_value('Request from 192.168.1.100', 'minimal')
        self.assertEqual(result, 'Request from 192.168.1.100')
    
    def test_redact_phone(self):
        """Should redact phone numbers"""
        result = sanitize_value('Contact: 123-456-7890', 'minimal')
        self.assertEqual(result, 'Contact: [PHONE]')
    
    def test_no_redact_non_sensitive(self):
        """Should NOT redact non-sensitive text"""
        result = sanitize_value('Hello world! Status: active', 'standard')
        self.assertEqual(result, 'Hello world! Status: active')
    
    def test_preserve_numbers(self):
        """Should preserve regular numbers"""
        result = sanitize_value('Count: 12345', 'standard')
        self.assertEqual(result, 'Count: 12345')


class TestSanitizeDict(unittest.TestCase):
    """Test sanitize_dict function"""
    
    def setUp(self):
        reset_redaction_stats()
    
    def test_sanitize_simple_dict(self):
        """Should sanitize all values in a dictionary"""
        input_dict = {
            'user_id': 'fa23333e-9e8f-4b13-bda9-833ca4f7c3cc',
            'email': 'test@example.com',
            'status': 'active'
        }
        result = sanitize_dict(input_dict, 'standard')
        self.assertEqual(result['user_id'], '[UUID]')
        self.assertEqual(result['email'], '[EMAIL]')
        self.assertEqual(result['status'], 'active')
    
    def test_sanitize_nested_dict(self):
        """Should sanitize nested dictionaries"""
        input_dict = {
            'user': {
                'id': 'fa23333e-9e8f-4b13-bda9-833ca4f7c3cc',
                'profile': {
                    'email': 'nested@example.com'
                }
            }
        }
        result = sanitize_dict(input_dict, 'standard')
        self.assertEqual(result['user']['id'], '[UUID]')
        self.assertEqual(result['user']['profile']['email'], '[EMAIL]')
    
    def test_sanitize_list_in_dict(self):
        """Should sanitize lists in dictionaries"""
        input_dict = {
            'emails': ['one@test.com', 'two@test.com']
        }
        result = sanitize_dict(input_dict, 'standard')
        self.assertEqual(result['emails'], ['[EMAIL]', '[EMAIL]'])


class TestSecureLogger(unittest.TestCase):
    """Test SecureLogger class"""
    
    def setUp(self):
        reset_redaction_stats()
        self.logger = SecureLogger(level='standard', timestamps=False)
    
    def test_logger_initialization(self):
        """Should initialize with correct level"""
        self.assertEqual(self.logger.level, 'standard')
    
    def test_logger_methods_exist(self):
        """Should have all standard log methods"""
        self.assertTrue(hasattr(self.logger, 'debug'))
        self.assertTrue(hasattr(self.logger, 'info'))
        self.assertTrue(hasattr(self.logger, 'warn'))
        self.assertTrue(hasattr(self.logger, 'warning'))
        self.assertTrue(hasattr(self.logger, 'error'))


class TestRedactionStats(unittest.TestCase):
    """Test redaction statistics tracking"""
    
    def setUp(self):
        reset_redaction_stats()
    
    def test_stats_track_redactions(self):
        """Should track redaction counts"""
        sanitize_value('test@example.com', 'standard')
        sanitize_value('another@test.com', 'standard')
        
        stats = get_redaction_stats()
        self.assertEqual(stats.get('EMAIL', 0), 2)
    
    def test_stats_reset(self):
        """Should reset stats correctly"""
        sanitize_value('test@example.com', 'standard')
        reset_redaction_stats()
        
        stats = get_redaction_stats()
        self.assertEqual(stats.get('EMAIL', 0), 0)


class TestPatternCoverage(unittest.TestCase):
    """Test that all expected patterns are defined"""
    
    def test_required_patterns_exist(self):
        """Should have all required pattern types"""
        pattern_types = [p['type'] for p in SANITIZATION_PATTERNS]
        
        required_types = ['EMAIL', 'UUID', 'ATLASSIAN_ACCOUNT', 'JWT', 'IP_ADDRESS', 'PHONE']
        for required in required_types:
            self.assertIn(required, pattern_types, f"Missing pattern type: {required}")


if __name__ == '__main__':
    unittest.main()
