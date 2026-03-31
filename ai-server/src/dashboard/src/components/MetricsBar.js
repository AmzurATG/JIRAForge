import React, { useState } from 'react';
import EditableCell from './EditableCell';
import AddRowModal from './AddRowModal';
import ConfirmDeleteModal from './ConfirmDeleteModal';
import './MetricsBar.css';

function MetricsBar({ metrics, saving, onUpdate, onAdd, onDelete }) {
  const [showAdd, setShowAdd] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const handleMetricValueChange = (metric, newValue) => {
    onUpdate({ id: metric.id, metricValue: Number(newValue) });
  };

  const handleMetricLabelChange = (metric, newLabel) => {
    onUpdate({ id: metric.id, metricLabel: newLabel });
  };

  const handleAdd = async (values) => {
    const result = await onAdd({
      metricKey: values.metricLabel.toLowerCase().replace(/\s+/g, '_'),
      metricLabel: values.metricLabel,
      metricValue: Number(values.metricValue) || 0,
      sortOrder: metrics.length
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
    <div className="metrics-section">
      <div className="metrics-bar">
        {metrics.map((m) => (
          <div className="metric-card" key={m.id}>
            <div className="metric-value">
              <EditableCell
                value={m.metric_value}
                type="number"
                onSave={(v) => handleMetricValueChange(m, v)}
                disabled={saving}
              />
            </div>
            <div className="metric-label">
              <EditableCell
                value={m.metric_label}
                onSave={(v) => handleMetricLabelChange(m, v)}
                disabled={saving}
              />
            </div>
            <button
              className="btn-delete-small"
              onClick={() => setDeleteTarget(m)}
              title="Delete metric"
            >
              ×
            </button>
          </div>
        ))}
        <button className="metric-card metric-add" onClick={() => setShowAdd(true)}>
          <span className="add-icon">+</span>
          <span className="metric-label">Add Metric</span>
        </button>
      </div>

      {showAdd && (
        <AddRowModal
          title="Add Header Metric"
          fields={[
            { key: 'metricLabel', label: 'Label', required: true },
            { key: 'metricValue', label: 'Value', type: 'number', default: 0 }
          ]}
          onSubmit={handleAdd}
          onClose={() => setShowAdd(false)}
        />
      )}

      {deleteTarget && (
        <ConfirmDeleteModal
          itemName={deleteTarget.metric_label}
          onConfirm={handleDelete}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

export default MetricsBar;
