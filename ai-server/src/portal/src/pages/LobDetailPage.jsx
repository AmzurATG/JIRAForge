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
import { ArrowLeft, Plus, Trash2, Search, Shield } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { lobsApi } from '../api/lobs';
import { employeesApi } from '../api/employees';
import { adminUsersApi } from '../api/adminUsers';
import { lobAppClassificationsApi } from '../api/lobAppClassifications';
import DataTable from '../components/common/DataTable';
import ConfirmDialog from '../components/common/ConfirmDialog';
import ErrorBanner from '../components/common/ErrorBanner';
import { useDebounce } from '../hooks/useDebounce';

const CLASSIFICATION_OPTIONS = [
  { value: '', label: 'Use default' },
  { value: 'productive', label: 'Productive' },
  { value: 'non_productive', label: 'Non-Productive' },
  { value: 'private', label: 'Private' },
  { value: 'neutral', label: 'Neutral' },
];

function LobDetailPage() {
  const { lobId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isSuperadmin = user?.role === 'superadmin';

  const [tab, setTab] = useState('members');
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  // Non-superadmins (LOB heads) land directly on the app-classifications tab.
  useEffect(() => {
    if (!isSuperadmin) setTab('apps');
  }, [isSuperadmin]);

  const flash = (msg) => { setSuccess(msg); setTimeout(() => setSuccess(null), 2500); };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4">
        <button
          onClick={() => navigate(isSuperadmin ? '/lobs' : '/dashboard')}
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
        <TabButton id="apps" tab={tab} setTab={setTab}>App Classifications</TabButton>
      </div>

      {tab === 'members' && isSuperadmin && <MembersTab lobId={lobId} setError={setError} flash={flash} />}
      {tab === 'heads' && isSuperadmin && <HeadsTab lobId={lobId} setError={setError} flash={flash} />}
      {tab === 'apps' && <AppsTab lobId={lobId} setError={setError} flash={flash} />}
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
            const res = await lobsApi.addMembers(lobId, ids);
            flash(`Added ${res.addedCount} employee(s)`);
            setShowAdd(false);
            load();
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
            const res = await lobsApi.addHeads(lobId, ids);
            flash(`Added ${res.addedCount} head(s)`);
            setShowAdd(false);
            load();
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

function AppsTab({ lobId, setError, flash }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 400);

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
          <div className="font-medium">{v}</div>
          <div className="text-xs text-gray-500">{row.identifier} · {row.matchBy === 'url' ? 'website' : 'desktop'}</div>
        </div>
      ),
    },
    { key: 'defaultClassification', label: 'Org Default', sortable: true, render: (v) => (v ? badge(v) : <span className="text-xs text-gray-400">—</span>) },
    { key: 'effectiveClassification', label: 'Effective', sortable: true, render: (v) => badge(v) },
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
      <div className="flex justify-between items-center mb-3 gap-3">
        <h3 className="section-title">App Classifications</h3>
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
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        Set how this LOB classifies each app. "Use default" falls back to the org default, then Neutral.
      </p>
      <DataTable columns={columns} data={rows} loading={loading} emptyMessage="No applications in the catalog yet" />
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
