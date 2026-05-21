/**
 * Reports Page
 * 
 * Generate and export activity reports as CSV.
 */

import { useState, useEffect } from 'react';
import { Download, FileText, Search } from 'lucide-react';
import { reportsApi } from '../api/reports';
import { employeesApi } from '../api/employees';
import DataTable from '../components/common/DataTable';
import DateRangePicker from '../components/common/DateRangePicker';
import ErrorBanner from '../components/common/ErrorBanner';
import { formatDate, formatDuration, formatDateTime } from '../utils/formatters';

function ReportsPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [previewData, setPreviewData] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [exporting, setExporting] = useState(false);
  
  // Report type (only activity-logs for now)
  const [reportType] = useState('activity-logs');
  
  // Filters
  const [classification, setClassification] = useState('');
  const [selectedEmployee, setSelectedEmployee] = useState('');
  
  // Employee list for filter
  const [employees, setEmployees] = useState([]);
  
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
  }, []);

  const loadEmployees = async () => {
    try {
      const to = new Date();
      const from = new Date();
      from.setDate(to.getDate() - 90);
      
      const response = await employeesApi.getList({
        from: formatDate(from),
        to: formatDate(to),
        page: 1,
        limit: 100,
      });
      setEmployees(response.data || []);
    } catch (err) {
      console.error('Failed to load employees:', err);
    }
  };

  const handleGeneratePreview = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await reportsApi.getData({
        type: reportType,
        classification: classification || undefined,
        employee: selectedEmployee || undefined,
        from: dateRange.from,
        to: dateRange.to,
      });
      
      setPreviewData(response.data || []);
      setTotalCount(response.totalCount || 0);
    } catch (err) {
      console.error('Failed to generate report preview:', err);
      setError(err.response?.data?.error || 'Failed to generate report preview');
    } finally {
      setLoading(false);
    }
  };

  const handleExportCSV = async () => {
    setExporting(true);
    setError(null);
    
    try {
      const blob = await reportsApi.exportCSV({
        type: reportType,
        classification: classification || undefined,
        employee: selectedEmployee || undefined,
        from: dateRange.from,
        to: dateRange.to,
      });
      
      // Create download link
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const timestamp = new Date().toISOString().split('T')[0];
      link.setAttribute('download', `activity-logs-${timestamp}.csv`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      
    } catch (err) {
      console.error('Failed to export CSV:', err);
      setError(err.response?.data?.error || 'Failed to export CSV');
    } finally {
      setExporting(false);
    }
  };

  const columns = [
    {
      key: 'userName',
      label: 'Employee',
      sortable: true,
    },
    {
      key: 'startTime',
      label: 'Start Time',
      sortable: true,
      render: (value) => formatDateTime(value),
    },
    {
      key: 'endTime',
      label: 'End Time',
      sortable: true,
      render: (value) => formatDateTime(value),
    },
    {
      key: 'application',
      label: 'Application',
      sortable: true,
    },
    {
      key: 'durationSeconds',
      label: 'Duration',
      sortable: true,
      render: (value) => formatDuration(value),
    },
    {
      key: 'classification',
      label: 'Classification',
      sortable: true,
      render: (value) => (
        <span
          className={`px-2 py-1 rounded text-xs font-semibold ${
            value === 'productive'
              ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
              : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
          }`}
        >
          {value || 'N/A'}
        </span>
      ),
    },
  ];

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Reports</h1>
        <button
          onClick={handleExportCSV}
          disabled={exporting || previewData.length === 0}
          className="flex items-center gap-2 px-4 py-2 rounded bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Download className="w-4 h-4" />
          {exporting ? 'Exporting...' : 'Export CSV'}
        </button>
      </div>

      {error && (
        <ErrorBanner message={error} onClose={() => setError(null)} />
      )}

      {/* Report Configuration */}
      <div className="card mb-6">
        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <FileText className="w-5 h-5" />
          Report Configuration
        </h3>
        
        <div className="space-y-4">
          {/* Report Type */}
          <div>
            <label className="block text-sm font-medium mb-2">Report Type</label>
            <select
              value={reportType}
              disabled
              className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 cursor-not-allowed"
            >
              <option value="activity-logs">Activity Logs</option>
            </select>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              More report types coming soon
            </p>
          </div>

          {/* Filters */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Classification Filter */}
            <div>
              <label className="block text-sm font-medium mb-2">Classification</label>
              <select
                value={classification}
                onChange={(e) => setClassification(e.target.value)}
                className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
              >
                <option value="">All</option>
                <option value="productive">Productive</option>
                <option value="non-productive">Non-Productive</option>
              </select>
            </div>

            {/* Employee Filter */}
            <div>
              <label className="block text-sm font-medium mb-2">Employee</label>
              <select
                value={selectedEmployee}
                onChange={(e) => setSelectedEmployee(e.target.value)}
                className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
              >
                <option value="">All Employees</option>
                {employees.map((emp) => (
                  <option key={emp.userId} value={emp.userId}>
                    {emp.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Date Range */}
          <div>
            <label className="block text-sm font-medium mb-2">Date Range</label>
            <DateRangePicker
              from={dateRange.from}
              to={dateRange.to}
              onChange={setDateRange}
            />
          </div>

          {/* Generate Button */}
          <button
            onClick={handleGeneratePreview}
            disabled={loading}
            className="w-full px-4 py-2 rounded bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Generating Preview...' : 'Generate Preview'}
          </button>
        </div>
      </div>

      {/* Preview */}
      {previewData.length > 0 && (
        <div>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold">Report Preview</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Showing first 20 rows of {totalCount} total records
              </p>
            </div>
          </div>
          
          <DataTable
            columns={columns}
            data={previewData}
            loading={loading}
            emptyMessage="No data available for the selected filters"
          />
        </div>
      )}

      {!loading && previewData.length === 0 && (
        <div className="card text-center py-12">
          <FileText className="w-12 h-12 mx-auto mb-4 text-gray-400" />
          <p className="text-gray-600 dark:text-gray-400">
            Configure your report filters and click "Generate Preview" to see the data
          </p>
        </div>
      )}
    </div>
  );
}

export default ReportsPage;
