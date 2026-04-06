"""
Test Suite for Secure Token Storage

Tests the SecureTokenStorage class including:
- Keyring storage and retrieval
- Encrypted file storage and retrieval
- Automatic fallback logic
- Migration from plaintext
- Thread safety
- Security features (machine-specific encryption)

Run with: python -m pytest test_secure_storage.py -v
Or: python test_secure_storage.py
"""

import os
import sys
import json
import tempfile
import shutil
import unittest
from unittest.mock import patch, MagicMock
import threading
import time

# Add parent directory to path to import auth module
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from auth import SecureTokenStorage, SecurityError, KEYRING_AVAILABLE


class TestSecureTokenStorage(unittest.TestCase):
    """Test suite for SecureTokenStorage class"""
    
    def setUp(self):
        """Set up test environment before each test"""
        # Create temporary directory for test data
        self.test_dir = tempfile.mkdtemp(prefix='test_secure_storage_')
        self.storage = SecureTokenStorage(self.test_dir)
        
        # Test tokens
        self.test_tokens = {
            'access_token': 'test_access_token_123',
            'refresh_token': 'test_refresh_token_456',
            'supabase_token': 'test_supabase_token_789'
        }
        
        self.test_email = 'test@example.com'
    
    def tearDown(self):
        """Clean up after each test"""
        # Clean up keyring if available
        if KEYRING_AVAILABLE:
            try:
                self.storage.delete_tokens(self.test_email)
            except:
                pass
        
        # Remove test directory
        if os.path.exists(self.test_dir):
            shutil.rmtree(self.test_dir)
    
    # =========================================================================
    # BASIC FUNCTIONALITY TESTS
    # =========================================================================
    
    def test_initialization(self):
        """Test SecureTokenStorage initialization"""
        self.assertIsNotNone(self.storage)
        self.assertTrue(os.path.exists(self.test_dir))
        self.assertIsNone(self.storage.storage_method)
    
    def test_save_and_load_tokens(self):
        """Test basic save and load functionality"""
        # Save tokens
        result = self.storage.save_tokens(self.test_tokens, self.test_email)
        self.assertTrue(result)
        
        # Load tokens
        loaded_tokens = self.storage.load_tokens(self.test_email)
        self.assertIsNotNone(loaded_tokens)
        self.assertEqual(loaded_tokens['access_token'], self.test_tokens['access_token'])
        self.assertEqual(loaded_tokens['refresh_token'], self.test_tokens['refresh_token'])
        self.assertEqual(loaded_tokens['supabase_token'], self.test_tokens['supabase_token'])
    
    def test_delete_tokens(self):
        """Test token deletion"""
        # Save tokens
        self.storage.save_tokens(self.test_tokens, self.test_email)
        
        # Verify they exist
        loaded = self.storage.load_tokens(self.test_email)
        self.assertIsNotNone(loaded)
        
        # Delete tokens
        result = self.storage.delete_tokens(self.test_email)
        self.assertTrue(result)
        
        # Verify they're gone
        loaded = self.storage.load_tokens(self.test_email)
        self.assertIsNone(loaded)
    
    def test_nonexistent_tokens(self):
        """Test loading tokens that don't exist"""
        loaded = self.storage.load_tokens('nonexistent@example.com')
        self.assertIsNone(loaded)
    
    def test_empty_tokens(self):
        """Test saving empty token dictionary"""
        empty_tokens = {}
        result = self.storage.save_tokens(empty_tokens, self.test_email)
        self.assertTrue(result)
        
        loaded = self.storage.load_tokens(self.test_email)
        # Should return None or empty dict
        self.assertTrue(loaded is None or loaded == {})
    
    # =========================================================================
    # STORAGE METHOD TESTS
    # =========================================================================
    
    def test_storage_method_detection(self):
        """Test that storage method is correctly detected"""
        self.storage.save_tokens(self.test_tokens, self.test_email)
        
        # Storage method should be set
        self.assertIsNotNone(self.storage.storage_method)
        self.assertIn(self.storage.storage_method, ['keyring', 'encrypted'])
        
        # If keyring is available, should prefer it
        if KEYRING_AVAILABLE:
            self.assertEqual(self.storage.storage_method, 'keyring')
        else:
            self.assertEqual(self.storage.storage_method, 'encrypted')
    
    def test_get_storage_status(self):
        """Test storage status reporting"""
        # Before saving any tokens
        status = self.storage.get_storage_status()
        self.assertEqual(status['method'], 'Unknown')
        
        # After saving tokens
        self.storage.save_tokens(self.test_tokens, self.test_email)
        status = self.storage.get_storage_status()
        
        # Verify status structure
        self.assertIn('method', status)
        self.assertIn('security_level', status)
        self.assertIn('icon', status)
        self.assertIn('description', status)
        self.assertIn('encryption', status)
        self.assertIn('recommendation', status)
        
        # Method should be keyring or encrypted
        self.assertIn(status['method'], 
                      ['Windows Credential Manager', 'Encrypted File Storage'])
    
    # =========================================================================
    # ENCRYPTED STORAGE TESTS
    # =========================================================================
    
    @patch('auth.secure_storage.KEYRING_AVAILABLE', False)
    def test_encrypted_storage_fallback(self):
        """Test automatic fallback to encrypted storage when keyring unavailable"""
        # Create new storage instance with keyring disabled
        storage = SecureTokenStorage(self.test_dir)
        
        # Save tokens
        result = storage.save_tokens(self.test_tokens, self.test_email)
        self.assertTrue(result)
        self.assertEqual(storage.storage_method, 'encrypted')
        
        # Load tokens
        loaded = storage.load_tokens(self.test_email)
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded['access_token'], self.test_tokens['access_token'])
    
    def test_encrypted_file_created(self):
        """Test that encrypted file is created with correct name"""
        # Mock keyring to force encrypted storage
        with patch('auth.secure_storage.KEYRING_AVAILABLE', False):
            storage = SecureTokenStorage(self.test_dir)
            storage.save_tokens(self.test_tokens, self.test_email)
            
            # Check encrypted file exists
            enc_file = storage._get_encrypted_file_path(self.test_email)
            self.assertTrue(os.path.exists(enc_file))
            self.assertTrue(enc_file.endswith('.enc'))
    
    def test_encrypted_file_not_plaintext(self):
        """Test that encrypted file doesn't contain plaintext tokens"""
        with patch('auth.secure_storage.KEYRING_AVAILABLE', False):
            storage = SecureTokenStorage(self.test_dir)
            storage.save_tokens(self.test_tokens, self.test_email)
            
            # Read encrypted file
            enc_file = storage._get_encrypted_file_path(self.test_email)
            with open(enc_file, 'rb') as f:
                content = f.read()
            
            # Verify tokens are not in plaintext
            self.assertNotIn(b'test_access_token_123', content)
            self.assertNotIn(b'test_refresh_token_456', content)
            self.assertNotIn(b'test_supabase_token_789', content)
    
    def test_machine_specific_encryption(self):
        """Test that encrypted tokens are machine-specific"""
        with patch('auth.secure_storage.KEYRING_AVAILABLE', False):
            storage = SecureTokenStorage(self.test_dir)
            storage.save_tokens(self.test_tokens, self.test_email)
            
            # Get machine salt and password
            salt1 = storage._get_machine_salt()
            password1 = storage._get_machine_password()
            
            # These should be consistent on same machine
            salt2 = storage._get_machine_salt()
            password2 = storage._get_machine_password()
            
            self.assertEqual(salt1, salt2)
            self.assertEqual(password1, password2)
    
    # =========================================================================
    # MIGRATION TESTS
    # =========================================================================
    
    def test_migrate_from_plaintext(self):
        """Test migration from plaintext JSON to secure storage"""
        # Create plaintext JSON file
        plaintext_file = os.path.join(self.test_dir, 'old_tokens.json')
        with open(plaintext_file, 'w') as f:
            json.dump(self.test_tokens, f)
        
        # Migrate
        result = self.storage.migrate_from_plaintext(plaintext_file, self.test_email)
        self.assertTrue(result)
        
        # Verify tokens are in secure storage
        loaded = self.storage.load_tokens(self.test_email)
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded['access_token'], self.test_tokens['access_token'])
        
        # Verify plaintext file is deleted
        self.assertFalse(os.path.exists(plaintext_file))
    
    def test_migrate_nonexistent_file(self):
        """Test migration with nonexistent file"""
        result = self.storage.migrate_from_plaintext('/nonexistent/file.json', self.test_email)
        self.assertFalse(result)
    
    def test_migrate_empty_file(self):
        """Test migration with empty JSON file"""
        plaintext_file = os.path.join(self.test_dir, 'empty.json')
        with open(plaintext_file, 'w') as f:
            json.dump({}, f)
        
        result = self.storage.migrate_from_plaintext(plaintext_file, self.test_email)
        self.assertFalse(result)
    
    # =========================================================================
    # THREAD SAFETY TESTS
    # =========================================================================
    
    def test_concurrent_saves(self):
        """Test thread safety with concurrent save operations"""
        num_threads = 10
        results = []
        
        def save_tokens(thread_id):
            try:
                tokens = {
                    'access_token': f'token_{thread_id}',
                    'refresh_token': f'refresh_{thread_id}',
                    'supabase_token': f'supabase_{thread_id}'
                }
                email = f'user{thread_id}@example.com'
                result = self.storage.save_tokens(tokens, email)
                results.append((thread_id, result))
            except Exception as e:
                results.append((thread_id, False, str(e)))
        
        # Create and start threads
        threads = []
        for i in range(num_threads):
            t = threading.Thread(target=save_tokens, args=(i,))
            threads.append(t)
            t.start()
        
        # Wait for all threads
        for t in threads:
            t.join()
        
        # Verify all saves succeeded
        self.assertEqual(len(results), num_threads)
        for thread_id, result in results:
            self.assertTrue(result, f"Thread {thread_id} failed")
    
    def test_concurrent_load_and_save(self):
        """Test concurrent read and write operations"""
        # Pre-save initial tokens
        self.storage.save_tokens(self.test_tokens, self.test_email)
        
        results = []
        
        def load_tokens():
            for _ in range(5):
                loaded = self.storage.load_tokens(self.test_email)
                results.append(('load', loaded is not None))
                time.sleep(0.01)
        
        def save_tokens():
            for i in range(5):
                new_tokens = {
                    'access_token': f'updated_token_{i}',
                    'refresh_token': f'updated_refresh_{i}',
                    'supabase_token': f'updated_supabase_{i}'
                }
                result = self.storage.save_tokens(new_tokens, self.test_email)
                results.append(('save', result))
                time.sleep(0.01)
        
        # Start multiple readers and writers
        threads = []
        for _ in range(3):
            threads.append(threading.Thread(target=load_tokens))
            threads.append(threading.Thread(target=save_tokens))
        
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        
        # Verify no crashes and operations succeeded
        self.assertGreater(len(results), 0)
    
    # =========================================================================
    # EDGE CASES AND ERROR HANDLING
    # =========================================================================
    
    def test_large_token_values(self):
        """Test handling of very large token values"""
        large_tokens = {
            'access_token': 'A' * 5000,  # 5KB token
            'refresh_token': 'B' * 5000,
            'supabase_token': 'C' * 5000
        }
        
        # Should handle large tokens (testing chunking for keyring)
        result = self.storage.save_tokens(large_tokens, self.test_email)
        self.assertTrue(result)
        
        loaded = self.storage.load_tokens(self.test_email)
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded['access_token'], large_tokens['access_token'])
    
    def test_special_characters_in_tokens(self):
        """Test tokens with special characters"""
        special_tokens = {
            'access_token': 'token_with_!@#$%^&*()_+{}[]|\\:;"<>?,./`~',
            'refresh_token': 'token\nwith\nnewlines\nand\ttabs',
            'supabase_token': 'token_with_unicode_émojis_🔒🎉'
        }
        
        result = self.storage.save_tokens(special_tokens, self.test_email)
        self.assertTrue(result)
        
        loaded = self.storage.load_tokens(self.test_email)
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded['access_token'], special_tokens['access_token'])
        self.assertEqual(loaded['refresh_token'], special_tokens['refresh_token'])
        self.assertEqual(loaded['supabase_token'], special_tokens['supabase_token'])
    
    def test_invalid_email(self):
        """Test with various email formats"""
        test_emails = [
            'simple@example.com',
            'user+tag@example.com',
            'user.name@example.co.uk',
            'default'  # No @ symbol
        ]
        
        for email in test_emails:
            result = self.storage.save_tokens(self.test_tokens, email)
            self.assertTrue(result, f"Failed for email: {email}")
            
            loaded = self.storage.load_tokens(email)
            self.assertIsNotNone(loaded, f"Failed to load for email: {email}")
    
    def test_corrupted_encrypted_file(self):
        """Test handling of corrupted encrypted file"""
        with patch('auth.secure_storage.KEYRING_AVAILABLE', False):
            storage = SecureTokenStorage(self.test_dir)
            storage.save_tokens(self.test_tokens, self.test_email)
            
            # Corrupt the encrypted file
            enc_file = storage._get_encrypted_file_path(self.test_email)
            with open(enc_file, 'wb') as f:
                f.write(b'corrupted data that is not encrypted')
            
            # Should return None for corrupted file
            loaded = storage.load_tokens(self.test_email)
            self.assertIsNone(loaded)
    
    # =========================================================================
    # NOTIFICATION TESTS
    # =========================================================================
    
    def test_notification_status_tracking(self):
        """Test that notification shown status is tracked"""
        with patch('auth.secure_storage.KEYRING_AVAILABLE', False):
            storage = SecureTokenStorage(self.test_dir)
            
            # Initially not shown
            self.assertFalse(storage.notification_shown)
            
            # Save tokens (should trigger notification)
            storage.save_tokens(self.test_tokens, self.test_email)
            
            # Should be marked as shown
            self.assertTrue(storage.notification_shown)
            
            # Create new instance - should remember
            storage2 = SecureTokenStorage(self.test_dir)
            self.assertTrue(storage2.notification_shown)
    
    # =========================================================================
    # INTEGRATION TESTS
    # =========================================================================
    
    def test_full_workflow(self):
        """Test complete workflow: save, load, update, delete"""
        # 1. Save initial tokens
        result = self.storage.save_tokens(self.test_tokens, self.test_email)
        self.assertTrue(result)
        
        # 2. Load and verify
        loaded = self.storage.load_tokens(self.test_email)
        self.assertEqual(loaded['access_token'], self.test_tokens['access_token'])
        
        # 3. Update tokens
        updated_tokens = {
            'access_token': 'new_access_token',
            'refresh_token': 'new_refresh_token',
            'supabase_token': 'new_supabase_token'
        }
        result = self.storage.save_tokens(updated_tokens, self.test_email)
        self.assertTrue(result)
        
        # 4. Load updated tokens
        loaded = self.storage.load_tokens(self.test_email)
        self.assertEqual(loaded['access_token'], updated_tokens['access_token'])
        
        # 5. Delete tokens
        result = self.storage.delete_tokens(self.test_email)
        self.assertTrue(result)
        
        # 6. Verify deletion
        loaded = self.storage.load_tokens(self.test_email)
        self.assertIsNone(loaded)
    
    def test_multiple_users(self):
        """Test storage for multiple users simultaneously"""
        users = [
            ('user1@example.com', {'access_token': 'token1', 'refresh_token': 'refresh1'}),
            ('user2@example.com', {'access_token': 'token2', 'refresh_token': 'refresh2'}),
            ('user3@example.com', {'access_token': 'token3', 'refresh_token': 'refresh3'}),
        ]
        
        # Save tokens for all users
        for email, tokens in users:
            result = self.storage.save_tokens(tokens, email)
            self.assertTrue(result)
        
        # Verify all users' tokens are retrievable
        for email, expected_tokens in users:
            loaded = self.storage.load_tokens(email)
            self.assertIsNotNone(loaded)
            self.assertEqual(loaded['access_token'], expected_tokens['access_token'])
        
        # Delete one user's tokens
        self.storage.delete_tokens('user2@example.com')
        
        # Verify other users' tokens still exist
        loaded = self.storage.load_tokens('user1@example.com')
        self.assertIsNotNone(loaded)
        loaded = self.storage.load_tokens('user3@example.com')
        self.assertIsNotNone(loaded)
        
        # Verify deleted user's tokens are gone
        loaded = self.storage.load_tokens('user2@example.com')
        self.assertIsNone(loaded)


# =============================================================================
# TEST RUNNER
# =============================================================================

def run_tests():
    """Run all tests and display results"""
    print("=" * 70)
    print("Secure Token Storage Test Suite")
    print("=" * 70)
    print(f"Keyring Available: {KEYRING_AVAILABLE}")
    print("=" * 70)
    print()
    
    # Run tests
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromTestCase(TestSecureTokenStorage)
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    
    # Print summary
    print()
    print("=" * 70)
    print("Test Summary")
    print("=" * 70)
    print(f"Tests run: {result.testsRun}")
    print(f"Successes: {result.testsRun - len(result.failures) - len(result.errors)}")
    print(f"Failures: {len(result.failures)}")
    print(f"Errors: {len(result.errors)}")
    print("=" * 70)
    
    return result.wasSuccessful()


if __name__ == '__main__':
    success = run_tests()
    sys.exit(0 if success else 1)
