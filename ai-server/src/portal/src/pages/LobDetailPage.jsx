/**
 * LOB Detail Page (superadmin: full management; LOB head: app classifications)
 *
 * Tabs:
 *   - Members             (superadmin assigns tracked employees to the LOB)
 *   - Heads               (superadmin assigns portal admins as heads)
 *   - App Classifications (superadmin or the LOB head classifies catalog apps)
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Search, X, Sparkles, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { lobsApi } from '../api/lobs';
import { employeesApi } from '../api/employees';
import { adminUsersApi } from '../api/adminUsers';
import { lobAppClassificationsApi } from '../api/lobAppClassifications';
import { appCatalogApi } from '../api/appCatalog';
import DataTable from '../components/common/DataTable';
import ConfirmDialog from '../components/common/ConfirmDialog';
import ErrorBanner from '../components/common/ErrorBanner';
import AppKindBadge from '../components/common/AppKindBadge';
import { useDebounce } from '../hooks/useDebounce';

const CLASSIFICATION_OPTIONS = [
  { value: '', label: 'Unclassified' },
  { value: 'productive', label: 'Productive' },
  { value: 'non_productive', label: 'Non-Productive' },
  { value: 'private', label: 'Private' },
  { value: 'neutral', label: 'Neutral' },
];

const CLASS_BADGE = {
  productive: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  non_productive: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  private: 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200',
  neutral: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
};

function LobDetailPage() {
  const { lobId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isSuperadmin = user?.role === 'superadmin';

  const [tab, setTab] = useState('members');
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  // "Apps used but not yet classified" — fetched once when the LOB opens so the
  // count badge is visible to superadmins (who land on Members) and heads alike,
  // and the AppsTab can show it without a manual scan.
  const [unlisted, setUnlisted] = useState(null); // null = not scanned yet
  const [unlistedLoading, setUnlistedLoading] = useState(false);

  const scanUnlisted = useCallback(async () => {
    setUnlistedLoading(true);
    try {
      const res = await lobAppClassificationsApi.listUnlisted(lobId);
      setUnlisted(res.data || []);
    } catch (err) {
      // Non-critical background scan — don't show a page-level error banner on
      // every LOB open (e.g. if the endpoint isn't deployed yet). It stays
      // retryable via the "Find used apps" button.
      console.error('[LobDetail] Failed to scan unlisted apps', err);
    } finally {
      setUnlistedLoading(false);
    }
  }, [lobId]);

  const removeUnlisted = useCallback((identifier) => {
    const id = (identifier || '').toLowerCase();
    setUnlisted((u) => (Array.isArray(u) ? u.filter((a) => a.identifier.toLowerCase() !== id) : u));
  }, []);

  // Non-superadmins (LOB heads) land directly on the app-classifications tab.
  useEffect(() => {
    if (!isSuperadmin) setTab('apps');
  }, [isSuperadmin]);

  // Auto-scan on open so admins/heads are shown what needs classifying.
  useEffect(() => { scanUnlisted(); }, [scanUnlisted]);

  const flash = (msg) => { setSuccess(msg); setTimeout(() => setSuccess(null), 2500); };

  const unlistedCount = unlisted ? unlisted.length : 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4">
        <button
          onClick={() => navigate('/lobs')}
          className="p-2.5 bg-white dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-xl border border-gray-200 dark:border-gray-700"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="page-title">Line of Business</h1>
          <p className="text-gray-500 dark:text-gray-400 text-xs">Members, heads &amp; per-LOB app classifications</p>
        </div>
      </div>

      {error && <ErrorBanner message={error} onClose={() => setError(null)} />}
      {success && (
        <div className="p-3 bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 rounded text-sm">{success}</div>
      )}

      <div className="flex gap-1 p-1 bg-gray-100 dark:bg-gray-800 rounded-xl w-fit">
        {isSuperadmin && <TabButton id="members" tab={tab} setTab={setTab}>Members</TabButton>}
        {isSuperadmin && <TabButton id="heads" tab={tab} setTab={setTab}>Heads</TabButton>}
        <TabButton id="apps" tab={tab} setTab={setTab}>
          App Classifications
          {unlistedCount > 0 && (
            <span
              title={`${unlistedCount} app(s) your team used aren't classified yet`}
              className="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
            >
              {unlistedCount}
            </span>
          )}
        </TabButton>
      </div>

      {tab === 'members' && isSuperadmin && <MembersTab lobId={lobId} setError={setError} flash={flash} />}
      {tab === 'heads' && isSuperadmin && <HeadsTab lobId={lobId} setError={setError} flash={flash} />}
      {tab === 'apps' && (
        <AppsTab
          lobId={lobId}
          setError={setError}
          flash={flash}
          unlisted={unlisted}
          unlistedLoading={unlistedLoading}
          onScan={scanUnlisted}
          onRemoveUnlisted={removeUnlisted}
        />
      )}
    </div>
  );
}

function TabButton({ id, tab, setTab, children }) {
  return (
    <button
      onClick={() => setTab(id)}
      className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
        tab === id ? 'bg-white dark:bg-gray-700 text-primary-600 dark:text-primary-400 shadow-md'
          : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
      }`}
    >
      {children}
    </button>
  );
}

// --- Members ----------------------------------------------------------------

function MembersTab({ lobId, setError, flash }) {
  const [members, setMembers] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [removing, setRemoving] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await lobsApi.listMembers(lobId, { page, limit: 10 });
      setMembers(res.data || []);
      setTotalCount(res.pagination?.totalCount || 0);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load members');
    } finally {
      setLoading(false);
    }
  }, [lobId, page, setError]);

  useEffect(() => { load(); }, [load]);

  const columns = [
    { key: 'name', label: 'Name', sortable: true },
    { key: 'email', label: 'Email', sortable: true },
    {
      key: 'actions', label: 'Actions', sortable: false,
      render: (_, row) => (
        <button onClick={() => setRemoving(row)} className="p-1 hover:bg-red-100 dark:hover:bg-red-900 rounded text-red-600" title="Remove from LOB">
          <Trash2 className="w-4 h-4" />
        </button>
      ),
    },
  ];

  return (
    <div className="card">
      <div className="flex justify-between items-center mb-3">
        <h3 className="section-title">Members ({totalCount})</h3>
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 px-3 py-1.5 rounded bg-primary-600 text-white text-sm hover:bg-primary-700">
          <Plus className="w-4 h-4" /> Add Employee
        </button>
      </div>

      <DataTable
        columns={columns}
        data={members}
        loading={loading}
        emptyMessage="No employees assigned to this LOB"
        pagination={{ page, limit: 10, totalCount, onPageChange: setPage }}
      />

      {showAdd && (
        <PeoplePickerModal
          title="Add Employees"
          fetchPeople={async (search) => {
            const res = await employeesApi.getSimpleList(search);
            return (res.data || []).map((e) => ({ id: e.userId, name: e.name, email: e.email }));
          }}
          onAdd={async (ids) => {
            try {
              const res = await lobsApi.addMembers(lobId, ids);
              flash(`Added ${res.addedCount} employee(s)`);
              setShowAdd(false);
              load();
            } catch (err) {
              setError(err.response?.data?.error || 'Failed to add employees');
            }
          }}
          onClose={() => setShowAdd(false)}
          setError={setError}
        />
      )}

      <ConfirmDialog
        isOpen={!!removing}
        title="Remove Member"
        message={`Remove ${removing?.name} from this LOB? (The employee and their activity are not deleted.)`}
        onConfirm={async () => {
          try {
            await lobsApi.removeMember(lobId, removing.userId);
            flash('Member removed');
            setRemoving(null);
            load();
          } catch (err) {
            setError(err.response?.data?.error || 'Failed to remove member');
          }
        }}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}

// --- Heads ------------------------------------------------------------------

function HeadsTab({ lobId, setError, flash }) {
  const [heads, setHeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [removing, setRemoving] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await lobsApi.listHeads(lobId);
      setHeads(res.data || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load heads');
    } finally {
      setLoading(false);
    }
  }, [lobId, setError]);

  useEffect(() => { load(); }, [load]);

  const columns = [
    { key: 'displayName', label: 'Name', sortable: true },
    { key: 'email', label: 'Email', sortable: true },
    { key: 'accountRole', label: 'Account Role', sortable: true },
    {
      key: 'actions', label: 'Actions', sortable: false,
      render: (_, row) => (
        <button onClick={() => setRemoving(row)} className="p-1 hover:bg-red-100 dark:hover:bg-red-900 rounded text-red-600" title="Remove as head">
          <Trash2 className="w-4 h-4" />
        </button>
      ),
    },
  ];

  return (
    <div className="card">
      <div className="flex justify-between items-center mb-3">
        <h3 className="section-title">Heads ({heads.length})</h3>
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 px-3 py-1.5 rounded bg-primary-600 text-white text-sm hover:bg-primary-700">
          <Plus className="w-4 h-4" /> Add Head
        </button>
      </div>

      <DataTable columns={columns} data={heads} loading={loading} emptyMessage="No heads assigned to this LOB" />

      {showAdd && (
        <PeoplePickerModal
          title="Add Heads"
          fetchPeople={async () => {
            const res = await adminUsersApi.getList({ page: 1, limit: 200 });
            return (res.data || []).map((a) => ({ id: a.id, name: a.display_name, email: a.email }));
          }}
          onAdd={async (ids) => {
            try {
              const res = await lobsApi.addHeads(lobId, ids);
              flash(`Added ${res.addedCount} head(s)`);
              setShowAdd(false);
              load();
            } catch (err) {
              setError(err.response?.data?.error || 'Failed to add heads');
            }
          }}
          onClose={() => setShowAdd(false)}
          setError={setError}
        />
      )}

      <ConfirmDialog
        isOpen={!!removing}
        title="Remove Head"
        message={`Remove ${removing?.displayName} as a head of this LOB?`}
        onConfirm={async () => {
          try {
            await lobsApi.removeHead(lobId, removing.adminId);
            flash('Head removed');
            setRemoving(null);
            load();
          } catch (err) {
            setError(err.response?.data?.error || 'Failed to remove head');
          }
        }}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}

// --- App classifications ----------------------------------------------------

function AppsTab({ lobId, setError, flash, unlisted, unlistedLoading, onScan, onRemoveUnlisted }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState('all'); // 'all' | 'process' | 'url'
  const debouncedSearch = useDebounce(search, 400);

  // Add-application modal state
  const [showAdd, setShowAdd] = useState(false);
  const [addPrefill, setAddPrefill] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await lobAppClassificationsApi.list(lobId, debouncedSearch ? { search: debouncedSearch } : {});
      setRows(res.data || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load app classifications');
    } finally {
      setLoading(false);
    }
  }, [lobId, debouncedSearch, setError]);

  useEffect(() => { load(); }, [load]);

  const openAddFor = (app) => {
    // Pre-fill the CLEANED name (from the server), never the raw identifier.
    setAddPrefill(app ? { identifier: app.identifier, matchBy: 'process', displayName: app.displayName || app.identifier } : null);
    setShowAdd(true);
  };

  const handleAdded = (row) => {
    flash(`Added ${row.displayName}`);
    setShowAdd(false);
    setAddPrefill(null);
    load();
    onRemoveUnlisted(row.identifier || '');
  };

  // One-step classify for a discovered app: create/reuse the catalog entry
  // (cleaned display name, no org default) + set this LOB's rule.
  const quickAdd = async (app, classification) => {
    const res = await lobAppClassificationsApi.addApp(lobId, {
      identifier: app.identifier,
      displayName: app.displayName || app.identifier,
      matchBy: 'process',
      classification,
    });
    handleAdded(res.data);
  };

  const handleChange = async (row, value) => {
    try {
      if (value === '') {
        if (row.lobClassification) await lobAppClassificationsApi.clear(lobId, row.appId);
      } else {
        await lobAppClassificationsApi.set(lobId, row.appId, value);
      }
      flash(`Updated ${row.displayName}`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update classification');
    }
  };

  const badge = (cls) => {
    const map = {
      productive: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
      non_productive: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
      private: 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200',
      neutral: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    };
    return <span className={`px-2 py-1 rounded text-xs font-semibold ${map[cls] || ''}`}>{cls}</span>;
  };

  const columns = [
    {
      key: 'displayName', label: 'Application', sortable: true,
      render: (v, row) => (
        <div>
          <div className="font-medium flex items-center gap-2">
            {v}
            <AppKindBadge matchBy={row.matchBy} />
          </div>
          <div className="text-xs text-gray-500">{row.identifier}</div>
        </div>
      ),
    },
    { key: 'defaultClassification', label: 'Org Default', sortable: true, render: (v) => (v ? badge(v) : <span className="text-xs text-gray-400">—</span>) },
    {
      key: 'effectiveClassification', label: 'Effective', sortable: true,
      // Unclassified until this LOB sets a rule — the org default is never applied.
      render: (v, row) => (row.isClassified ? badge(v) : <span className="text-xs text-gray-400">Unclassified</span>),
    },
    {
      key: 'lobClassification', label: 'This LOB', sortable: false,
      render: (v, row) => (
        <select
          value={v || ''}
          onChange={(e) => handleChange(row, e.target.value)}
          className="select-field"
        >
          {CLASSIFICATION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ),
    },
  ];

  return (
    <div className="card">
      <div className="flex justify-between items-center mb-3 gap-3 flex-wrap">
        <h3 className="section-title">App Classifications</h3>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex gap-1 p-0.5 bg-gray-100 dark:bg-gray-800 rounded-lg">
            {[['all', 'All'], ['process', 'Desktop'], ['url', 'Website']].map(([value, label]) => (
              <button
                key={value}
                onClick={() => setKindFilter(value)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                  kindFilter === value
                    ? 'bg-white dark:bg-gray-700 text-primary-600 dark:text-primary-400 shadow'
                    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search apps..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input-field pl-10"
            />
          </div>
          <button
            onClick={() => openAddFor(null)}
            className="flex items-center gap-2 px-3 py-1.5 rounded bg-primary-600 text-white text-sm hover:bg-primary-700 whitespace-nowrap"
          >
            <Plus className="w-4 h-4" /> Add Application
          </button>
        </div>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        Apps stay <span className="font-medium">Unclassified</span> (excluded from productivity) until you set a rule here. "Org Default" is a hint only — it is not applied automatically.
      </p>

      <UnlistedApps unlisted={unlisted} loading={unlistedLoading} onScan={onScan} onAdd={openAddFor} onQuickAdd={quickAdd} setError={setError} />

      <DataTable
        columns={columns}
        data={kindFilter === 'all' ? rows : rows.filter((r) => r.matchBy === kindFilter)}
        loading={loading}
        emptyMessage="No applications in the catalog yet"
      />

      {showAdd && (
        <AddAppModal
          lobId={lobId}
          prefill={addPrefill}
          onAdded={handleAdded}
          onClose={() => { setShowAdd(false); setAddPrefill(null); }}
          setError={setError}
        />
      )}
    </div>
  );
}

// "Apps used but not yet classified" — discovery from real activity.
// Each row offers one-step classification (select + Add) and a "Customize…"
// action that opens the full Add Application modal pre-filled.
function UnlistedApps({ unlisted, loading, onScan, onAdd, onQuickAdd, setError }) {
  const [collapsed, setCollapsed] = useState(false);
  const [quickSel, setQuickSel] = useState({}); // identifier -> chosen classification
  const [addingId, setAddingId] = useState(null); // identifier currently being added
  const hasItems = Array.isArray(unlisted) && unlisted.length > 0;

  const quickAdd = async (app) => {
    const classification = quickSel[app.identifier];
    if (!classification) return;
    setAddingId(app.identifier);
    try {
      await onQuickAdd(app, classification);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add application');
    } finally {
      setAddingId(null);
    }
  };

  return (
    <div className="mb-3 rounded-lg border border-dashed border-amber-300 dark:border-amber-800/60 bg-amber-50/40 dark:bg-amber-900/10 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-gray-600 dark:text-gray-400">
          Apps your team used recently that aren&apos;t classified yet{hasItems ? ` (${unlisted.length})` : ''}.
        </p>
        <div className="flex items-center gap-2">
          {hasItems && (
            <button
              onClick={() => setCollapsed((c) => !c)}
              className="flex items-center gap-1 px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              {collapsed ? <><Eye className="w-4 h-4" /> Show</> : <><EyeOff className="w-4 h-4" /> Hide</>}
            </button>
          )}
          <button
            onClick={() => { setCollapsed(false); onScan(); }}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 whitespace-nowrap"
          >
            <Sparkles className="w-4 h-4" /> {loading ? 'Scanning…' : (unlisted ? 'Rescan' : 'Find used apps')}
          </button>
        </div>
      </div>
      {!collapsed && unlisted && (
        unlisted.length === 0 ? (
          <p className="text-xs text-gray-500 mt-2">Nothing new — every app your team used is already in the catalog.</p>
        ) : (
          <div className="mt-2 max-h-60 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700/50">
            {unlisted.map((a) => (
              <div key={a.identifier} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                <div className="min-w-0">
                  <span className="font-medium flex items-center gap-2">
                    {a.displayName || a.identifier}
                    <AppKindBadge matchBy="process" />
                  </span>
                  <span className="text-xs text-gray-500">
                    {a.identifier} · {(a.totalHours || 0).toFixed(1)}h · {a.employeeCount} emp
                  </span>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <select
                    value={quickSel[a.identifier] || ''}
                    onChange={(e) => setQuickSel((s) => ({ ...s, [a.identifier]: e.target.value }))}
                    className="select-field text-xs py-1"
                  >
                    <option value="">Classify as…</option>
                    {CLASSIFICATION_OPTIONS.filter((o) => o.value).map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => quickAdd(a)}
                    disabled={!quickSel[a.identifier] || addingId === a.identifier}
                    className="flex items-center gap-1 px-2 py-1 rounded bg-primary-600 text-white text-xs hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Plus className="w-3 h-3" /> {addingId === a.identifier ? 'Adding…' : 'Add'}
                  </button>
                  <button
                    onClick={() => onAdd(a)}
                    className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
                    title="Open the full Add Application form (AI suggestions, website matching)"
                  >
                    Customize…
                  </button>
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

// Add a new application to this LOB (superadmin or head). Creates the catalog
// entry if needed and sets this LOB's classification in one step.
function AddAppModal({ lobId, prefill, onAdded, onClose, setError }) {
  const [form, setForm] = useState({
    identifier: prefill?.identifier || '',
    displayName: prefill?.displayName || '',
    matchBy: prefill?.matchBy || 'process',
    classification: '',
  });
  const [saving, setSaving] = useState(false);

  // AI lookup (assistive only; manual entry always works when off/unavailable).
  const [lookupName, setLookupName] = useState(prefill?.displayName || prefill?.identifier || '');
  const [aiAvailable, setAiAvailable] = useState(true);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiTried, setAiTried] = useState(false);
  const [suggestion, setSuggestion] = useState(null);

  // Opened from a discovered app → fire the AI lookup automatically so the
  // admin sees suggestions without an extra click. Flag off / failure is
  // handled by runLookup (panel hides, manual entry unaffected).
  useEffect(() => {
    if (prefill?.identifier) runLookup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runLookup = async () => {
    const q = lookupName.trim();
    if (!q) return;
    setAiLoading(true);
    setAiTried(true);
    try {
      const res = await appCatalogApi.aiSuggest(q);
      if (!res || res.available === false) { setAiAvailable(false); setSuggestion(null); return; }
      setSuggestion(res.suggestions || null);
      if (res.suggestions) {
        setForm((f) => ({
          ...f,
          displayName: f.displayName || res.suggestions.displayName || q,
          classification: res.suggestions.suggestedClassification || f.classification,
        }));
      }
    } catch (_) {
      setSuggestion(null); // advisory — keep the modal usable
    } finally {
      setAiLoading(false);
    }
  };

  const useSuggestion = (matchBy, identifier) => {
    setForm((f) => ({
      ...f,
      matchBy,
      identifier,
      displayName: f.displayName || suggestion?.displayName || '',
      classification: f.classification || suggestion?.suggestedClassification || '',
    }));
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.identifier.trim() || !form.displayName.trim()) {
      setError('Identifier and display name are required');
      return;
    }
    setSaving(true);
    try {
      const res = await lobAppClassificationsApi.addApp(lobId, {
        identifier: form.identifier.trim(),
        displayName: form.displayName.trim(),
        matchBy: form.matchBy,
        classification: form.classification, // '' = Unclassified (catalog entry only)
      });
      onAdded(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add application');
    } finally {
      setSaving(false);
    }
  };

  // Catalog rows are single-match_by, so "both" creates a desktop AND a website
  // entry, classified the same for this LOB.
  const addBoth = async (processName, domain) => {
    if (!form.displayName.trim()) { setError('Display name is required'); return; }
    setSaving(true);
    try {
      const dn = form.displayName.trim();
      const cls = form.classification;
      await lobAppClassificationsApi.addApp(lobId, { identifier: processName, displayName: dn, matchBy: 'process', classification: cls });
      const second = await lobAppClassificationsApi.addApp(lobId, { identifier: domain, displayName: dn, matchBy: 'url', classification: cls });
      onAdded(second.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add applications');
    } finally {
      setSaving(false);
    }
  };

  const s = suggestion;
  const hasBoth = !!(s && s.processNames && s.processNames.length && s.domains && s.domains.length);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold">Add Application</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700"><X className="w-5 h-5" /></button>
        </div>

        {aiAvailable && (
          <div className="mb-4 rounded-lg border border-dashed border-primary-300 dark:border-primary-800 bg-primary-50/40 dark:bg-primary-900/10 p-3">
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              Not sure of the exact name? Let AI suggest the details
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={lookupName}
                onChange={(e) => setLookupName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runLookup(); } }}
                placeholder="App name, e.g. Notion"
                className="input-field"
              />
              <button
                type="button"
                onClick={runLookup}
                disabled={aiLoading || !lookupName.trim()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-primary-600 text-white text-sm hover:bg-primary-700 disabled:opacity-50 whitespace-nowrap"
              >
                <Sparkles className="w-4 h-4" /> {aiLoading ? 'Looking…' : 'Look up with AI'}
              </button>
            </div>

            {aiTried && !aiLoading && !s && (
              <p className="text-xs text-gray-500 mt-2">No AI suggestion — fill in the fields manually below.</p>
            )}

            {s && (
              <div className="mt-3 text-sm">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{s.displayName || lookupName}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${CLASS_BADGE[s.suggestedClassification] || ''}`}>
                    {s.suggestedClassification}
                  </span>
                  <span className="text-xs text-gray-400">{Math.round((s.confidence || 0) * 100)}% confidence</span>
                </div>
                {s.rationale && <p className="text-xs text-gray-500 mt-1">{s.rationale}</p>}

                <div className="mt-2 flex flex-wrap gap-2">
                  {(s.processNames || []).map((p) => (
                    <button key={`p-${p}`} type="button" onClick={() => useSuggestion('process', p)}
                      className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-xs hover:bg-white dark:hover:bg-gray-800">
                      Use desktop: <span className="font-medium">{p}</span>
                    </button>
                  ))}
                  {(s.domains || []).map((d) => (
                    <button key={`d-${d}`} type="button" onClick={() => useSuggestion('url', d)}
                      className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-xs hover:bg-white dark:hover:bg-gray-800">
                      Use website: <span className="font-medium">{d}</span>
                    </button>
                  ))}
                </div>

                {hasBoth && (
                  <button
                    type="button"
                    onClick={() => addBoth(s.processNames[0], s.domains[0])}
                    disabled={saving}
                    className="mt-2 w-full px-3 py-1.5 rounded bg-primary-600 text-white text-xs hover:bg-primary-700 disabled:opacity-50"
                  >
                    Add both: {s.processNames[0]} (desktop) + {s.domains[0]} (website)
                  </button>
                )}
                <p className="text-[10px] text-gray-400 mt-1">AI is a suggestion — edit anything below before adding.</p>
              </div>
            )}
          </div>
        )}

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">Type</label>
            <select value={form.matchBy} onChange={(e) => setForm({ ...form, matchBy: e.target.value })} className="select-field">
              <option value="process">Desktop app (process)</option>
              <option value="url">Website (domain)</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Identifier *</label>
            <input
              type="text"
              value={form.identifier}
              onChange={(e) => setForm({ ...form, identifier: e.target.value })}
              placeholder={form.matchBy === 'url' ? 'e.g. notion.so' : 'e.g. slack.exe'}
              className="input-field"
              required
            />
            <p className="mt-1 text-xs text-gray-500">
              {form.matchBy === 'url' ? 'Domain that appears in the browser tab/title.' : 'Process/executable name as captured.'}
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Display name *</label>
            <input
              type="text"
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              placeholder="e.g. Slack"
              className="input-field"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Classification for this LOB</label>
            <select value={form.classification} onChange={(e) => setForm({ ...form, classification: e.target.value })} className="select-field">
              {CLASSIFICATION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="flex gap-2 justify-end pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 rounded bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50">
              {saving ? 'Adding…' : 'Add'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- shared people picker modal --------------------------------------------

function PeoplePickerModal({ title, fetchPeople, onAdd, onClose, setError }) {
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search, 400);
  const [people, setPeople] = useState([]);
  const [selected, setSelected] = useState({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      try {
        const list = await fetchPeople(debounced);
        if (active) setPeople(list);
      } catch (err) {
        if (active) setError(err.response?.data?.error || 'Failed to load people');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [debounced, fetchPeople, setError]);

  const toggle = (id) => setSelected((s) => ({ ...s, [id]: !s[id] }));
  const selectedIds = Object.keys(selected).filter((id) => selected[id]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-lg w-full mx-4">
        <h3 className="text-lg font-semibold mb-3">{title}</h3>
        <div className="relative mb-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search by name or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input-field pl-10"
            autoFocus
          />
        </div>
        <div className="max-h-72 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded">
          {loading ? (
            <p className="p-4 text-sm text-gray-500">Loading…</p>
          ) : people.length === 0 ? (
            <p className="p-4 text-sm text-gray-500">No people found</p>
          ) : (
            people.map((p) => (
              <label key={p.id} className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer border-b border-gray-100 dark:border-gray-700/50">
                <input type="checkbox" checked={!!selected[p.id]} onChange={() => toggle(p.id)} className="w-4 h-4" />
                <span className="text-sm">
                  <span className="font-medium">{p.name || p.email}</span>
                  {p.email && <span className="text-gray-500"> · {p.email}</span>}
                </span>
              </label>
            ))
          )}
        </div>
        <div className="flex gap-2 justify-end mt-4">
          <button onClick={onClose} className="px-4 py-2 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800">Cancel</button>
          <button
            disabled={selectedIds.length === 0}
            onClick={() => onAdd(selectedIds)}
            className="px-4 py-2 rounded bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Add {selectedIds.length || ''}
          </button>
        </div>
      </div>
    </div>
  );
}

export default LobDetailPage;
