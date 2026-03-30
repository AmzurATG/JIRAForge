import React, { useState } from 'react';
import EditableCell from './EditableCell';
import AddRowModal from './AddRowModal';
import ConfirmDeleteModal from './ConfirmDeleteModal';

const STATUS_COLORS = {
  'To Do (Start)': { color: '#c0392b', bg: '#fadbd8' },
  'In Progress':   { color: '#e67e22', bg: '#fdebd0' },
  'Review':        { color: '#b7950b', bg: '#fef9e7' },
  'Done':          { color: '#27ae60', bg: '#d5f5e3' }
};

function getStatusStyle(status) {
  return STATUS_COLORS[status] || { color: '#333', bg: '#f5f5f5' };
}

function TicketStatusTable({ ticketStatuses, saving, onUpdate, onAdd, onDelete }) {
  const [showAdd, setShowAdd] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const handleAdd = async (values) => {
    const style = getStatusStyle(values.status);
    const result = await onAdd({
      status: values.status,
      statusColor: style.color,
      count: Number(values.count) || 0,
      teamBreakdown: values.teamBreakdown || '',
      releaseForSignoff: values.releaseForSignoff || '',
      sortOrder: ticketStatuses.length
    });
    if (result.success) setShowAdd(false);
  };

  const handleDelete = async () => {
    if (deleteTarget) {
      await onDelete(deleteTarget.id);
      setDeleteTarget(null);
    }
  };

  return (
    <div className="table-section">
      <div className="table-header-row">
        <h3 className="table-title">Ticket Status Summary</h3>
        <button className="btn-add" onClick={() => setShowAdd(true)}>+ Add Status</button>
      </div>
      <table className="dashboard-table">
        <thead>
          <tr>
            <th>Status</th>
            <th>Count</th>
            <th>Team Breakdown</th>
            <th>Release for Signoff</th>
            <th className="actions-col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {ticketStatuses.map((s) => {
            const style = getStatusStyle(s.status);
            return (
              <tr key={s.id} style={{ backgroundColor: style.bg }}>
                <td>
                  <span className="status-badge" style={{ color: style.color, fontWeight: 'bold' }}>
                    <EditableCell
                      value={s.status}
                      onSave={(v) => onUpdate({ id: s.id, status: v })}
                      disabled={saving}
                    />
                  </span>
                </td>
                <td>
                  <EditableCell
                    value={s.count}
                    type="number"
                    onSave={(v) => onUpdate({ id: s.id, count: Number(v) })}
                    disabled={saving}
                  />
                </td>
                <td>
                  <EditableCell
                    value={s.team_breakdown || ''}
                    onSave={(v) => onUpdate({ id: s.id, teamBreakdown: v })}
                    disabled={saving}
                  />
                </td>
                <td>
                  <EditableCell
                    value={s.release_for_signoff || ''}
                    onSave={(v) => onUpdate({ id: s.id, releaseForSignoff: v })}
                    disabled={saving}
                  />
                </td>
                <td className="actions-col">
                  <button className="btn-delete-row" onClick={() => setDeleteTarget(s)}>🗑</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {showAdd && (
        <AddRowModal
          title="Add Ticket Status"
          fields={[
            { key: 'status', label: 'Status Name', required: true },
            { key: 'count', label: 'Count', type: 'number', default: 0 },
            { key: 'teamBreakdown', label: 'Team Breakdown' },
            { key: 'releaseForSignoff', label: 'Release for Signoff' }
          ]}
          onSubmit={handleAdd}
          onClose={() => setShowAdd(false)}
        />
      )}

      {deleteTarget && (
        <ConfirmDeleteModal
          itemName={deleteTarget.status}
          onConfirm={handleDelete}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

export default TicketStatusTable;
