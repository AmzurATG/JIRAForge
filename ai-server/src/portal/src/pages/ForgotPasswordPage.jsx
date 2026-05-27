/**
 * Forgot Password Page
 * 
 * Request password reset link via email.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Mail } from 'lucide-react';
import apiClient from '../api/client';
import ErrorBanner from '../components/common/ErrorBanner';

function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    setSuccess(false);

    try {
      await apiClient.post('/api/portal/auth/forgot-password', { email });
      setSuccess(true);
      setEmail('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send reset link');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
      <div className="max-w-md w-full mx-4">
        <div className="card">
          <div className="mb-6">
            <Link
              to="/login"
              className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Login
            </Link>
          </div>

          <h1 className="text-2xl font-bold text-center mb-2">
            Forgot Password?
          </h1>
          <p className="text-center text-gray-600 dark:text-gray-400 mb-6">
            Enter your email address and we'll send you a link to reset your password.
          </p>
          
          <ErrorBanner message={error} onDismiss={() => setError('')} />
          
          {success && (
            <div className="mb-6 p-4 bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 rounded-lg flex items-start gap-3">
              <Mail className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold mb-1">Check your email</p>
                <p className="text-sm">
                  If an account exists with that email, we've sent password reset instructions.
                  Please check your inbox and spam folder.
                </p>
              </div>
            </div>
          )}
          
          {!success && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Email Address</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="input-field"
                  placeholder="your.email@example.com"
                  required
                />
              </div>
              
              <button
                type="submit"
                disabled={loading}
                className="w-full btn-primary disabled:opacity-50"
              >
                {loading ? 'Sending...' : 'Send Reset Link'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export default ForgotPasswordPage;
