import React, { useState } from 'react';
import EditableCell from './EditableCell';
import AddRowModal from './AddRowModal';
import ConfirmDeleteModal from './ConfirmDeleteModal';

function TicketsPerTeamTable({ ticketsPerTeam, saving, onUpdate, onAdd, onDelete }) {
  const [showAdd, setShowAdd] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const totalTickets = ticketsPerTeam.reduce((sum, t) => sum + (t.tickets_raised || 0), 0);

  const handleAdd = async (values) => {
    const result = await onAdd({
      teamName: values.teamName,
      ticketsRaised: Number(values.ticketsRaised) || 0,
      startedDate: values.startedDate || ''
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
        <h3 className="table-title">Tickets Raised Per Team</h3>
        <button className="btn-add" onClick={() => setShowAdd(true)}>+ Add Team</button>
      </div>
      <table className="dashboard-table">
        <thead>
          <tr>
            <th>Team/Organization</th>
            <th>Tickets Raised</th>
            <th>% of Total</th>
            <th>Started</th>
            <th className="actions-col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {ticketsPerTeam.map((t) => (
            <tr key={t.id}>
              <td>
                <EditableCell
                  value={t.team_name}
                  onSave={(v) => onUpdate({ id: t.id, teamName: v })}
                  disabled={saving}
                />
              </td>
              <td>
                <EditableCell
                  value={t.tickets_raised}
                  type="number"
                  onSave={(v) => onUpdate({ id: t.id, ticketsRaised: Number(v) })}
                  disabled={saving}
                />
              </td>
              <td className="auto-calc">{t.percent_of_total ?? 0}%</td>
              <td>
                <EditableCell
                  value={t.started_date || ''}
                  onSave={(v) => onUpdate({ id: t.id, startedDate: v })}
                  disabled={saving}
                />
              </td>
              <td className="actions-col">
                <button className="btn-delete-row" onClick={() => setDeleteTarget(t)}>🗑</button>
              </td>
            </tr>
          ))}
          <tr className="total-row">
            <td></td>
            <td><strong>{totalTickets}</strong></td>
            <td></td>
            <td></td>
            <td></td>
          </tr>
        </tbody>
      </table>

      {showAdd && (
        <AddRowModal
          title="Add Ticket Team"
          fields={[
            { key: 'teamName', label: 'Team/Organization', required: true },
            { key: 'ticketsRaised', label: 'Tickets Raised', type: 'number', default: 0 },
            { key: 'startedDate', label: 'Started Date' }
          ]}
          onSubmit={handleAdd}
          onClose={() => setShowAdd(false)}
        />
      )}

      {deleteTarget && (
        <ConfirmDeleteModal
          itemName={deleteTarget.team_name}
          onConfirm={handleDelete}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

export default TicketsPerTeamTable;
