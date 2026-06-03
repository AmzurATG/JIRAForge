import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Recover from stale lazy-loaded chunks after a new deploy. Vite fires
// `vite:preloadError` when a dynamic import fails because the old hashed chunk
// is no longer on the server (the browser/CDN still has the previous build's
// index). Reload once to pick up the fresh index + assets. A short time guard
// prevents a reload loop if the chunk is genuinely unavailable.
window.addEventListener('vite:preloadError', () => {
  const last = Number(sessionStorage.getItem('vitePreloadReloadAt') || 0);
  if (Date.now() - last < 10000) return; // already reloaded recently — avoid a loop
  sessionStorage.setItem('vitePreloadReloadAt', String(Date.now()));
  window.location.reload();
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
