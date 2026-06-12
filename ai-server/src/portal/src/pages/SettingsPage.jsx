/**
 * Settings Page (Admin User Management)
 * 
 * Manage portal admin users (superadmin only).
 */

import { useState, useEffect } from 'react';
import { UserPlus, Edit2, Trash2, Shield, MapPin, Plus, Check, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { adminUsersApi } from '../api/adminUsers';
import { lobsApi } from '../api/lobs';
import { locationsApi } from '../api/locations';
import { employeesApi } from '../api/employees';
import DataTable from '../components/common/DataTable';
import ConfirmDialog from '../components/common/ConfirmDialog';
import LoadingSpinner from '../components/common/LoadingSpinner';
import ErrorBanner from '../components/common/ErrorBanner';
import SuccessBanner from '../components/common/SuccessBanner';
import PeoplePickerModal from '../components/common/PeoplePickerModal';

function SettingsPage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [admins, setAdmins] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [lobs, setLobs] = useState([]); // all LOBs (for assignment)
  const [lobsError, setLobsError] = useState(false); // true if the LOB picker failed to load

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

  // Load all LOBs (for the assignment multi-select). Include inactive LOBs so the
  // options match the admin-table prefill (which lists inactive headships too),
  // and surface load failures instead of showing a misleading "No LOBs yet".
  useEffect(() => {
    if (user?.role === 'superadmin') {
      setLobsError(false);
      lobsApi.list({ includeInactive: true })
        .then((res) => setLobs(res.data || []))
        .catch((err) => {
          console.error('[Settings] Failed to load LOBs for assignment', err);
          setLobsError(true);
        });
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
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="text-gray-500 dark:text-gray-400 text-xs mt-0.5">Manage portal admin users and employee locations</p>
        </div>
        <button
          onClick={handleCreate}
          className="btn-primary flex items-center gap-1.5"
        >
          <UserPlus className="w-3.5 h-3.5" />
          Add Admin User
        </button>
      </div>

      {error && (
        <ErrorBanner message={error} onClose={() => setError(null)} />
      )}

      {success && <SuccessBanner message={success} onClose={() => setSuccess(null)} />}

      <div className="card">
        <h3 className="section-title mb-4">Admin Users</h3>
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

      {/* Employee locations (WS-B) — managed list used by the Employees page */}
      <LocationsCard setError={setError} setSuccess={setSuccess} />

      {/* Create/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-4">
              {modalMode === 'create' ? 'Add Admin User' : 'Edit Admin User'}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-4" autoComplete="off">
              <div>
                <label className="filter-label">Email</label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  disabled={modalMode === 'edit'}
                  className="input-field disabled:bg-gray-100 dark:disabled:bg-gray-800"
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
                <label className="filter-label">Display Name</label>
                <input
                  type="text"
                  value={formData.displayName}
                  onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                  className="input-field"
                  autoComplete="off"
                  required
                />
              </div>

              <div>
                <label className="filter-label">Role</label>
                <select
                  value={formData.role}
                  onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                  className="select-field"
                >
                  <option value="superadmin">Superadmin</option>
                  <option value="admin">Admin</option>
                  <option value="viewer">Viewer</option>
                </select>
              </div>

              {/* LOB assignment — only for non-superadmins (superadmin sees all) */}
              {formData.role !== 'superadmin' && (
                <div>
                  <label className="filter-label">
                    Heads which LOB(s) <span className="text-red-500">*</span>
                  </label>
                  <div className="max-h-40 overflow-y-auto border border-gray-300 dark:border-gray-600 rounded p-2 space-y-1">
                    {lobsError ? (
                      <p className="text-xs text-red-500">
                        Couldn't load LOBs — close this dialog and try again.
                      </p>
                    ) : lobs.length === 0 ? (
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
                  className="btn-secondary"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
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
        confirmLabel="Delete"
      />
    </div>
  );
}

/**
 * Managed list of employee locations (superadmin only — the page already
 * gates access). Create / rename / activate-deactivate / delete; deleting a
 * location that is assigned to employees is rejected by the server (409).
 */
function LocationsCard({ setError, setSuccess }) {
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [deleting, setDeleting] = useState(null);
  const [assigning, setAssigning] = useState(null); // location whose members are being added

  const load = async () => {
    setLoading(true);
    try {
      const res = await locationsApi.list({ includeInactive: true });
      setLocations(res.data || []);
    } catch (err) {
      console.error('Failed to load locations:', err);
      setError(err.response?.data?.error || 'Failed to load locations');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const addLocation = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setAdding(true);
    setError(null);
    try {
      await locationsApi.create(newName.trim());
      setNewName('');
      setSuccess('Location created');
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create location');
    } finally {
      setAdding(false);
    }
  };

  const saveRename = async (loc) => {
    if (!editName.trim() || editName.trim() === loc.name) { setEditingId(null); return; }
    setError(null);
    try {
      await locationsApi.update(loc.id, { name: editName.trim() });
      setEditingId(null);
      setSuccess('Location renamed');
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to rename location');
    }
  };

  const toggleActive = async (loc) => {
    setError(null);
    try {
      await locationsApi.update(loc.id, { isActive: !loc.isActive });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update location');
    }
  };

  const confirmDelete = async () => {
    setError(null);
    try {
      await locationsApi.remove(deleting.id);
      setDeleting(null);
      setSuccess('Location deleted');
      load();
    } catch (err) {
      setDeleting(null);
      setError(err.response?.data?.error || 'Failed to delete location');
    }
  };

  return (
    <div className="card">
      <h3 className="section-title mb-1">
        <MapPin className="w-3.5 h-3.5 text-primary-600 dark:text-primary-400" /> Employee Locations
      </h3>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
        Locations are assigned to employees on the Employees page and drive its Location filter.
      </p>

      <form onSubmit={addLocation} className="flex gap-2 mb-4">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New location, e.g. Hyderabad"
          maxLength={120}
          className="input-field flex-1"
        />
        <button
          type="submit"
          disabled={adding || !newName.trim()}
          className="btn-primary flex items-center gap-1.5 whitespace-nowrap"
        >
          <Plus className="w-3.5 h-3.5" /> {adding ? 'Adding…' : 'Add Location'}
        </button>
      </form>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : locations.length === 0 ? (
        <p className="text-sm text-gray-500">No locations yet — add the first one above.</p>
      ) : (
        <div className="divide-y divide-gray-100 dark:divide-gray-700/50 border border-gray-200 dark:border-gray-700 rounded">
          {locations.map((loc) => (
            <div key={loc.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              {editingId === loc.id ? (
                <div className="flex items-center gap-2 flex-1">
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveRename(loc); } }}
                    maxLength={120}
                    className="input-field flex-1"
                    autoFocus
                  />
                  <button onClick={() => saveRename(loc)} className="p-1 rounded text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/30" title="Save">
                    <Check className="w-4 h-4" />
                  </button>
                  <button onClick={() => setEditingId(null)} className="p-1 rounded text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700" title="Cancel">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <>
                  <span className={loc.isActive ? '' : 'text-gray-400 line-through'}>
                    {loc.name}
                    {!loc.isActive && <span className="ml-2 text-[10px] uppercase text-gray-400 no-underline">inactive</span>}
                  </span>
                  <div className="flex items-center gap-1">
                    {loc.isActive && (
                      <button
                        onClick={() => setAssigning(loc)}
                        className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
                        title="Add employees to this location"
                      >
                        <UserPlus className="w-4 h-4 text-gray-500" />
                      </button>
                    )}
                    <button
                      onClick={() => { setEditingId(loc.id); setEditName(loc.name); }}
                      className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
                      title="Rename"
                    >
                      <Edit2 className="w-4 h-4 text-gray-500" />
                    </button>
                    <button
                      onClick={() => toggleActive(loc)}
                      className="px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
                    >
                      {loc.isActive ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      onClick={() => setDeleting(loc)}
                      className="p-1 rounded text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
                      title="Delete (only if unassigned)"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        isOpen={!!deleting}
        title="Delete Location"
        message={`Delete "${deleting?.name}"? This fails if any employee is assigned to it — deactivate instead to retire it.`}
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
        confirmLabel="Delete"
      />

      {/* Bulk member assignment — same picker pattern as LOB members */}
      {assigning && (
        <PeoplePickerModal
          title={`Add employees to ${assigning.name}`}
          fetchPeople={async (search) => {
            const res = await employeesApi.getSimpleList(search);
            return (res.data || []).map((e) => ({ id: e.userId, name: e.name, email: e.email }));
          }}
          onAdd={async (ids) => {
            try {
              const res = await locationsApi.bulkAssign(ids, assigning.id);
              setSuccess(`Assigned ${res.updatedCount} employee(s) to ${assigning.name}`);
              setAssigning(null);
            } catch (err) {
              setError(err.response?.data?.error || 'Failed to assign employees');
            }
          }}
          onClose={() => setAssigning(null)}
          setError={setError}
        />
      )}
    </div>
  );
}

export default SettingsPage;
