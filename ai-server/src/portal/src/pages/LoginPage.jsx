import { useEffect, useState } from 'react';
import { BarChart3, Clock, Sparkles } from 'lucide-react';
import ErrorBanner from '../components/common/ErrorBanner';
import apiClient from '../api/client';
import './LoginPage.css';

const PHRASES = [
  "Your team's day, at a glance.",
  'Productivity, in real time.',
  'Your workday, on autopilot.',
];

const STARS = [
  { top: '18%', left: '22%', size: 3, duration: '4s', delay: '0s' },
  { top: '32%', left: '70%', size: 2, duration: '5.5s', delay: '1s' },
  { top: '68%', left: '16%', size: 2, duration: '6s', delay: '2s' },
  { top: '76%', left: '78%', size: 3, duration: '4.6s', delay: '0.5s' },
  { top: '12%', left: '52%', size: 2, duration: '5s', delay: '1.6s' },
];

const KEYS = [
  { label: 'W', delay: '0s' },
  { label: 'O', delay: '0.18s' },
  { label: 'R', delay: '0.36s' },
  { label: 'K', delay: '0.54s' },
  { label: '⏎', delay: '0.72s', wide: true },
];

const BARS = [
  { duration: '1.9s', delay: '0s' },
  { duration: '2.3s', delay: '0.3s' },
  { duration: '1.7s', delay: '0.6s', variant: 'lv2-bar-cyan' },
  { duration: '2.1s', delay: '0.15s' },
  { duration: '2.5s', delay: '0.45s', variant: 'lv2-bar-violet' },
  { duration: '1.8s', delay: '0.75s' },
];

const CHIPS = [
  { Icon: Clock, label: 'Automatic Time Capture', delay: '0.55s' },
  { Icon: Sparkles, label: 'AI-Powered Matching', delay: '0.67s' },
  { Icon: BarChart3, label: 'Analytics & Reports', delay: '0.79s' },
];

/** Typewriter effect cycling through PHRASES; static text under reduced motion. */
function useTypewriter() {
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setTyped(PHRASES[0]);
      return undefined;
    }
    let p = 0;
    let i = 0;
    let deleting = false;
    let timer;
    const tick = () => {
      const phrase = PHRASES[p];
      if (!deleting) {
        i += 1;
        setTyped(phrase.slice(0, i));
        if (i === phrase.length) {
          deleting = true;
          timer = setTimeout(tick, 2200);
          return;
        }
        timer = setTimeout(tick, 55 + Math.random() * 45);
      } else {
        i -= 1;
        setTyped(phrase.slice(0, i));
        if (i === 0) {
          deleting = false;
          p = (p + 1) % PHRASES.length;
          timer = setTimeout(tick, 500);
          return;
        }
        timer = setTimeout(tick, 24);
      }
    };
    timer = setTimeout(tick, 700);
    return () => clearTimeout(timer);
  }, []);

  return typed;
}

