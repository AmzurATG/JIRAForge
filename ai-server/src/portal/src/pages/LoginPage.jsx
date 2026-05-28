import { useState } from 'react';
import ErrorBanner from '../components/common/ErrorBanner';
import apiClient from '../api/client';

const features = [
  {
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    title: 'Automatic Time Capture',
    desc: 'Screenshots and activity are captured seamlessly in the background.',
  },
  {
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
      </svg>
    ),
    title: 'AI-Powered Matching',
    desc: 'Work is intelligently matched to Jira issues using AI analysis.',
  },
  {
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
    title: 'Analytics & Reports',
    desc: 'Rich dashboards give full visibility into team productivity.',
  },
];

function LoginPage() {
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState('');

  const handleGoogleLogin = async () => {
    setError('');
    setGoogleLoading(true);

    try {
      const response = await apiClient.get('/api/portal/auth/google/url');
      if (response.data.success && response.data.url) {
        window.location.href = response.data.url;
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to initiate Google login');
      setGoogleLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex">
      {/* ── Left branding panel ── */}
      <div className="hidden lg:flex lg:w-1/2 relative overflow-hidden bg-gradient-to-br from-primary-700 via-primary-600 to-primary-800 flex-col justify-between p-12">
        {/* Decorative blobs */}
        <div className="absolute -top-24 -left-24 w-96 h-96 bg-white/5 rounded-full blur-3xl" />
        <div className="absolute -bottom-32 -right-16 w-80 h-80 bg-white/10 rounded-full blur-3xl" />
        <div className="absolute top-1/2 left-1/3 w-48 h-48 bg-primary-400/20 rounded-full blur-2xl" />

        {/* Logo */}
        <div className="relative z-10 flex items-center gap-3">
          <div className="w-10 h-10 bg-white/15 backdrop-blur-sm rounded-xl flex items-center justify-center border border-white/20 shadow-lg">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <div>
            <p className="text-white font-bold text-lg leading-tight">Time Tracking</p>
            <p className="text-primary-200 text-xs">Portal by Amzur</p>
          </div>
        </div>

        {/* Hero text */}
        <div className="relative z-10 space-y-6">
          <div>
            <h2 className="text-4xl font-extrabold text-white leading-tight">
              Track work.<br />
              <span className="text-primary-200">Sync to Jira.</span><br />
              Ship faster.
            </h2>
            <p className="mt-4 text-primary-100 text-base leading-relaxed max-w-sm">
              Automatic time capture powered by AI — no manual timesheets, no guesswork.
            </p>
          </div>

          {/* Feature list */}
          <div className="space-y-4">
            {features.map((f) => (
              <div key={f.title} className="flex items-start gap-3">
                <div className="flex-shrink-0 w-9 h-9 bg-white/10 backdrop-blur-sm rounded-lg flex items-center justify-center text-primary-100 border border-white/10">
                  {f.icon}
                </div>
                <div>
                  <p className="text-white text-sm font-semibold">{f.title}</p>
                  <p className="text-primary-200 text-xs leading-relaxed">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer note */}
        <p className="relative z-10 text-primary-300 text-xs">
          © {new Date().getFullYear()} Amzur Technologies · Secure · Private · GDPR-ready
        </p>
      </div>

      {/* ── Right sign-in panel ── */}
      <div className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-6 py-12">
        <div className="w-full max-w-md animate-fade-in">
          {/* Mobile-only logo */}
          <div className="lg:hidden mb-8">
            <img
              src="/amzur-logo.png"
              alt="Amzur Technologies"
              className="h-9 w-auto dark:brightness-0 dark:invert"
            />
          </div>

          {/* Card */}
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl border border-gray-100 dark:border-gray-700/50 p-8">
            {/* Header */}
            <div className="mb-8 flex justify-center">
              <img
                src="/amzur-logo.png"
                alt="Amzur Technologies"
                className="h-10 w-auto dark:brightness-0 dark:invert"
              />
            </div>

            <ErrorBanner message={error} onDismiss={() => setError('')} />

            {/* Google Sign-In Button */}
            <button
              onClick={handleGoogleLogin}
              disabled={googleLoading}
              className="w-full flex items-center justify-center gap-3 px-5 py-3.5 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-xl
                hover:bg-gray-50 dark:hover:bg-gray-600 hover:border-gray-400 dark:hover:border-gray-500
                hover:shadow-md transition-all duration-200 shadow-sm
                disabled:opacity-50 disabled:cursor-not-allowed group"
            >
              {googleLoading ? (
                <svg className="w-5 h-5 animate-spin text-gray-500" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
              )}
              <span className="font-semibold text-sm text-gray-700 dark:text-gray-200 group-hover:text-gray-900 dark:group-hover:text-white transition-colors">
                {googleLoading ? 'Redirecting to Google…' : 'Sign in with Google'}
              </span>
            </button>

            {/* Security note */}
            <div className="mt-6 flex items-center justify-center gap-1.5 text-xs text-gray-400 dark:text-gray-500">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              <span>Secured by Google OAuth 2.0 · No password stored</span>
            </div>
          </div>

          {/* Below-card note */}
          <p className="mt-6 text-center text-xs text-gray-400 dark:text-gray-600">
            Access is restricted to authorised team members only.
          </p>
        </div>
      </div>
    </div>
  );
}

export default LoginPage;
