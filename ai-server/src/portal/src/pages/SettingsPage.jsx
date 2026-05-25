/**
 * Settings Page (Admin User Management)
 * 
 * Manage portal admin users (superadmin only).
 */

import { useState, useEffect } from 'react';
import { UserPlus, Edit2, Trash2, Shield, Key } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { adminUsersApi } from '../api/adminUsers';
import { authApi } from '../api/auth';
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
  
  // Create/Edit modal
  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState('create'); // 'create' or 'edit'
  const [editingAdmin, setEditingAdmin] = useState(null);
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    displayName: '',
    role: 'admin'
  });
  
  // Delete confirmation
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deletingAdmin, setDeletingAdmin] = useState(null);
  
  // Change password
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [passwordData, setPasswordData] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: ''
  });

  // Admin reset password (for other users)
  const [showAdminResetModal, setShowAdminResetModal] = useState(false);
  const [resetTargetUser, setResetTargetUser] = useState(null);
  const [adminResetPassword, setAdminResetPassword] = useState('');
  const [adminResetConfirm, setAdminResetConfirm] = useState('');

  useEffect(() => {
    // Only load admins if user is superadmin
    if (user?.role === 'superadmin') {
      loadAdmins();
    } else {
      setLoading(false);
    }
  }, [page, user?.role]);

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
    setFormData({ email: '', password: '', displayName: '', role: 'admin' });
    setShowModal(true);
  };

  const handleEdit = (admin) => {
    setModalMode('edit');
    setEditingAdmin(admin);
    setFormData({
      email: admin.email,
      password: '',
      displayName: admin.display_name,
      role: admin.role
    });
    setShowModal(true);
  };

  const handleResetPassword = (admin) => {
    setResetTargetUser(admin);
    setAdminResetPassword('');
    setAdminResetConfirm('');
    setShowAdminResetModal(true);
  };

  const handleAdminResetSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    
    if (adminResetPassword !== adminResetConfirm) {
      setError('Passwords do not match');
      return;
    }
    
    if (adminResetPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    
    try {
      await authApi.adminResetPassword(resetTargetUser.id, adminResetPassword);
      setSuccess(`Password reset successfully for ${resetTargetUser.display_name}`);
      setShowAdminResetModal(false);
      setResetTargetUser(null);
      setAdminResetPassword('');
      setAdminResetConfirm('');
    } catch (err) {
      console.error('Failed to reset password:', err);
      setError(err.response?.data?.error || 'Failed to reset password');
    }
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
    
    try {
      if (modalMode === 'create') {
        if (!formData.email || !formData.password || !formData.displayName) {
          setError('All fields are required');
          return;
        }
        
        await adminUsersApi.create({
          email: formData.email,
          password: formData.password,
          displayName: formData.displayName,
          role: formData.role
        });
        setSuccess('Admin user created successfully');
      } else {
        await adminUsersApi.update(editingAdmin.id, {
          displayName: formData.displayName,
          role: formData.role
        });
        setSuccess('Admin user updated successfully');
      }
      
      setShowModal(false);
      loadAdmins();
    } catch (err) {
      console.error('Failed to save admin:', err);
      setError(err.response?.data?.error || `Failed to ${modalMode} admin user`);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setError(null);
    
    if (passwordData.newPassword !== passwordData.confirmPassword) {
      setError('New passwords do not match');
      return;
    }
    
    if (passwordData.newPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    
    try {
      await authApi.changePassword({
        currentPassword: passwordData.currentPassword,
        newPassword: passwordData.newPassword
      });
      
      setSuccess('Password changed successfully');
      setShowPasswordModal(false);
      setPasswordData({ currentPassword: '', newPassword: '', confirmPassword: '' });
    } catch (err) {
      console.error('Failed to change password:', err);
      setError(err.response?.data?.error || 'Failed to change password');
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
              handleResetPassword(admin);
            }}
            className="p-1 hover:bg-blue-100 dark:hover:bg-blue-900 rounded text-blue-600"
            title="Reset Password"
          >
            <Key className="w-4 h-4" />
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
        <div className="flex gap-2">
          <button
            onClick={() => setShowPasswordModal(true)}
            className="flex items-center gap-2 px-4 py-2 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            <Key className="w-4 h-4" />
            Change Password
          </button>
          <button
            onClick={handleCreate}
            className="flex items-center gap-2 px-4 py-2 rounded bg-primary-600 text-white hover:bg-primary-700"
          >
            <UserPlus className="w-4 h-4" />
            Add Admin User
          </button>
        </div>
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
              </div>
              
              {modalMode === 'create' && (
                <div>
                  <label className="block text-sm font-medium mb-2">Password</label>
                  <input
                    type="password"
                    value={formData.password}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
                    autoComplete="new-password"
                    required
                    minLength={8}
                  />
                </div>
              )}
              
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

      {/* Change Password Modal */}
      {showPasswordModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-4">Change Password</h3>
            <form onSubmit={handleChangePassword} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">Current Password</label>
                <input
                  type="password"
                  value={passwordData.currentPassword}
                  onChange={(e) => setPasswordData({ ...passwordData, currentPassword: e.target.value })}
                  className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
                  required
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium mb-2">New Password</label>
                <input
                  type="password"
                  value={passwordData.newPassword}
                  onChange={(e) => setPasswordData({ ...passwordData, newPassword: e.target.value })}
                  className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
                  required
                  minLength={8}
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium mb-2">Confirm New Password</label>
                <input
                  type="password"
                  value={passwordData.confirmPassword}
                  onChange={(e) => setPasswordData({ ...passwordData, confirmPassword: e.target.value })}
                  className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
                  required
                  minLength={8}
                />
              </div>
              
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowPasswordModal(false)}
                  className="px-4 py-2 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded bg-primary-600 text-white hover:bg-primary-700"
                >
                  Change Password
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Admin Reset Password Modal */}
      {showAdminResetModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h2 className="text-xl font-semibold mb-4">Reset Password</h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              Set a new password for <strong>{resetTargetUser?.display_name}</strong> ({resetTargetUser?.email})
            </p>
            
            {error && (
              <div className="mb-4 p-3 bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-200 rounded">
                {error}
              </div>
            )}
            
            <form onSubmit={handleAdminResetSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">New Password</label>
                <input
                  type="password"
                  value={adminResetPassword}
                  onChange={(e) => setAdminResetPassword(e.target.value)}
                  className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                  required
                  minLength={8}
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium mb-2">Confirm New Password</label>
                <input
                  type="password"
                  value={adminResetConfirm}
                  onChange={(e) => setAdminResetConfirm(e.target.value)}
                  className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
                  placeholder="Re-enter password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                />
              </div>
              
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => {
                    setShowAdminResetModal(false);
                    setResetTargetUser(null);
                    setAdminResetPassword('');
                    setAdminResetConfirm('');
                  }}
                  className="px-4 py-2 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-700"
                >
                  Reset Password
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
