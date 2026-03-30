import React from 'react';
import useDashboardData from '../hooks/useDashboardData';
import MetricsBar from './MetricsBar';
import OrganizationsTable from './OrganizationsTable';
import TicketsPerTeamTable from './TicketsPerTeamTable';
import TicketStatusTable from './TicketStatusTable';
import './StatusReportDashboard.css';
import './Tables.css';

function StatusReportDashboard() {
  const {
    metrics, organizations, ticketsPerTeam, ticketStatuses,
    loading, error, saving,
    reload,
    addMetric, updateMetric, deleteMetric,
    addOrg, updateOrg, deleteOrg,
    addTicketTeam, updateTicketTeam, deleteTicketTeam,
    addTicketStatus, updateTicketStatus, deleteTicketStatus
  } = useDashboardData();

  if (loading) {
    return (
      <div className="dashboard-loading">
        <div className="loading-spinner"></div>
        <p>Loading dashboard data...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard-error">
        <h3>Error loading dashboard</h3>
        <p>{error}</p>
        <button className="btn-retry" onClick={reload}>Retry</button>
      </div>
    );
  }

  return (
    <div className="status-report-dashboard">
      <header className="dashboard-header">
        <h1 className="dashboard-title">Time Tracker Application - Status Report</h1>
        <div className="status-badge">Status: Internal Testing</div>
      </header>

      {saving && <div className="saving-indicator">Saving...</div>}

      <MetricsBar
        metrics={metrics}
        saving={saving}
        onUpdate={updateMetric}
        onAdd={addMetric}
        onDelete={deleteMetric}
      />

      <OrganizationsTable
        organizations={organizations}
        saving={saving}
        onUpdate={updateOrg}
        onAdd={addOrg}
        onDelete={deleteOrg}
      />

      <TicketsPerTeamTable
        ticketsPerTeam={ticketsPerTeam}
        saving={saving}
        onUpdate={updateTicketTeam}
        onAdd={addTicketTeam}
        onDelete={deleteTicketTeam}
      />

      <TicketStatusTable
        ticketStatuses={ticketStatuses}
        saving={saving}
        onUpdate={updateTicketStatus}
        onAdd={addTicketStatus}
        onDelete={deleteTicketStatus}
      />
    </div>
  );
}

export default StatusReportDashboard;
