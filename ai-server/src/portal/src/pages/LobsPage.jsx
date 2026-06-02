/**
 * Line of Businesses Page (superadmin only)
 *
 * List / create / edit / delete LOBs. Drill into an LOB to manage members,
 * heads, and its app classifications.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Edit2, Trash2, Shield, Settings2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { lobsApi } from '../api/lobs';
import DataTable from '../components/common/DataTable';
import ConfirmDialog from '../components/common/ConfirmDialog';
import LoadingSpinner from '../components/common/LoadingSpinner';
import ErrorBanner from '../components/common/ErrorBanner';

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
    if (isSuperadmin) loadLobs();
    else setLoading(false);
  }, [isSuperadmin]);

  const loadLobs = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await lobsApi.list({ includeInactive: true });
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
            title="Manage members, heads & apps"
          >
            <Settings2 className="w-4 h-4" />
          </button>
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
        </div>
      ),
    },
  ];

  if (!isSuperadmin) {
    return (
      <div className="card text-center py-12">
        <Shield className="w-12 h-12 mx-auto mb-4 text-red-500" />
        <h2 className="text-xl font-semibold mb-2">Access Denied</h2>
        <p className="text-gray-600 dark:text-gray-400">Only superadmin users can manage Line of Businesses.</p>
      </div>
    );
  }

  if (loading && lobs.length === 0) {
    return (
      <div className="flex justify-center items-center h-64"><LoadingSpinner /></div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold">Line of Businesses</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            Create LOBs, then assign employees and heads
          </p>
        </div>
        <button onClick={handleCreate} className="flex items-center gap-2 px-4 py-2 rounded bg-primary-600 text-white hover:bg-primary-700">
          <Plus className="w-4 h-4" />
          Add LOB
        </button>
      </div>

      {error && <ErrorBanner message={error} onClose={() => setError(null)} />}
      {success && (
        <div className="mb-6 p-4 bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 rounded">
          {success}
          <button onClick={() => setSuccess(null)} className="float-right font-bold">×</button>
        </div>
      )}

      <div className="card mb-6">
        <DataTable
          columns={columns}
          data={lobs}
          loading={loading}
          emptyMessage="No LOBs yet — create one to get started"
          onRowClick={(lob) => navigate(`/lobs/${lob.id}`)}
        />
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-4">{modalMode === 'create' ? 'Add LOB' : 'Edit LOB'}</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">Name *</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
                  placeholder="e.g., Cloud Practice"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Description</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
                  rows={3}
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800">Cancel</button>
                <button type="submit" className="px-4 py-2 rounded bg-primary-600 text-white hover:bg-primary-700">{modalMode === 'create' ? 'Create' : 'Update'}</button>
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
      />
    </div>
  );
}

export default LobsPage;
