import React from 'react';
import DescriptionQuality from './DescriptionQuality';
import './DqActionApp.css';

/**
 * DqActionApp — jira:issueAction surface
 *
 * Opened when the user clicks "Check Description Quality" from the
 * ··· more actions menu on any Jira issue. Renders inside a full-screen
 * Forge iframe, showing a header bar + the complete DescriptionQuality
 * component (score badge, issues list, suggestions, AI improve flow).
 *
 * No new backend resolvers — fully reuses the existing DescriptionQuality
 * component and its analyzeDescription / updateDescription resolvers.
 */
export default function DqActionApp({ issueKey }) {
  return (
    <div className="dqa-root">
      {/* Header bar */}
      <header className="dqa-header">
        <div className="dqa-header-icon" aria-hidden="true">
          {/* Simple magnifier + checkmark icon */}
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
            <polyline points="9 11 11 13 15 9" />
          </svg>
        </div>
        <h1 className="dqa-header-title">Description Quality</h1>
        {issueKey && (
          <span className="dqa-header-issue" aria-label={`Issue key: ${issueKey}`}>
            {issueKey}
          </span>
        )}
      </header>

      {/* Main content */}
      <main className="dqa-content">
        {issueKey ? (
          <div className="dqa-panel-wrapper">
            {/*
              Renders the full DescriptionQuality component:
              - Auto-scores on mount (analyzeDescription resolver)
              - Shows score badge, issues, suggestions
              - "Improve with AI" triggers LLM improvement flow
              - Accept / Edit / Discard flow writes back to Jira
            */}
            <DescriptionQuality issueKey={issueKey} />
          </div>
        ) : (
          <div className="dqa-center">
            <span>⚠️ No issue key found in context.</span>
            <span style={{ fontSize: '12px' }}>
              Please open this action from an issue page.
            </span>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="dqa-footer">
        Powered by JiraForge · AI-assisted description scoring &amp; improvement
      </footer>
    </div>
  );
}
