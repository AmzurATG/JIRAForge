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
import ErrorBanner from '../components/common/ErrorBanner';
import { formatDate } from '../utils/formatters';

function EmployeesPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [productivityRange, setProductivityRange] = useState('');
  
  // Default to last 30 days
  const [dateRange, setDateRange] = useState(() => {
    const to = new Date();
    const from = new Date();
    from.setDate(to.getDate() - 30);
    return {
      from: formatDate(from),
      to: formatDate(to),
    };
  });

  useEffect(() => {
    loadEmployees();
  }, [page, search, productivityRange, dateRange]);

  const loadEmployees = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await employeesApi.getList({
        search,
        productivityRange: productivityRange || undefined,
        from: dateRange.from,
        to: dateRange.to,
        page,
        limit: 20,
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
      render: (value) => value?.toFixed(1) || '0.0',
    },
    {
      key: 'nonProductiveHours',
      label: 'Non-Productive Hours',
      sortable: true,
      render: (value) => value?.toFixed(1) || '0.0',
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
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Employees</h1>
      </div>

      {error && (
        <ErrorBanner message={error} onClose={() => setError(null)} />
      )}

      {/* Filters */}
      <div className="mb-6 space-y-4">
        {/* Search */}
        <div className="flex gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search by name or email..."
              value={search}
              onChange={handleSearchChange}
              className="w-full pl-10 pr-4 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
            />
          </div>
        </div>

        {/* Productivity Range Filter */}
        <div className="flex gap-2 items-center">
          <span className="text-sm text-gray-600 dark:text-gray-400">Productivity:</span>
          <button
            onClick={() => handleProductivityFilterChange('')}
            className={`px-3 py-1.5 rounded text-sm ${
              productivityRange === ''
                ? 'bg-primary-600 text-white'
                : 'border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
          >
            All
          </button>
          <button
            onClick={() => handleProductivityFilterChange('high')}
            className={`px-3 py-1.5 rounded text-sm ${
              productivityRange === 'high'
                ? 'bg-primary-600 text-white'
                : 'border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
          >
            High (≥70%)
          </button>
          <button
            onClick={() => handleProductivityFilterChange('medium')}
            className={`px-3 py-1.5 rounded text-sm ${
              productivityRange === 'medium'
                ? 'bg-primary-600 text-white'
                : 'border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
          >
            Medium (50-70%)
          </button>
          <button
            onClick={() => handleProductivityFilterChange('low')}
            className={`px-3 py-1.5 rounded text-sm ${
              productivityRange === 'low'
                ? 'bg-primary-600 text-white'
                : 'border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
          >
            Low (&lt;50%)
          </button>
        </div>

        {/* Date Range */}
        <DateRangePicker
          from={dateRange.from}
          to={dateRange.to}
          onChange={handleDateRangeChange}
        />
      </div>

      {/* Employees Table */}
      <DataTable
        columns={columns}
        data={employees}
        loading={loading}
        emptyMessage="No employees found"
        onRowClick={handleRowClick}
        pagination={{
          page,
          limit: 20,
          totalCount,
          onPageChange: setPage,
        }}
      />
    </div>
  );
}

export default EmployeesPage;
