import React from 'react';
import { router } from '@forge/bridge';
import './QualityCell.css';

function formatRelativeTime(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return '';
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

export const navigateToIssueWithImprove = (issueKey) => {
  const url = `/browse/${issueKey}#dq=improve`;
  try {
    router.open(url);
  } catch (e) {
    try {
      router.navigate(url);
    } catch (e2) {
      console.error('Could not navigate to issue with improve:', e2);
    }
  }
};

function QualityCell({ score, status, error, cachedAt, issueKey, onRetry }) {
  if (status === 'pending') {
    return (
      <div className="quality-cell quality-pending-state">
        <div className="quality-spinner"></div>
        <span className="quality-status-text">Analysing…</span>
      </div>
    );
  }

  if (status === 'error' || error) {
    return (
      <div className="quality-cell quality-error-state">
        <span className="quality-error-text" title={error || 'Could not analyse description'}>—</span>
        <button 
          className="quality-retry-button" 
          onClick={() => onRetry && onRetry(issueKey)}
          title="Retry analysis"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
          </svg>
        </button>
      </div>
    );
  }

  if (score === undefined || score === null) {
    return <div className="quality-cell empty">—</div>;
  }

  let badgeClass = 'green';
  let badgeLabel = 'Good';

  if (score <= 80) {
    badgeClass = 'red';
    badgeLabel = 'Bad';
  }

  const relativeTime = formatRelativeTime(cachedAt);
  const tooltipText = relativeTime ? `Last analysed ${relativeTime}` : 'Description quality';

  return (
    <div className="quality-cell resolved" title={tooltipText}>
      <div className="quality-indicator">
        <span className={`quality-dot ${badgeClass}`}></span>
        <span className="quality-text">{badgeLabel} ({score}%)</span>
      </div>
    </div>
  );
}

export default QualityCell;
