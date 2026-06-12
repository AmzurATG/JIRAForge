/**
 * Line of Businesses Page (superadmin only)
 *
 * List / create / edit / delete LOBs. Drill into an LOB to manage members,
 * heads, and its app classifications.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Edit2, Trash2, Settings2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { lobsApi } from '../api/lobs';
import DataTable from '../components/common/DataTable';
import ConfirmDialog from '../components/common/ConfirmDialog';
import LoadingSpinner from '../components/common/LoadingSpinner';
import ErrorBanner from '../components/common/ErrorBanner';
import SuccessBanner from '../components/common/SuccessBanner';

function LobsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [lobs, setLobs] = useState([]);

  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState('create');
  const [editing, setEditing] = useState(null);
  const [formData, setFormData] = useState({ name: '', description: '' });

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleting, setDeleting] = useState(null);

  const isSuperadmin = user?.role === 'superadmin';

  useEffect(() => {
    // Superadmin sees all LOBs (full management); a head sees only their LOB(s)
    // (read-only list → open to manage that LOB's app classifications).
    loadLobs();
  }, [isSuperadmin]);

  const loadLobs = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await lobsApi.list(isSuperadmin ? { includeInactive: true } : undefined);
      setLobs(response.data || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load LOBs');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = () => {
    setModalMode('create');
    setEditing(null);
    setFormData({ name: '', description: '' });
    setShowModal(true);
  };

  const handleEdit = (lob) => {
    setModalMode('edit');
    setEditing(lob);
    setFormData({ name: lob.name, description: lob.description || '' });
    setShowModal(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!formData.name.trim()) {
      setError('LOB name is required');
      return;
    }
    try {
      if (modalMode === 'create') {
        await lobsApi.create({ name: formData.name, description: formData.description });
        setSuccess('LOB created successfully');
      } else {
        await lobsApi.update(editing.id, { name: formData.name, description: formData.description });
        setSuccess('LOB updated successfully');
      }
      setShowModal(false);
      loadLobs();
    } catch (err) {
      setError(err.response?.data?.error || `Failed to ${modalMode} LOB`);
    }
  };

  const confirmDelete = async () => {
    try {
      await lobsApi.remove(deleting.id);
      setSuccess('LOB deleted successfully');
      setShowDeleteDialog(false);
      setDeleting(null);
      loadLobs();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete LOB');
    }
  };

  const columns = [
    { key: 'name', label: 'Name', sortable: true },
    { key: 'description', label: 'Description', sortable: false, render: (v) => v || '—' },
    {
      key: 'is_active',
      label: 'Status',
      sortable: true,
      render: (v) => (
        <span className={`px-2 py-1 rounded text-xs font-semibold ${
          v ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
            : 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200'
        }`}>
          {v ? 'Active' : 'Inactive'}
        </span>
      ),
    },
    { key: 'created_at', label: 'Created', sortable: true, render: (v) => (v ? new Date(v).toLocaleDateString() : '—') },
    {
      key: 'actions',
      label: 'Actions',
      sortable: false,
      render: (_, lob) => (
        <div className="flex gap-2">
          <button
            onClick={(e) => { e.stopPropagation(); navigate(`/lobs/${lob.id}`); }}
            className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded text-primary-600"
            title={isSuperadmin ? 'Manage members, heads & apps' : 'Manage app classifications'}
          >
            <Settings2 className="w-4 h-4" />
          </button>
          {isSuperadmin && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); handleEdit(lob); }}
                className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
                title="Edit"
              >
                <Edit2 className="w-4 h-4" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setDeleting(lob); setShowDeleteDialog(true); }}
                className="p-1 hover:bg-red-100 dark:hover:bg-red-900 rounded text-red-600"
                title="Delete"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      ),
    },
  ];

  if (loading && lobs.length === 0) {
    return (
      <div className="flex justify-center items-center h-64"><LoadingSpinner /></div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="page-title">{isSuperadmin ? 'Line of Businesses' : 'My LOBs'}</h1>
          <p className="text-gray-500 dark:text-gray-400 text-xs mt-0.5">
            {isSuperadmin ? 'Create LOBs, then assign employees and heads' : 'Open an LOB to manage its app classifications'}
          </p>
        </div>
        {isSuperadmin && (
          <button onClick={handleCreate} className="btn-primary flex items-center gap-1.5">
            <Plus className="w-3.5 h-3.5" />
            Add LOB
          </button>
        )}
      </div>

      {error && <ErrorBanner message={error} onClose={() => setError(null)} />}
      {success && <SuccessBanner message={success} onClose={() => setSuccess(null)} />}

      <div className="card">
        <DataTable
          columns={columns}
          data={lobs}
          loading={loading}
          emptyMessage={isSuperadmin ? 'No LOBs yet — create one to get started' : 'No LOBs assigned to you yet'}
          onRowClick={(lob) => navigate(`/lobs/${lob.id}`)}
        />
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-4">{modalMode === 'create' ? 'Add LOB' : 'Edit LOB'}</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="filter-label">Name *</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="input-field"
                  placeholder="e.g., Cloud Practice"
                  required
                />
              </div>
              <div>
                <label className="filter-label">Description</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="input-field"
                  rows={3}
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setShowModal(false)} className="btn-secondary">Cancel</button>
                <button type="submit" className="btn-primary">{modalMode === 'create' ? 'Create' : 'Update'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={showDeleteDialog}
        title="Delete LOB"
        message={`Delete "${deleting?.name}"? Its member, head and app-classification assignments are removed. Employees and their activity are not affected.`}
        onConfirm={confirmDelete}
        onCancel={() => setShowDeleteDialog(false)}
        confirmLabel="Delete"
      />
    </div>
  );
}

export default LobsPage;
