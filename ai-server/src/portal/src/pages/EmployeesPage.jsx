/**
 * Employees Page
 * 
 * Employee list with search, filters, and pagination.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { employeesApi } from '../api/employees';
import DataTable from '../components/common/DataTable';
import DateRangePicker from '../components/common/DateRangePicker';
import LobFilter from '../components/common/LobFilter';
import ErrorBanner from '../components/common/ErrorBanner';
import { formatDate } from '../utils/formatters';
import { useDebounce } from '../hooks/useDebounce';

function EmployeesPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 500);
  const [productivityRange, setProductivityRange] = useState('');
  const [lobId, setLobId] = useState('');
  
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
  }, [page, debouncedSearch, productivityRange, dateRange, lobId]);

  const loadEmployees = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await employeesApi.getList({
        search: debouncedSearch,
        productivityRange: productivityRange || undefined,
        lobId: lobId || undefined,
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
      key: 'lastActivityAt',
      label: 'Last Activity',
      sortable: true,
      render: (value) => value ? new Date(value).toLocaleDateString() : 'N/A',
    },
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

        {/* Date Range + LOB */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="filter-label">Date Range</label>
            <DateRangePicker
              from={dateRange.from}
              to={dateRange.to}
              onChange={handleDateRangeChange}
            />
          </div>
          <LobFilter value={lobId} onChange={(v) => { setLobId(v); setPage(1); }} />
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
    </div>
  );
}

export default EmployeesPage;