function LoginPage() {
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState('');
  const typed = useTypewriter();

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
    <div className="lv2-screen">
      {/* ambient background layers */}
      <div className="lv2-blob-a" aria-hidden="true" />
      <div className="lv2-blob-b" aria-hidden="true" />
      <div className="lv2-blob-c" aria-hidden="true" />
      <div className="lv2-ring" aria-hidden="true" />
      {STARS.map((s) => (
        <div
          key={`${s.top}-${s.left}`}
          className="lv2-star"
          aria-hidden="true"
          style={{
            top: s.top,
            left: s.left,
            width: s.size,
            height: s.size,
            animationDuration: s.duration,
            animationDelay: s.delay,
          }}
        />
      ))}

      {/* brand */}
      <div className="lv2-brand">MyWorkMate</div>

      {/* typewriter headline */}
      <h1 className="lv2-headline" aria-label={PHRASES[0]}>
        <span aria-hidden="true">{typed}</span>
        <span className="lv2-caret" aria-hidden="true" />
      </h1>

      {/* ambient mini-cards: docked to screen sides on wide viewports */}
      <div className="lv2-side-wrap" aria-hidden="true">
        <div className="lv2-mini lv2-mini-activity">
          <div className="lv2-mini-head" style={{ gap: 6 }}>
            <div className="lv2-mini-dot" style={{ background: 'rgba(255,255,255,0.25)' }} />
            <div className="lv2-mini-dot" style={{ background: 'rgba(255,255,255,0.18)' }} />
            <div className="lv2-mini-dot" style={{ background: 'rgba(255,255,255,0.12)' }} />
            <div className="lv2-mini-label" style={{ marginLeft: 'auto' }}>ACTIVITY</div>
          </div>
          <div className="lv2-type-lines">
            <div
              className="lv2-type-line"
              style={{ background: 'linear-gradient(90deg, rgba(96,165,250,0.5), rgba(6,182,212,0.35))' }}
            />
            <div
              className="lv2-type-line"
              style={{ background: 'rgba(255,255,255,0.16)', animationDelay: '0.5s' }}
            />
            <div
              className="lv2-type-line"
              style={{ background: 'rgba(255,255,255,0.10)', animationDelay: '1s' }}
            />
          </div>
          <div className="lv2-keys">
            {KEYS.map((k) => (
              <div
                key={k.label}
                className={`lv2-key${k.wide ? ' lv2-key-wide' : ''}`}
                style={{ animationDelay: k.delay }}
              >
                {k.label}
              </div>
            ))}
          </div>
        </div>

        <div className="lv2-mini lv2-mini-pulse">
          <div className="lv2-mini-head" style={{ gap: 7, marginBottom: 14 }}>
            <div className="lv2-rec-dot" />
            <div className="lv2-mini-label">TEAM PULSE · LIVE</div>
          </div>
          <div className="lv2-bars">
            {BARS.map((b, idx) => (
              <div
                // static list — index key is fine
                key={idx}
                className={`lv2-bar${b.variant ? ` ${b.variant}` : ''}`}
                style={{ animationDuration: b.duration, animationDelay: b.delay }}
              />
            ))}
          </div>
          <div className="lv2-pulse-stat">▲ 12% productivity this week</div>
        </div>
      </div>

      {/* sign-in card */}
      <div className="lv2-card-rise">
        <div className="lv2-card">
          <img src="/amzur-logo-white.png" alt="Amzur Technologies" className="lv2-card-logo" />
          <div className="lv2-card-sub">Sign in to continue to MyWorkMate</div>

          {error && (
            <div className="w-full mb-4">
              <ErrorBanner message={error} onClose={() => setError('')} />
            </div>
          )}

          <button
            type="button"
            className="lv2-google"
            onClick={handleGoogleLogin}
            disabled={googleLoading}
          >
            <span className="lv2-google-shine" aria-hidden="true" />
            {googleLoading ? (
              <svg className="w-5 h-5 animate-spin text-gray-500" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg width="19" height="19" viewBox="0 0 18 18" aria-hidden="true">
                <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
                <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
                <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3-2.33z" />
                <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59A9 9 0 0 0 .96 4.95l3 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
              </svg>
            )}
            <span>{googleLoading ? 'Redirecting to Google…' : 'Sign in with Google'}</span>
          </button>
        </div>
      </div>

      {/* feature chips */}
      <div className="lv2-chips">
        {CHIPS.map((chip) => (
          <div key={chip.label} className="lv2-chip" style={{ animationDelay: chip.delay }}>
            <chip.Icon className="lv2-chip-icon" size={15} strokeWidth={2} aria-hidden="true" />
            <span>{chip.label}</span>
          </div>
        ))}
      </div>

      {/* footer */}
      <div className="lv2-footer">
        © {new Date().getFullYear()} Amzur Technologies
      </div>
    </div>
  );
}

export default LoginPage;
