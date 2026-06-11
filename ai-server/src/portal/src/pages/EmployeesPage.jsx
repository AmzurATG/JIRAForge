/**
 * Employees Page
 * 
 * Employee list with search, filters, and pagination.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, MapPin, Edit2 } from 'lucide-react';
import { employeesApi } from '../api/employees';
import { locationsApi } from '../api/locations';
import { useAuth } from '../contexts/AuthContext';
import DataTable from '../components/common/DataTable';
import DateRangePicker from '../components/common/DateRangePicker';
import LobFilter from '../components/common/LobFilter';
import ErrorBanner from '../components/common/ErrorBanner';
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

  useEffect(() => {
    locationsApi.list()
      .then((res) => setLocations(res.data || []))
      .catch((err) => console.error('Failed to load locations:', err));
  }, []);
  
  // Default to last 7 days
  const [dateRange, setDateRange] = useState(() => {
    const to = new Date();
    const from = new Date();
    from.setDate(to.getDate() - 7);
    return {
      from: formatDate(from),
      to: formatDate(to),
    };
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
      key: 'productivityPercentage',
      label: 'Productivity %',
      sortable: true,
      render: (value) => (
        <span
          className={`px-2 py-1 rounded text-xs font-semibold ${
            value >= 70
              ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
              : value >= 50
              ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
              : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
          }`}
        >
          {value?.toFixed(1) || '0.0'}%
        </span>
      ),
    },
    {
      key: 'location',
      label: 'Location',
      sortable: false,
      render: (value) =>
        value?.name ? (
          <span className="inline-flex items-center gap-1 text-xs text-gray-700 dark:text-gray-300">
            <MapPin className="w-3 h-3 text-gray-400" />
            {value.name}
          </span>
        ) : (
          <span className="text-xs text-gray-400">—</span>
        ),
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
          title="Edit employee location"
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
        <p className="text-gray-500 dark:text-gray-400 mt-1">View and manage employee productivity metrics</p>
      </div>

      {error && (
        <ErrorBanner message={error} onClose={() => setError(null)} />
      )}

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
                <MapPin className="w-3 h-3" /> Location
              </label>
              <select
                value={locationId}
                onChange={(e) => { setLocationId(e.target.value); setPage(1); }}
                className="select-field"
              >
                <option value="">All Locations</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>{loc.name}</option>
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

      {/* Edit Employee Location Modal (superadmin) */}
      {editingEmployee && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-sm w-full mx-4">
            <h3 className="text-lg font-semibold mb-1">Edit Employee</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              {editingEmployee.name} · {editingEmployee.email}
            </p>
            <label className="block text-sm font-medium mb-2">Location</label>
            <select
              value={editLocationId}
              onChange={(e) => setEditLocationId(e.target.value)}
              className="select-field w-full"
            >
              <option value="">No location</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>{loc.name}</option>
              ))}
            </select>
            {locations.length === 0 && (
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                No locations yet — create them under Settings.
              </p>
            )}
            <div className="flex gap-2 justify-end mt-5">
              <button
                onClick={() => setEditingEmployee(null)}
                className="px-4 py-2 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={saveLocation}
                disabled={savingLocation}
                className="px-4 py-2 rounded bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50"
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
