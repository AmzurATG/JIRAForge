import React, { useState } from 'react';
import './EditableCell.css';

/**
 * Inline-editable table cell.
 * Click to switch to edit mode; save on Enter/blur; cancel on Escape.
 */
function EditableCell({ value, onSave, type = 'text', disabled = false }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const startEditing = () => {
    if (disabled) return;
    setDraft(value);
    setEditing(true);
  };

  const save = () => {
    setEditing(false);
    const trimmed = type === 'number' ? Number(draft) : String(draft).trim();
    if (trimmed !== value) {
      onSave(trimmed);
    }
  };

  const cancel = () => {
    setEditing(false);
    setDraft(value);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') cancel();
  };

  if (editing) {
    return (
      <input
        className="editable-cell-input"
        type={type}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={handleKeyDown}
        autoFocus
      />
    );
  }

  return (
    <span
      className={`editable-cell ${disabled ? 'disabled' : ''}`}
      onClick={startEditing}
      title={disabled ? '' : 'Click to edit'}
    >
      {value !== undefined && value !== null && value !== '' ? value : '\u00A0'}
    </span>
  );
}

export default EditableCell;
