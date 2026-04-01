import React from 'react';
import ReactDOM from 'react-dom/client';
import '@forge/bridge'; // Ensure bridge handshake fires immediately
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
