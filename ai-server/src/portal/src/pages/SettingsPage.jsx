/**
 * Settings Page (Admin User Management)
 * 
 * Manage portal admin users (superadmin only).
 */

import { useState, useEffect } from 'react';
import { UserPlus, Edit2, Trash2, Shield } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { adminUsersApi } from '../api/adminUsers';
import { lobsApi } from '../api/lobs';
import DataTable from '../components/common/DataTable';
import ConfirmDialog from '../components/common/ConfirmDialog';
import LoadingSpinner from '../components/common/LoadingSpinner';
import ErrorBanner from '../components/common/ErrorBanner';

function SettingsPage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [admins, setAdmins] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [lobs, setLobs] = useState([]); // all LOBs (for assignment)

  // Create/Edit modal
  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState('create'); // 'create' or 'edit'
  const [editingAdmin, setEditingAdmin] = useState(null);
  const [formData, setFormData] = useState({
    email: '',
    displayName: '',
    role: 'admin',
    lobIds: []
  });
  
  // Delete confirmation
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deletingAdmin, setDeletingAdmin] = useState(null);

  useEffect(() => {
    // Only load admins if user is superadmin
    if (user?.role === 'superadmin') {
      loadAdmins();
    } else {
      setLoading(false);
    }
  }, [page, user?.role]);

  // Load all LOBs once (for the assignment multi-select)
  useEffect(() => {
    if (user?.role === 'superadmin') {
      lobsApi.list().then((res) => setLobs(res.data || [])).catch(() => {});
    }
  }, [user?.role]);

  const loadAdmins = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await adminUsersApi.getList({ page, limit: 20 });
      setAdmins(response.data || []);
      setTotalCount(response.pagination?.totalCount || 0);
    } catch (err) {
      console.error('Failed to load admin users:', err);
      setError(err.response?.data?.error || 'Failed to load admin users');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = () => {
    setModalMode('create');
    setEditingAdmin(null);
    setFormData({ email: '', displayName: '', role: 'admin', lobIds: [] });
    setShowModal(true);
  };

  const handleEdit = (admin) => {
    setModalMode('edit');
    setEditingAdmin(admin);
    setFormData({
      email: admin.email,
      displayName: admin.display_name,
      role: admin.role,
      lobIds: (admin.lobs || []).map((l) => l.id)
    });
    setShowModal(true);
  };

  const handleDelete = (admin) => {
    setDeletingAdmin(admin);
    setShowDeleteDialog(true);
  };

  const confirmDelete = async () => {
    try {
      await adminUsersApi.delete(deletingAdmin.id);
      setSuccess('Admin user deleted successfully');
      setShowDeleteDialog(false);
      setDeletingAdmin(null);
      loadAdmins();
    } catch (err) {
      console.error('Failed to delete admin:', err);
      setError(err.response?.data?.error || 'Failed to delete admin user');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    const isSuper = formData.role === 'superadmin';
    // Superadmins see everything, so LOB assignment doesn't apply to them.
    const lobIds = isSuper ? [] : formData.lobIds;

    if (!isSuper && lobIds.length === 0) {
      setError('Select at least one LOB — a non-superadmin with no LOB would see nothing.');
      return;
    }

    try {
      if (modalMode === 'create') {
        if (!formData.email || !formData.displayName) {
          setError('Email and display name are required');
          return;
        }

        const res = await adminUsersApi.create({
          email: formData.email,
          displayName: formData.displayName,
          role: formData.role
        });
        const newId = res.data?.id;
        if (newId && lobIds.length) {
          await Promise.all(lobIds.map((lobId) => lobsApi.addHeads(lobId, [newId])));
        }
        setSuccess('Admin user created successfully. They can sign in with Google SSO.');
      } else {
        await adminUsersApi.update(editingAdmin.id, {
          displayName: formData.displayName,
          role: formData.role
        });

        // Reconcile LOB head assignments (add newly selected, remove deselected).
        // If promoted to superadmin, lobIds is [] so all existing heads are removed.
        const current = (editingAdmin.lobs || []).map((l) => l.id);
        const toAdd = lobIds.filter((id) => !current.includes(id));
        const toRemove = current.filter((id) => !lobIds.includes(id));
        await Promise.all([
          ...toAdd.map((lobId) => lobsApi.addHeads(lobId, [editingAdmin.id])),
          ...toRemove.map((lobId) => lobsApi.removeHead(lobId, editingAdmin.id)),
        ]);
        setSuccess('Admin user updated successfully');
      }

      setShowModal(false);
      loadAdmins();
    } catch (err) {
      console.error('Failed to save admin:', err);
      setError(err.response?.data?.error || `Failed to ${modalMode} admin user`);
    }
  };

  const columns = [
    {
      key: 'display_name',
      label: 'Name',
      sortable: true,
    },
    {
      key: 'email',
      label: 'Email',
      sortable: true,
    },
    {
      key: 'role',
      label: 'Role',
      sortable: true,
      render: (value) => (
        <span
          className={`px-2 py-1 rounded text-xs font-semibold ${
            value === 'superadmin'
              ? 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200'
              : value === 'admin'
              ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
              : 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200'
          }`}
        >
          {value}
        </span>
      ),
    },
    {
      key: 'lobs',
      label: 'LOBs',
      sortable: false,
      render: (_, admin) =>
        admin.role === 'superadmin'
          ? <span className="text-xs text-gray-500">All (superadmin)</span>
          : (admin.lobs && admin.lobs.length
              ? <span className="text-xs">{admin.lobs.map((l) => l.name).join(', ')}</span>
              : <span className="text-xs text-amber-600 dark:text-amber-400">None — sees nothing</span>),
    },
    {
      key: 'last_login_at',
      label: 'Last Login',
      sortable: true,
      render: (value) => value ? new Date(value).toLocaleString() : 'Never',
    },
    {
      key: 'actions',
      label: 'Actions',
      sortable: false,
      render: (_, admin) => (
        <div className="flex gap-2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleEdit(admin);
            }}
            className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
            title="Edit"
          >
            <Edit2 className="w-4 h-4" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleDelete(admin);
            }}
            disabled={admin.id === user?.id}
            className="p-1 hover:bg-red-100 dark:hover:bg-red-900 rounded text-red-600 disabled:opacity-50 disabled:cursor-not-allowed"
            title={admin.id === user?.id ? 'Cannot delete yourself' : 'Delete'}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ),
    },
  ];

  // Role check
  if (user?.role !== 'superadmin') {
    return (
      <div className="card text-center py-12">
        <Shield className="w-12 h-12 mx-auto mb-4 text-red-500" />
        <h2 className="text-xl font-semibold mb-2">Access Denied</h2>
        <p className="text-gray-600 dark:text-gray-400">
          Only superadmin users can access settings and manage admin users.
        </p>
      </div>
    );
  }

  if (loading && admins.length === 0) {
    return (
      <div className="flex justify-center items-center h-64">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Settings</h1>
        <button
          onClick={handleCreate}
          className="flex items-center gap-2 px-4 py-2 rounded bg-primary-600 text-white hover:bg-primary-700"
        >
          <UserPlus className="w-4 h-4" />
          Add Admin User
        </button>
      </div>

      {error && (
        <ErrorBanner message={error} onClose={() => setError(null)} />
      )}
      
      {success && (
        <div className="mb-6 p-4 bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 rounded">
          {success}
          <button
            onClick={() => setSuccess(null)}
            className="float-right font-bold"
          >
            ×
          </button>
        </div>
      )}

      <div className="card mb-6">
        <h3 className="text-lg font-semibold mb-4">Admin Users</h3>
        <DataTable
          columns={columns}
          data={admins}
          loading={loading}
          emptyMessage="No admin users found"
          pagination={{
            page,
            limit: 20,
            totalCount,
            onPageChange: setPage,
          }}
        />
      </div>

      {/* Create/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-4">
              {modalMode === 'create' ? 'Add Admin User' : 'Edit Admin User'}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-4" autoComplete="off">
              <div>
                <label className="block text-sm font-medium mb-2">Email</label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  disabled={modalMode === 'edit'}
                  className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 disabled:bg-gray-100 dark:disabled:bg-gray-800"
                  autoComplete="off"
                  required
                />
                {modalMode === 'create' && (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    User will sign in with Google SSO using this email
                  </p>
                )}
              </div>
              
              <div>
                <label className="block text-sm font-medium mb-2">Display Name</label>
                <input
                  type="text"
                  value={formData.displayName}
                  onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                  className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
                  autoComplete="off"
                  required
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium mb-2">Role</label>
                <select
                  value={formData.role}
                  onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                  className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
                >
                  <option value="superadmin">Superadmin</option>
                  <option value="admin">Admin</option>
                  <option value="viewer">Viewer</option>
                </select>
              </div>

              {/* LOB assignment — only for non-superadmins (superadmin sees all) */}
              {formData.role !== 'superadmin' && (
                <div>
                  <label className="block text-sm font-medium mb-2">
                    Heads which LOB(s) <span className="text-red-500">*</span>
                  </label>
                  <div className="max-h-40 overflow-y-auto border border-gray-300 dark:border-gray-600 rounded p-2 space-y-1">
                    {lobs.length === 0 ? (
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        No LOBs yet — create one first under "Line of Businesses".
                      </p>
                    ) : (
                      lobs.map((lob) => (
                        <label key={lob.id} className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            type="checkbox"
                            checked={formData.lobIds.includes(lob.id)}
                            onChange={(e) =>
                              setFormData((f) => ({
                                ...f,
                                lobIds: e.target.checked
                                  ? [...f.lobIds, lob.id]
                                  : f.lobIds.filter((id) => id !== lob.id),
                              }))
                            }
                          />
                          {lob.name}
                        </label>
                      ))
                    )}
                  </div>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    This user will only see data for the LOB(s) selected here.
                  </p>
                </div>
              )}

              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded bg-primary-600 text-white hover:bg-primary-700"
                >
                  {modalMode === 'create' ? 'Create' : 'Update'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        isOpen={showDeleteDialog}
        title="Delete Admin User"
        message={`Are you sure you want to delete ${deletingAdmin?.display_name}? This action cannot be undone.`}
        onConfirm={confirmDelete}
        onCancel={() => setShowDeleteDialog(false)}
      />
    </div>
  );
}

export default SettingsPage;
