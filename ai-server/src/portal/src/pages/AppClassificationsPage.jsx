/**
 * Application Classifications Page
 * 
 * Manage application whitelist/blacklist (admin/superadmin only).
 */

import { useState, useEffect } from 'react';
import { Plus, Edit2, Trash2, Shield, Upload, Filter, X, Sparkles } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { appClassificationsApi } from '../api/appClassifications';
import { appCatalogApi } from '../api/appCatalog';
import DataTable from '../components/common/DataTable';
import ConfirmDialog from '../components/common/ConfirmDialog';
import LoadingSpinner from '../components/common/LoadingSpinner';
import ErrorBanner from '../components/common/ErrorBanner';
import SuccessBanner from '../components/common/SuccessBanner';
import AppKindBadge from '../components/common/AppKindBadge';
import { useDebounce } from '../hooks/useDebounce';

function AppClassificationsPage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [classifications, setClassifications] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  
  // Filters — search is debounced so we don't fire a request per keystroke.
  const [filters, setFilters] = useState({
    classification: '',
    match_by: '',
    search: ''
  });
  const debouncedSearch = useDebounce(filters.search, 500);
  const [showFilters, setShowFilters] = useState(false);
  
  // Create/Edit modal
  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState('create'); // 'create' or 'edit'
  const [editingItem, setEditingItem] = useState(null);
  const [formData, setFormData] = useState({
    identifier: '',
    displayName: '',
    classification: 'productive',
    matchBy: 'process',
    projectKey: '',
    isDefault: false
  });
  
  // Bulk import modal
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkData, setBulkData] = useState('');

  // AI lookup (assistive only — same endpoint as the LOB Add Application
  // modal; manual entry always works when the flag is off/unavailable).
  const [lookupName, setLookupName] = useState('');
  const [aiAvailable, setAiAvailable] = useState(true);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiTried, setAiTried] = useState(false);
  const [suggestion, setSuggestion] = useState(null);

  const runAiLookup = async () => {
    const q = lookupName.trim();
    if (!q) return;
    setAiLoading(true);
    setAiTried(true);
    try {
      const res = await appCatalogApi.aiSuggest(q);
      if (!res || res.available === false) { setAiAvailable(false); setSuggestion(null); return; }
      setSuggestion(res.suggestions || null);
      if (res.suggestions) {
        setFormData((f) => ({
          ...f,
          displayName: f.displayName || res.suggestions.displayName || q,
          // This page's vocabulary has no 'neutral' — only apply a direct match.
          classification: ['productive', 'non_productive'].includes(res.suggestions.suggestedClassification)
            ? res.suggestions.suggestedClassification
            : f.classification,
        }));
      }
    } catch {
      setSuggestion(null); // advisory — keep the modal usable
    } finally {
      setAiLoading(false);
    }
  };

  const useAiIdentifier = (matchBy, identifier) => {
    setFormData((f) => ({
      ...f,
      matchBy,
      identifier,
      displayName: f.displayName || suggestion?.displayName || '',
    }));
  };
  
  // Delete confirmation
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deletingItem, setDeletingItem] = useState(null);

  useEffect(() => {
    if (['admin', 'superadmin'].includes(user?.role)) {
      loadClassifications();
    } else {
      setLoading(false);
    }
  }, [page, filters.classification, filters.match_by, debouncedSearch, user?.role]);

  const loadClassifications = async () => {
    setLoading(true);
    setError(null);

    try {
      const params = { page, limit: 50 };
      if (filters.classification) params.classification = filters.classification;
      if (filters.match_by) params.match_by = filters.match_by;
      if (debouncedSearch) params.search = debouncedSearch;
      
      const response = await appClassificationsApi.getList(params);
      setClassifications(response.data || []);
      setTotalCount(response.pagination?.totalCount || 0);
    } catch (err) {
      console.error('Failed to load app classifications:', err);
      setError(err.response?.data?.error || 'Failed to load application classifications');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = () => {
    setModalMode('create');
    setEditingItem(null);
    setFormData({
      identifier: '',
      displayName: '',
      classification: 'productive',
      matchBy: 'process',
      projectKey: '',
      isDefault: false
    });
    // Fresh AI lookup state per open (availability sticks once discovered off).
    setLookupName('');
    setSuggestion(null);
    setAiTried(false);
    setShowModal(true);
  };

  const handleEdit = (item) => {
    setModalMode('edit');
    setEditingItem(item);
    setFormData({
      identifier: item.identifier,
      displayName: item.display_name,
      classification: item.classification,
      matchBy: item.match_by,
      projectKey: item.project_key || '',
      isDefault: item.is_default
    });
    setShowModal(true);
  };

  const handleDelete = (item) => {
    setDeletingItem(item);
    setShowDeleteDialog(true);
  };

  const confirmDelete = async () => {
    try {
      await appClassificationsApi.delete(deletingItem.id);
      setSuccess('Application classification deleted successfully');
      setShowDeleteDialog(false);
      setDeletingItem(null);
      loadClassifications();
    } catch (err) {
      console.error('Failed to delete classification:', err);
      setError(err.response?.data?.error || 'Failed to delete application classification');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    
    try {
      if (modalMode === 'create') {
        if (!formData.identifier || !formData.displayName) {
          setError('Identifier and display name are required');
          return;
        }
        
        await appClassificationsApi.create(formData);
        setSuccess('Application classification created successfully');
      } else {
        await appClassificationsApi.update(editingItem.id, {
          displayName: formData.displayName,
          classification: formData.classification,
          isDefault: formData.isDefault
        });
        setSuccess('Application classification updated successfully');
      }
      
      setShowModal(false);
      loadClassifications();
    } catch (err) {
      console.error('Failed to save classification:', err);
      setError(err.response?.data?.error || `Failed to ${modalMode} application classification`);
    }
  };

  const handleBulkImport = async () => {
    setError(null);
    
    try {
      // Parse CSV (simple format: identifier,displayName,classification,matchBy,projectKey)
      const lines = bulkData.trim().split('\n');
      const data = lines.slice(1).map(line => {
        const [identifier, displayName, classification, matchBy, projectKey] = line.split(',').map(s => s.trim());
        return {
          identifier,
          displayName,
          classification: classification || 'productive',
          matchBy: matchBy || 'process',
          projectKey: projectKey || undefined,
          isDefault: false
        };
      }).filter(item => item.identifier && item.displayName);
      
      if (data.length === 0) {
        setError('No valid data found. Please check your CSV format.');
        return;
      }
      
      const response = await appClassificationsApi.bulkImport(data);
      setSuccess(`Bulk import completed: ${response.data.summary.successful} successful, ${response.data.summary.failed} failed`);
      setShowBulkModal(false);
      setBulkData('');
      loadClassifications();
    } catch (err) {
      console.error('Failed to bulk import:', err);
      setError(err.response?.data?.error || 'Failed to import application classifications');
    }
  };

  // Any filter change restarts from page 1 (the load effect picks it up).
  const updateFilter = (key, value) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  };

  const clearFilters = () => {
    setFilters({ classification: '', match_by: '', search: '' });
    setPage(1);
  };

  const getClassificationBadge = (classification) => {
    const colors = {
      productive: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
      non_productive: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
      private: 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200'
    };
    
    const labels = {
      productive: 'Productive',
      non_productive: 'Non-Productive',
      private: 'Private'
    };
    
    return (
      <span className={`px-2 py-1 rounded text-xs font-semibold ${colors[classification]}`}>
        {labels[classification]}
      </span>
    );
  };

  const columns = [
    {
      key: 'identifier',
      label: 'Identifier',
      sortable: true,
      render: (value, item) => (
        <div>
          <div className="font-medium">{value}</div>
          {item.is_default && (
            <span className="text-xs text-gray-500 dark:text-gray-400">Default</span>
          )}
        </div>
      )
    },
    {
      key: 'display_name',
      label: 'Display Name',
      sortable: true,
    },
    {
      key: 'classification',
      label: 'Classification',
      sortable: true,
      render: (value) => getClassificationBadge(value),
    },
    {
      key: 'match_by',
      label: 'Match By',
      sortable: true,
      render: (value) => <AppKindBadge matchBy={value} />,
    },
    {
      key: 'project_key',
      label: 'Scope',
      sortable: true,
      render: (value, item) => {
        if (value) return <span className="text-sm">Project: {value}</span>;
        if (item.organization_id) return <span className="text-sm">Organization</span>;
        return <span className="text-sm text-gray-500">Global</span>;
      },
    },
    {
      key: 'created_at',
      label: 'Created',
      sortable: true,
      render: (value) => new Date(value).toLocaleDateString(),
    },
    {
      key: 'actions',
      label: 'Actions',
      sortable: false,
      render: (_, item) => (
        <div className="flex gap-2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleEdit(item);
            }}
            className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
            title="Edit"
          >
            <Edit2 className="w-4 h-4" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleDelete(item);
            }}
            className="p-1 hover:bg-red-100 dark:hover:bg-red-900 rounded text-red-600"
            title="Delete"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ),
    },
  ];

  // Role check
  if (!['admin', 'superadmin'].includes(user?.role)) {
    return (
      <div className="card text-center py-12">
        <Shield className="w-12 h-12 mx-auto mb-4 text-red-500" />
        <h2 className="text-xl font-semibold mb-2">Access Denied</h2>
        <p className="text-gray-600 dark:text-gray-400">
          Only admin users can access application classifications.
        </p>
      </div>
    );
  }

  if (loading && classifications.length === 0) {
    return (
      <div className="flex justify-center items-center h-64">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
        <div>
          <h1 className="page-title">Application Classifications</h1>
          <p className="text-gray-500 dark:text-gray-400 text-xs mt-0.5">
            Manage whitelist and blacklist of applications
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`btn-secondary flex items-center gap-1.5 ${showFilters ? 'bg-primary-50 dark:bg-primary-900/20 border-primary-200 dark:border-primary-800' : ''}`}
          >
            <Filter className="w-3.5 h-3.5" />
            Filters
          </button>
          <button
            onClick={() => setShowBulkModal(true)}
            className="btn-secondary flex items-center gap-1.5"
          >
            <Upload className="w-3.5 h-3.5" />
            Bulk Import
          </button>
          <button
            onClick={handleCreate}
            className="btn-primary flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Classification
          </button>
        </div>
      </div>

      {/* Filters Panel */}
      {showFilters && (
        <div className="card-elevated">
          <div className="flex items-end gap-4 flex-wrap">
            <div className="flex-1 min-w-48">
              <label className="filter-label">Search</label>
              <input
                type="text"
                value={filters.search}
                onChange={(e) => updateFilter('search', e.target.value)}
                placeholder="Search identifier or display name..."
                className="input-field"
              />
            </div>
            <div className="w-44">
              <label className="filter-label">Classification</label>
              <select
                value={filters.classification}
                onChange={(e) => updateFilter('classification', e.target.value)}
                className="select-field"
              >
                <option value="">All</option>
                <option value="productive">Productive</option>
                <option value="non_productive">Non-Productive</option>
                <option value="private">Private</option>
              </select>
            </div>
            <div className="w-44">
              <label className="filter-label">Match By</label>
              <select
                value={filters.match_by}
                onChange={(e) => updateFilter('match_by', e.target.value)}
                className="select-field"
              >
                <option value="">All</option>
                <option value="process">Desktop app (process)</option>
                <option value="url">Website (URL)</option>
              </select>
            </div>
            <button onClick={clearFilters} className="btn-secondary">
              Clear
            </button>
          </div>
        </div>
      )}

      {error && (
        <ErrorBanner message={error} onClose={() => setError(null)} />
      )}

      {success && <SuccessBanner message={success} onClose={() => setSuccess(null)} />}

      <div className="card">
        <DataTable
          columns={columns}
          data={classifications}
          loading={loading}
          emptyMessage="No application classifications found"
          pagination={{
            page,
            limit: 50,
            totalCount,
            onPageChange: setPage,
          }}
        />
      </div>

      {/* Create/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold mb-4">
              {modalMode === 'create' ? 'Add Application Classification' : 'Edit Application Classification'}
            </h3>

            {modalMode === 'create' && aiAvailable && (
              <div className="mb-4 rounded-lg border border-dashed border-primary-300 dark:border-primary-800 bg-primary-50/40 dark:bg-primary-900/10 p-3">
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                  Not sure of the exact name? Let AI suggest the details
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={lookupName}
                    onChange={(e) => setLookupName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runAiLookup(); } }}
                    placeholder="App name, e.g. Notion"
                    className="w-full px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-sm"
                  />
                  <button
                    type="button"
                    onClick={runAiLookup}
                    disabled={aiLoading || !lookupName.trim()}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-primary-600 text-white text-sm hover:bg-primary-700 disabled:opacity-50 whitespace-nowrap"
                  >
                    <Sparkles className="w-4 h-4" /> {aiLoading ? 'Looking…' : 'Look up with AI'}
                  </button>
                </div>

                {aiTried && !aiLoading && !suggestion && (
                  <p className="text-xs text-gray-500 mt-2">No AI suggestion — fill in the fields manually below.</p>
                )}

                {suggestion && (
                  <div className="mt-3 text-sm">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{suggestion.displayName || lookupName}</span>
                      <span className="text-xs text-gray-500">suggests: {suggestion.suggestedClassification}</span>
                      <span className="text-xs text-gray-400">{Math.round((suggestion.confidence || 0) * 100)}% confidence</span>
                    </div>
                    {suggestion.rationale && <p className="text-xs text-gray-500 mt-1">{suggestion.rationale}</p>}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {(suggestion.processNames || []).map((p) => (
                        <button key={`p-${p}`} type="button" onClick={() => useAiIdentifier('process', p)}
                          className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-xs hover:bg-white dark:hover:bg-gray-800">
                          Use desktop: <span className="font-medium">{p}</span>
                        </button>
                      ))}
                      {(suggestion.domains || []).map((d) => (
                        <button key={`d-${d}`} type="button" onClick={() => useAiIdentifier('url', d)}
                          className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-xs hover:bg-white dark:hover:bg-gray-800">
                          Use website: <span className="font-medium">{d}</span>
                        </button>
                      ))}
                    </div>
                    <p className="text-[10px] text-gray-400 mt-1">AI is a suggestion — edit anything below before creating.</p>
                  </div>
                )}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="filter-label">Identifier *</label>
                <input
                  type="text"
                  value={formData.identifier}
                  onChange={(e) => setFormData({ ...formData, identifier: e.target.value })}
                  disabled={modalMode === 'edit'}
                  placeholder="e.g., chrome.exe or google.com"
                  className="input-field disabled:bg-gray-100 dark:disabled:bg-gray-800"
                  required
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Process name or URL pattern to match
                </p>
              </div>

              <div>
                <label className="filter-label">Display Name *</label>
                <input
                  type="text"
                  value={formData.displayName}
                  onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                  placeholder="e.g., Google Chrome"
                  className="input-field"
                  required
                />
              </div>

              <div>
                <label className="filter-label">Classification *</label>
                <select
                  value={formData.classification}
                  onChange={(e) => setFormData({ ...formData, classification: e.target.value })}
                  className="select-field"
                >
                  <option value="productive">Productive</option>
                  <option value="non_productive">Non-Productive</option>
                  <option value="private">Private</option>
                </select>
              </div>

              <div>
                <label className="filter-label">Match By *</label>
                <select
                  value={formData.matchBy}
                  onChange={(e) => setFormData({ ...formData, matchBy: e.target.value })}
                  disabled={modalMode === 'edit'}
                  className="select-field disabled:bg-gray-100 dark:disabled:bg-gray-800"
                >
                  <option value="process">Desktop app (process name)</option>
                  <option value="url">Website (URL pattern)</option>
                </select>
              </div>

              <div>
                <label className="filter-label">Project Key (Optional)</label>
                <input
                  type="text"
                  value={formData.projectKey}
                  onChange={(e) => setFormData({ ...formData, projectKey: e.target.value })}
                  disabled={modalMode === 'edit'}
                  placeholder="e.g., PROJ-123"
                  className="input-field disabled:bg-gray-100 dark:disabled:bg-gray-800"
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Leave empty for organization-wide or global classification
                </p>
              </div>
              
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="isDefault"
                  checked={formData.isDefault}
                  onChange={(e) => setFormData({ ...formData, isDefault: e.target.checked })}
                  className="rounded"
                />
                <label htmlFor="isDefault" className="text-sm">
                  Set as default classification
                </label>
              </div>
              
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

      {/* Bulk Import Modal */}
      {showBulkModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-2xl w-full mx-4">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold">Bulk Import Classifications</h3>
              <button onClick={() => setShowBulkModal(false)} className="text-gray-500 hover:text-gray-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="mb-4">
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                Paste CSV data with the following format (first line is header):
              </p>
              <pre className="text-xs bg-gray-100 dark:bg-gray-900 p-2 rounded">
                identifier,displayName,classification,matchBy,projectKey{'\n'}
                chrome.exe,Google Chrome,productive,process,{'\n'}
                facebook.com,Facebook,non_productive,url,
              </pre>
            </div>
            
            <textarea
              value={bulkData}
              onChange={(e) => setBulkData(e.target.value)}
              placeholder="Paste your CSV data here..."
              rows={10}
              className="input-field font-mono"
            />
            
            <div className="flex gap-2 justify-end mt-4">
              <button
                onClick={() => setShowBulkModal(false)}
                className="btn-secondary"
              >
                Cancel
              </button>
              <button
                onClick={handleBulkImport}
                disabled={!bulkData.trim()}
                className="btn-primary"
              >
                Import
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        isOpen={showDeleteDialog}
        title="Delete Application Classification"
        message={`Are you sure you want to delete "${deletingItem?.display_name}"? This action cannot be undone.`}
        onConfirm={confirmDelete}
        onCancel={() => setShowDeleteDialog(false)}
        confirmLabel="Delete"
      />
    </div>
  );
}

export default AppClassificationsPage;
