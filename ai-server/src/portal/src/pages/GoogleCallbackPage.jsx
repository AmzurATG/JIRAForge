/**
 * Google OAuth Callback Page
 * 
 * Handles the redirect from Google OAuth and exchanges the code for a JWT token.
 */

import { useEffect, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import apiClient from '../api/client';
import LoadingSpinner from '../components/common/LoadingSpinner';

function GoogleCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { loginWithToken } = useAuth();
  const [error, setError] = useState('');
  const [processing, setProcessing] = useState(true);
  const hasProcessed = useRef(false); // Prevent double execution in React Strict Mode

  useEffect(() => {
    const handleCallback = async () => {
      if (hasProcessed.current) return; // Prevent double execution in React Strict Mode
      hasProcessed.current = true;

      const code = searchParams.get('code');
      const errorParam = searchParams.get('error');

      if (errorParam) {
        setError('Google authentication was cancelled or failed');
        setProcessing(false);
        setTimeout(() => navigate('/login'), 3000);
        return;
      }

      if (!code) {
        setError('No authorization code received');
        setProcessing(false);
        setTimeout(() => navigate('/login'), 3000);
        return;
      }

      try {
        // Exchange code for JWT token
        const response = await apiClient.post('/api/portal/auth/google/callback', { code });

        if (response.data.success) {
          const { token, user } = response.data;
          
          // Store token and user info via AuthContext
          loginWithToken(token, user);

          // Redirect to dashboard
          navigate('/dashboard');
        } else {
          setError(response.data.error || 'Authentication failed');
          setProcessing(false);
          setTimeout(() => navigate('/login'), 3000);
        }
      } catch (err) {
        console.error('Google OAuth callback error:', err);
        setError(err.response?.data?.error || 'Authentication failed. Please try again.');
        setProcessing(false);
        setTimeout(() => navigate('/login'), 3000);
      }
    };

    handleCallback();
  }, [searchParams, navigate, loginWithToken]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
      <div className="max-w-md w-full mx-4">
        <div className="card text-center">
          {processing ? (
            <>
              <div className="mb-4">
                <LoadingSpinner size="lg" />
              </div>
              <h2 className="text-xl font-semibold mb-2">Completing sign in...</h2>
              <p className="text-gray-500 dark:text-gray-400">Please wait while we authenticate you with Google</p>
            </>
          ) : (
            <>
              <div className="w-16 h-16 mx-auto mb-4 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center">
                <svg className="w-8 h-8 text-red-600 dark:text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold mb-2 text-red-600 dark:text-red-400">Authentication Failed</h2>
              <p className="text-gray-600 dark:text-gray-300 mb-4">{error}</p>
              <p className="text-sm text-gray-500 dark:text-gray-400">Redirecting to login page...</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default GoogleCallbackPage;
