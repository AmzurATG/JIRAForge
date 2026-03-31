import React, { useState } from 'react';
import './Modals.css';

/**
 * Generic modal for adding a new row to any dashboard table.
 * Fields are passed in dynamically.
 */
function AddRowModal({ title, fields, onSubmit, onClose }) {
  const [values, setValues] = useState(
    fields.reduce((acc, f) => ({ ...acc, [f.key]: f.default ?? '' }), {})
  );
  const [submitting, setSubmitting] = useState(false);

  const handleChange = (key, val) => {
    setValues((prev) => ({ ...prev, [key]: val }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    await onSubmit(values);
    setSubmitting(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <form onSubmit={handleSubmit}>
          {fields.map((f) => (
            <div className="modal-field" key={f.key}>
              <label>{f.label}</label>
              <input
                type={f.type || 'text'}
                value={values[f.key]}
                onChange={(e) => handleChange(f.key, e.target.value)}
                required={f.required}
                min={f.type === 'number' ? 0 : undefined}
              />
            </div>
          ))}
          <div className="modal-actions">
            <button type="button" className="btn-cancel" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="btn-save" disabled={submitting}>
              {submitting ? 'Saving...' : 'Add'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AddRowModal;
