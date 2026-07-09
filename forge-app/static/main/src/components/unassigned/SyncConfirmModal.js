import React, { useState, useEffect } from 'react';
import './SyncConfirmModal.css';
import { formatTime } from '../../utils';
import { invoke } from '@forge/bridge';
export default function SyncConfirmModal({ isOpen, onClose, onConfirm, syncJobResult, isSubmitting }) {
  const [selectedSessions, setSelectedSessions] = useState(new Set());
  const [manualAssignments, setManualAssignments] = useState({}); // { sessionId: issueKey }
  const [sessions, setSessions] = useState([]);
  const [availableIssues, setAvailableIssues] = useState([]);
  const [openDropdownId, setOpenDropdownId] = useState(null);

  useEffect(() => {
    if (isOpen) {
      invoke('getAllUserAssignedIssues').then(res => {
        if (res?.success && res.issues) {
          setAvailableIssues(res.issues);
        }
      });
    }
  }, [isOpen]);

  useEffect(() => {
    const handleClickOutside = () => setOpenDropdownId(null);
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  useEffect(() => {
    if (isOpen && syncJobResult?.matchedSessions) {
      setSessions(syncJobResult.matchedSessions);
      // Select all by default
      setSelectedSessions(new Set(syncJobResult.matchedSessions.map(s => s.sessionId)));
      setManualAssignments({});
    } else if (!isOpen) {
      setSessions([]);
      setSelectedSessions(new Set());
      setManualAssignments({});
    }
  }, [isOpen, syncJobResult]);

  if (!isOpen) return null;

  const toggleSelection = (sessionId) => {
    setSelectedSessions(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const handleConfirm = () => {
    const finalMappings = Array.from(selectedSessions).map(sessionId => {
      const originalSession = sessions.find(s => s.sessionId === sessionId);
      const manualKey = manualAssignments[sessionId];
      return {
        sessionId,
        issueKey: manualKey || originalSession.issueKey
      };
    });
    onConfirm(finalMappings);
  };

  const totalTime = sessions.filter(s => selectedSessions.has(s.sessionId)).reduce((acc, s) => acc + s.durationSeconds, 0);
  const selectedCount = selectedSessions.size;

  return (
    <div className="sync-confirm-modal-overlay">
      <div className="sync-confirm-modal-container">
        <div className="sync-confirm-modal-header">
          <h3>Confirm Sync Mappings</h3>
          <button className="sync-confirm-modal-close" onClick={onClose} aria-label="Close modal">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div className="sync-confirm-modal-subheader">
          <strong>{selectedCount} Sessions</strong> matched - {formatTime(totalTime)} total Time
        </div>

        <div className="sync-confirm-modal-content">
          {syncJobResult?.error ? (
            <div className="sync-confirm-error">{syncJobResult.error}</div>
          ) : sessions.length === 0 ? (
            <div className="sync-confirm-empty">No sessions matched.</div>
          ) : (
            <div className="sync-confirm-list">
              {sessions.map(session => {
                const isSelected = selectedSessions.has(session.sessionId);
                const assignedIssueKey = manualAssignments[session.sessionId] || session.issueKey;

                return (
                  <div key={session.sessionId} className={`sync-confirm-item ${!isSelected ? 'unselected' : ''}`}>
                    <div className="sync-confirm-item-checkbox">
                      <input 
                        type="checkbox" 
                        className="sync-custom-checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelection(session.sessionId)}
                      />
                    </div>
                    
                    <div className="sync-confirm-item-details">
                      <div className="sync-confirm-item-time">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="10"></circle>
                          <polyline points="12 6 12 12 16 14"></polyline>
                        </svg>
                        {formatTime(session.durationSeconds)}
                      </div>
                      
                      <div className="sync-confirm-item-title-row">
                        <span className="sync-confirm-item-title">{session.issueSummary || session.windowTitle || session.applicationName}</span>
                        <span className="sync-confirm-item-chip">{assignedIssueKey}</span>
                      </div>
                      
                      <div className="sync-confirm-item-insight">
                        ✦ {session.groupDescription ? 'Group Context' : 'Context'}: {session.groupDescription || session.windowTitle || session.applicationName}
                        {session.insight && (
                          <>
                            <br />
                            ✦ AI says: "{session.insight}"
                          </>
                        )}
                      </div>
                    </div>
                    
                    <div className="sync-confirm-item-actions">
                      <button 
                        className="sync-confirm-manual-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenDropdownId(openDropdownId === session.sessionId ? null : session.sessionId);
                        }}
                      >
                        Choose ticket manually...
                      </button>
                      {openDropdownId === session.sessionId && (
                        <div className="sync-confirm-manual-dropdown" onClick={e => e.stopPropagation()}>
                          {availableIssues.length === 0 ? (
                            <div className="sync-confirm-dropdown-item">
                              <div className="sync-confirm-dropdown-item-summary">No issues found</div>
                            </div>
                          ) : (
                            availableIssues.map(issue => (
                              <div 
                                key={issue.key} 
                                className="sync-confirm-dropdown-item"
                                onClick={() => {
                                  setManualAssignments(prev => ({ ...prev, [session.sessionId]: issue.key }));
                                  setOpenDropdownId(null);
                                }}
                              >
                                <div className="sync-confirm-dropdown-item-key">{issue.key} -</div>
                                <div className="sync-confirm-dropdown-item-summary">{issue.summary}</div>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="sync-confirm-modal-footer">
          <div className="sync-confirm-footer-text">
            <span>Non sync items stay in Unassigned Work</span>
          </div>
          <div className="sync-confirm-footer-actions">
            <button className="sync-cancel-btn" onClick={onClose} disabled={isSubmitting}>Cancel</button>
            <button className="sync-submit-btn" onClick={handleConfirm} disabled={isSubmitting || selectedCount === 0 || !!syncJobResult?.error}>
              {isSubmitting ? 'Syncing...' : 'Confirm Sync'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
