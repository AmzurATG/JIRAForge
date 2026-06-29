/**
 * Employees Page
 * 
 * Employee list with search, filters, and pagination.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, MapPin, Edit2, Building2 } from 'lucide-react';
import { employeesApi } from '../api/employees';
import { locationsApi } from '../api/locations';
import { useAuth } from '../contexts/AuthContext';
import DataTable from '../components/common/DataTable';
import DateRangePicker from '../components/common/DateRangePicker';
import LobFilter from '../components/common/LobFilter';
import ErrorBanner from '../components/common/ErrorBanner';
import SuccessBanner from '../components/common/SuccessBanner';
import { formatDate } from '../utils/formatters';
import { useDebounce } from '../hooks/useDebounce';

function EmployeesPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isSuperadmin = user?.role === 'superadmin';
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 500);
  const [productivityRange, setProductivityRange] = useState('');
  const [lobId, setLobId] = useState('');

  // Locations (WS-B): filter dropdown for everyone, edit modal for superadmin.
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState('');
  const [editingEmployee, setEditingEmployee] = useState(null); // row being edited
  const [editLocationId, setEditLocationId] = useState('');
  const [savingLocation, setSavingLocation] = useState(false);
  const [success, setSuccess] = useState(null);

  // Bulk selection (superadmin): selection persists across pages/filters so
  // the action-bar count reflects everything ticked, not just this page.
  const [selected, setSelected] = useState({}); // userId -> true
  const [bulkLocationId, setBulkLocationId] = useState('');
  const [bulkApplying, setBulkApplying] = useState(false);
  const selectedIds = Object.keys(selected);
  const allOnPageSelected = employees.length > 0 && employees.every((e) => selected[e.userId]);

  const toggleSelected = (userId) => {
    setSelected((s) => {
      const next = { ...s };
      if (next[userId]) delete next[userId];
      else next[userId] = true;
      return next;
    });
  };

  const togglePageSelection = (checked) => {
    setSelected((s) => {
      const next = { ...s };
      employees.forEach((e) => {
        if (checked) next[e.userId] = true;
        else delete next[e.userId];
      });
      return next;
    });
  };

  const applyBulkLocation = async () => {
    setBulkApplying(true);
    setError(null);
    try {
      const target = bulkLocationId === '__clear__' ? null : bulkLocationId;
      const res = await locationsApi.bulkAssign(selectedIds, target);
      const targetName = target ? (locations.find((l) => l.id === target)?.name || 'branch') : 'no branch';
      setSuccess(`Updated ${res.updatedCount} employee(s) → ${targetName}`);
      setSelected({});
      setBulkLocationId('');
      loadEmployees();
    } catch (err) {
      console.error('Bulk location assignment failed:', err);
      setError(err.response?.data?.error || 'Failed to assign location');
    } finally {
      setBulkApplying(false);
    }
  };

  useEffect(() => {
    // Include inactive: employees can stay assigned to a retired location, so
    // it must remain visible in the filter and in the edit modal (where it is
    // shown but not newly assignable).
    locationsApi.list({ includeInactive: true })
      .then((res) => setLocations(res.data || []))
      .catch((err) => console.error('Failed to load locations:', err));
  }, []);
  
  // Default to today (shown as the "Today" preset in the picker)
  const [dateRange, setDateRange] = useState(() => {
    const today = formatDate(new Date());
    return { from: today, to: today };
  });

  useEffect(() => {
    loadEmployees();
  }, [page, debouncedSearch, productivityRange, dateRange, lobId, locationId]);

  const loadEmployees = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await employeesApi.getList({
        search: debouncedSearch,
        productivityRange: productivityRange || undefined,
        lobId: lobId || undefined,
        locationId: locationId || undefined,
        from: dateRange.from,
        to: dateRange.to,
        page,
        limit: 10,
      });

      setEmployees(response.data || []);
      setTotalCount(response.pagination?.totalCount || 0);
    } catch (err) {
      console.error('Failed to load employees:', err);
      setError(err.response?.data?.error || 'Failed to load employees');
    } finally {
      setLoading(false);
    }
  };

  const openLocationEditor = (employee) => {
    setEditingEmployee(employee);
    setEditLocationId(employee.location?.id || '');
  };

  const saveLocation = async () => {
    // No-op save: skip the request. Matters when the current assignment is an
    // INACTIVE location — re-sending it would be rejected by the server (400),
    // even though nothing changed.
    if ((editLocationId || '') === (editingEmployee.location?.id || '')) {
      setEditingEmployee(null);
      return;
    }
    setSavingLocation(true);
    setError(null);
    try {
      await locationsApi.setEmployeeLocation(editingEmployee.userId, editLocationId || null);
      setEditingEmployee(null);
      loadEmployees();
    } catch (err) {
      console.error('Failed to update location:', err);
      setError(err.response?.data?.error || 'Failed to update employee location');
    } finally {
      setSavingLocation(false);
    }
  };

  const handleRowClick = (employee) => {
    navigate(`/employees/${employee.userId}`);
  };

  const handleSearchChange = (e) => {
    setSearch(e.target.value);
    setPage(1); // Reset to first page on search
  };

  const handleProductivityFilterChange = (range) => {
    setProductivityRange(range);
    setPage(1);
  };

  const handleDateRangeChange = (newRange) => {
    setDateRange(newRange);
    setPage(1);
  };

  const columns = [
    ...(isSuperadmin ? [{
      key: '_select',
      label: (
        <input
          type="checkbox"
          checked={allOnPageSelected}
          onChange={(e) => togglePageSelection(e.target.checked)}
          title="Select all on this page"
          className="w-3.5 h-3.5 rounded border-gray-300 dark:border-gray-600"
        />
      ),
      sortable: false,
      render: (_, row) => (
        <input
          type="checkbox"
          checked={!!selected[row.userId]}
          onClick={(e) => e.stopPropagation()}
          onChange={() => toggleSelected(row.userId)}
          className="w-3.5 h-3.5 rounded border-gray-300 dark:border-gray-600"
        />
      ),
    }] : []),
    {
      key: 'name',
      label: 'Name',
      sortable: true,
    },
    {
      key: 'email',
      label: 'Email',
      sortable: true,
    },
    {
      key: 'productiveHours',
      label: 'Productive Hours',
      sortable: true,
      render: (value) => value?.toFixed(2) || '0.00',
    },
    {
      key: 'nonProductiveHours',
      label: 'Non-Productive Hours',
      sortable: true,
      render: (value) => value?.toFixed(2) || '0.00',
    },
    {
      // Admin-assigned site/office (portal_locations). Renamed from "Location"
      // to "Branch" to disambiguate from the auto-detected Location column below.
      key: 'location',
      label: 'Branch',
      sortable: false,
      render: (value) =>
        value?.name ? (
          <span className="inline-flex items-center gap-1 text-xs text-gray-700 dark:text-gray-300">
            <Building2 className="w-3 h-3 text-gray-400" />
            {value.name}
          </span>
        ) : (
          <span className="text-xs text-gray-400">—</span>
        ),
    },
    {
      // Auto-detected location from the desktop app (user_location_log), latest
      // snapshot per user. City/country text only. "—" until detection data
      // exists for the user.
      key: 'detectedLocation',
      label: 'Location',
      sortable: false,
      render: (value) => {
        const parts = [value?.city, value?.country].filter(Boolean);
        return parts.length ? (
          <span className="inline-flex items-center gap-1 text-xs text-gray-700 dark:text-gray-300">
            <MapPin className="w-3 h-3 text-gray-400" />
            {parts.join(', ')}
          </span>
        ) : (
          <span className="text-xs text-gray-400">—</span>
        );
      },
    },
    {
      key: 'lastActivityAt',
      label: 'Last Activity',
      sortable: true,
      render: (value) => value ? new Date(value).toLocaleDateString() : 'N/A',
    },
    ...(isSuperadmin ? [{
      key: 'actions',
      label: '',
      sortable: false,
      render: (_, employee) => (
        <button
          onClick={(e) => {
            e.stopPropagation();
            openLocationEditor(employee);
          }}
          className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
          title="Edit employee branch"
        >
          <Edit2 className="w-4 h-4 text-gray-500" />
        </button>
      ),
    }] : []),
  ];

  return (
    <div className="space-y-3">
      {/* Page Header */}
      <div>
        <h1 className="page-title">Employees</h1>
        <p className="text-gray-500 dark:text-gray-400 text-xs mt-0.5">View and manage employee productivity metrics</p>
      </div>

      {error && (
        <ErrorBanner message={error} onClose={() => setError(null)} />
      )}

      {success && <SuccessBanner message={success} onClose={() => setSuccess(null)} />}

      {/* Filters */}
      <div className="card">
        <div className="space-y-4">
          {/* Search */}
          <div>
            <label className="filter-label">Search</label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search by name or email..."
                value={search}
                onChange={handleSearchChange}
                className="input-field pl-10"
              />
            </div>
          </div>

        {/* Productivity Range Filter */}
        <div>
          <label className="filter-label mb-2 block">Productivity Range</label>
          <div className="flex gap-2 items-center flex-wrap">
          <button
            onClick={() => handleProductivityFilterChange('')}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              productivityRange === ''
                ? 'bg-primary-600 text-white shadow-md'
                : 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:border-primary-300 hover:bg-primary-50 dark:hover:bg-primary-900/20'
            }`}
          >
            All
          </button>
          <button
            onClick={() => handleProductivityFilterChange('high')}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              productivityRange === 'high'
                ? 'bg-emerald-500 text-white shadow-md'
                : 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:border-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'
            }`}
          >
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
              High (≥70%)
            </span>
          </button>
          <button
            onClick={() => handleProductivityFilterChange('medium')}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              productivityRange === 'medium'
                ? 'bg-amber-500 text-white shadow-md'
                : 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:border-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/20'
            }`}
          >
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-amber-400"></span>
              Medium (50-70%)
            </span>
          </button>
          <button
            onClick={() => handleProductivityFilterChange('low')}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              productivityRange === 'low'
                ? 'bg-red-500 text-white shadow-md'
                : 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:border-red-300 hover:bg-red-50 dark:hover:bg-red-900/20'
            }`}
          >
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-red-400"></span>
              Low (&lt;50%)
            </span>
          </button>
          </div>
        </div>

        {/* Date Range + LOB + Location */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div>
            <label className="filter-label">Date Range</label>
            <DateRangePicker
              from={dateRange.from}
              to={dateRange.to}
              onChange={handleDateRangeChange}
            />
          </div>
          <LobFilter value={lobId} onChange={(v) => { setLobId(v); setPage(1); }} />
          {locations.length > 0 && (
            <div>
              <label className="filter-label text-xs flex items-center gap-1">
                <Building2 className="w-3 h-3" /> Branch
              </label>
              <select
                value={locationId}
                onChange={(e) => { setLocationId(e.target.value); setPage(1); }}
                className="select-field"
              >
                <option value="">All Branches</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.isActive ? loc.name : `${loc.name} (inactive)`}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        </div>
      </div>

      {/* Results Summary */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Showing <span className="font-semibold text-gray-900 dark:text-gray-100">{employees.length}</span> of <span className="font-semibold text-gray-900 dark:text-gray-100">{totalCount}</span> employees
        </p>
      </div>

      {/* Employees Table */}
      <div className="card p-0 overflow-hidden">
        <DataTable
          columns={columns}
          data={employees}
          loading={loading}
          emptyMessage="No employees found"
          onRowClick={handleRowClick}
          pagination={{
            page,
            limit: 10,
            totalCount,
            onPageChange: setPage,
          }}
        />
      </div>

      {/* Bulk action bar — appears on selection, stable position (superadmin) */}
      {isSuperadmin && selectedIds.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-gray-900 text-white rounded-xl shadow-2xl px-4 py-3 border border-gray-700">
          <span className="text-sm font-semibold whitespace-nowrap">{selectedIds.length} selected</span>
          <select
            value={bulkLocationId}
            onChange={(e) => setBulkLocationId(e.target.value)}
            className="text-sm rounded-lg bg-gray-800 border border-gray-700 text-white px-2 py-1.5"
          >
            <option value="">Assign branch…</option>
            {locations.filter((l) => l.isActive).map((loc) => (
              <option key={loc.id} value={loc.id}>{loc.name}</option>
            ))}
            <option value="__clear__">Remove branch</option>
          </select>
          <button
            onClick={applyBulkLocation}
            disabled={!bulkLocationId || bulkApplying}
            className="px-3 py-1.5 rounded-lg bg-primary-600 text-sm font-medium hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {bulkApplying ? 'Applying…' : 'Apply'}
          </button>
          <button
            onClick={() => { setSelected({}); setBulkLocationId(''); }}
            className="text-sm text-gray-300 hover:text-white whitespace-nowrap"
          >
            Clear
          </button>
        </div>
      )}

      {/* Edit Employee Location Modal (superadmin) */}
      {editingEmployee && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-sm w-full mx-4">
            <h3 className="text-lg font-semibold mb-1">Edit Employee</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              {editingEmployee.name} · {editingEmployee.email}
            </p>
            <label className="filter-label">Branch</label>
            <select
              value={editLocationId}
              onChange={(e) => setEditLocationId(e.target.value)}
              className="select-field w-full"
            >
              <option value="">No branch</option>
              {locations.map((loc) => (
                // Inactive locations are shown (so a current assignment still
                // displays correctly) but disabled — the server rejects NEW
                // assignments to inactive locations.
                <option key={loc.id} value={loc.id} disabled={!loc.isActive}>
                  {loc.isActive ? loc.name : `${loc.name} (inactive)`}
                </option>
              ))}
            </select>
            {locations.length === 0 && (
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                No branches yet — create them under Settings.
              </p>
            )}
            <div className="flex gap-2 justify-end mt-5">
              <button
                onClick={() => setEditingEmployee(null)}
                className="btn-secondary"
              >
                Cancel
              </button>
              <button
                onClick={saveLocation}
                disabled={savingLocation}
                className="btn-primary"
              >
                {savingLocation ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default EmployeesPage;
