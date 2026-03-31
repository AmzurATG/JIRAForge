import React, { useState } from 'react';
import EditableCell from './EditableCell';
import AddRowModal from './AddRowModal';
import ConfirmDeleteModal from './ConfirmDeleteModal';

function OrganizationsTable({ organizations, saving, onUpdate, onAdd, onDelete }) {
  const [showAdd, setShowAdd] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const totalUsers = organizations.reduce((sum, o) => sum + (o.user_count || 0), 0);

  const handleAdd = async (values) => {
    const result = await onAdd({
      name: values.name,
      userCount: Number(values.userCount) || 0
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
        <h3 className="table-title">Users Per Organization &amp; Team</h3>
        <button className="btn-add" onClick={() => setShowAdd(true)}>+ Add Team</button>
      </div>
      <table className="dashboard-table">
        <thead>
          <tr>
            <th>Team/Organization</th>
            <th>User Count</th>
            <th className="actions-col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {organizations.map((org) => (
            <tr key={org.id}>
              <td>
                <EditableCell
                  value={org.name}
                  onSave={(v) => onUpdate({ id: org.id, name: v })}
                  disabled={saving}
                />
              </td>
              <td>
                <EditableCell
                  value={org.user_count}
                  type="number"
                  onSave={(v) => onUpdate({ id: org.id, userCount: Number(v) })}
                  disabled={saving}
                />
              </td>
              <td className="actions-col">
                <button className="btn-delete-row" onClick={() => setDeleteTarget(org)}>🗑</button>
              </td>
            </tr>
          ))}
          <tr className="total-row">
            <td><strong>Total</strong></td>
            <td><strong>{totalUsers}</strong></td>
            <td></td>
          </tr>
        </tbody>
      </table>

      {showAdd && (
        <AddRowModal
          title="Add Team / Organization"
          fields={[
            { key: 'name', label: 'Team/Organization Name', required: true },
            { key: 'userCount', label: 'User Count', type: 'number', default: 0 }
          ]}
          onSubmit={handleAdd}
          onClose={() => setShowAdd(false)}
        />
      )}

      {deleteTarget && (
        <ConfirmDeleteModal
          itemName={deleteTarget.name}
          onConfirm={handleDelete}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

export default OrganizationsTable;
