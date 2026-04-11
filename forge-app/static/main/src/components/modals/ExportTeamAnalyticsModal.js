import React, { useState } from 'react';
import { invoke } from '@forge/bridge';
import { generateExcelReport } from '../../utils/excelExport';
import './ExportTeamAnalyticsModal.css';

/**
 * Export Team Analytics Modal
 * Allows admin to export team analytics data with user and period filters
 */
function ExportTeamAnalyticsModal({ isOpen, onClose, projectKey, teamAnalytics, availableProjectKeys }) {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState(null);
  const [dateRange, setDateRange] = useState('month'); // 'today' | 'week' | 'month' | 'custom'
  const [format, setFormat] = useState('xlsx');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [selectedUserIds, setSelectedUserIds] = useState([]); // empty = all users
  const [selectedProjectKeys, setSelectedProjectKeys] = useState([projectKey]); // default to current project
  const [projectSelectAll, setProjectSelectAll] = useState(false);

  const members = (teamAnalytics && teamAnalytics.teamMemberActivity) || [];

  const toggleUser = (userId) => {
    setSelectedUserIds(prev =>
      prev.includes(userId) ? prev.filter(id => id !== userId) : [...prev, userId]
    );
  };

  const selectAllUsers = () => setSelectedUserIds([]);

  const allProjects = availableProjectKeys || [];

  const toggleProject = (pk) => {
    setProjectSelectAll(false);
    setSelectedProjectKeys(prev =>
      prev.includes(pk) ? prev.filter(k => k !== pk) : [...prev, pk]
    );
  };

  const handleSelectAllProjects = () => {
    setProjectSelectAll(true);
    setSelectedProjectKeys([...allProjects]);
  };

  const handleSelectCurrentProject = () => {
    setProjectSelectAll(false);
    setSelectedProjectKeys([projectKey]);
  };

  const handleExport = async () => {
    setExporting(true);
    setError(null);

    try {
      let startDate, endDate;
      const today = new Date();
      const todayStr = today.toLocaleDateString('sv-SE');

      switch (dateRange) {
        case 'today':
          startDate = todayStr;
          endDate = todayStr;
          break;

        case 'week':
          const weekStart = new Date(today);
          const dayOfWeek = weekStart.getDay();
          const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
          weekStart.setDate(today.getDate() - daysToMonday);
          startDate = weekStart.toLocaleDateString('sv-SE');
          endDate = todayStr;
          break;

        case 'month':
          startDate = new Date(today.getFullYear(), today.getMonth(), 1).toLocaleDateString('sv-SE');
          endDate = todayStr;
          break;

        case 'custom':
          startDate = customStartDate;
          endDate = customEndDate;
          if (!startDate || !endDate) {
            throw new Error('Please select both start and end dates');
          }
          break;

        default:
          throw new Error('Invalid date range');
      }

      const exportProjectKeys = selectedProjectKeys.length > 0 ? selectedProjectKeys : [projectKey];
      const isMultiProject = exportProjectKeys.length > 1;
      const projectLabel = isMultiProject ? `${exportProjectKeys.length}-projects` : exportProjectKeys[0];

      if (format === 'xlsx') {
        const result = await invoke('exportTeamAnalyticsExcel', {
          projectKeys: exportProjectKeys,
          startDate,
          endDate,
          filterUserIds: selectedUserIds.length > 0 ? selectedUserIds : null
        });

        if (result.success) {
          await generateExcelReport(result.data, `team-analytics-${projectLabel}-${endDate}`);
          onClose();
        } else {
          setError(result.error || 'Export failed');
        }
      } else {
        const result = await invoke('exportTeamAnalytics', {
          projectKeys: exportProjectKeys,
          startDate,
          endDate,
          format,
          filterUserIds: selectedUserIds.length > 0 ? selectedUserIds : null
        });

        if (result.success) {
          downloadFile(result.data, format, result.filename || `team-analytics-${projectLabel}-${endDate}.csv`);
          onClose();
        } else {
          setError(result.error || 'Export failed');
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  };

  const downloadFile = (data, format, filename) => {
    const mimeType = format === 'csv' ? 'text/csv;charset=utf-8;' : 'application/vnd.ms-excel';
    const blob = new Blob([data], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="export-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Export Team Analytics</h2>
          <button className="modal-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-content">
          <div className="export-options">
            {/* Project Selection */}
            <div className="option-group">
              <label>Projects:</label>
              <div className="user-filter-actions">
                <button 
                  type="button"
                  className={`filter-chip ${projectSelectAll ? 'active' : ''}`}
                  onClick={handleSelectAllProjects}
                >
                  All Projects
                </button>
                <button 
                  type="button"
                  className={`filter-chip ${!projectSelectAll && selectedProjectKeys.length === 1 && selectedProjectKeys[0] === projectKey ? 'active' : ''}`}
                  onClick={handleSelectCurrentProject}
                >
                  Current ({projectKey})
                </button>
                {!projectSelectAll && selectedProjectKeys.length > 1 && (
                  <span className="selected-count">{selectedProjectKeys.length} selected</span>
                )}
              </div>
              {allProjects.length > 0 && (
                <div className="project-checkbox-list">
                  {allProjects.map((pk) => (
                    <label key={pk} className="user-checkbox-item">
                      <input
                        type="checkbox"
                        checked={selectedProjectKeys.includes(pk)}
                        onChange={() => toggleProject(pk)}
                      />
                      <span className="user-checkbox-name">{pk}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* Period Selection */}
            <div className="option-group">
              <label htmlFor="date-range">Period:</label>
              <select 
                id="date-range"
                value={dateRange} 
                onChange={(e) => setDateRange(e.target.value)}
              >
                <option value="today">Today</option>
                <option value="week">This Week</option>
                <option value="month">This Month</option>
                <option value="custom">Custom Range</option>
              </select>
            </div>

            {dateRange === 'custom' && (
              <div className="custom-date-range">
                <div className="date-input">
                  <label htmlFor="start-date">Start Date:</label>
                  <input 
                    type="date" 
                    id="start-date"
                    value={customStartDate} 
                    onChange={(e) => setCustomStartDate(e.target.value)} 
                  />
                </div>
                <div className="date-input">
                  <label htmlFor="end-date">End Date:</label>
                  <input 
                    type="date" 
                    id="end-date"
                    value={customEndDate} 
                    onChange={(e) => setCustomEndDate(e.target.value)} 
                  />
                </div>
              </div>
            )}

            {/* User Selection */}
            <div className="option-group">
              <label>Users:</label>
              <div className="user-filter-actions">
                <button 
                  type="button"
                  className={`filter-chip ${selectedUserIds.length === 0 ? 'active' : ''}`}
                  onClick={selectAllUsers}
                >
                  All Users
                </button>
                {selectedUserIds.length > 0 && (
                  <span className="selected-count">{selectedUserIds.length} selected</span>
                )}
              </div>
              {members.length > 0 && (
                <div className="user-checkbox-list">
                  {members.map((m) => (
                    <label key={m.userId} className="user-checkbox-item">
                      <input
                        type="checkbox"
                        checked={selectedUserIds.includes(m.userId)}
                        onChange={() => toggleUser(m.userId)}
                      />
                      <span className="user-checkbox-name">{m.displayName}</span>
                      <span className="user-checkbox-hours">{m.monthHours}h</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* Format */}
            <div className="option-group">
              <label htmlFor="export-format">Format:</label>
              <select 
                id="export-format"
                value={format} 
                onChange={(e) => setFormat(e.target.value)}
              >
                <option value="xlsx">Excel (.xlsx)</option>
                <option value="csv">CSV</option>
              </select>
            </div>

            <div className="export-preview">
              <h4>Export will include:</h4>
              <ul>
                <li>Team summary statistics</li>
                <li>Member breakdown (Today/Week/Month)</li>
                <li>Detailed activity with session start & end times</li>
                <li>Time by issue with total sums</li>
                {selectedProjectKeys.length > 1 && (
                  <li><strong>Data grouped by project</strong></li>
                )}
              </ul>
            </div>
          </div>

          {error && (
            <div className="error-message">
              <strong>Error:</strong> {error}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="secondary-btn" onClick={onClose} disabled={exporting}>
            Cancel
          </button>
          <button className="primary-btn" onClick={handleExport} disabled={exporting}>
            {exporting ? (
              <>
                <span className="btn-spinner"></span>
                Exporting...
              </>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{marginRight: '6px'}}>
                  <path d="M21 15V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M7 10L12 15L17 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M12 15V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Export
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ExportTeamAnalyticsModal;
