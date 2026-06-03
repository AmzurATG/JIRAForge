/**
 * Reports Page
 * 
 * Generate and export activity reports as CSV or PDF.
 */

import { useState, useEffect } from 'react';
import { FileText, FileDown, File } from 'lucide-react';
import { reportsApi } from '../api/reports';
import { employeesApi } from '../api/employees';
import DataTable from '../components/common/DataTable';
import DateRangePicker from '../components/common/DateRangePicker';
import LobFilter from '../components/common/LobFilter';
import EmployeeSelect from '../components/common/EmployeeSelect';
import ErrorBanner from '../components/common/ErrorBanner';
import { formatDate, formatDuration, formatDateTime } from '../utils/formatters';

const REPORT_TYPES = {
  'activity-logs': {
    label: 'Activity Logs',
    description: 'Detailed log of all employee activities with timestamps and applications',
  },
  'daily-summary': {
    label: 'Daily Summary',
    description: 'Aggregated productive and non-productive hours per day',
  },
  'employee-summary': {
    label: 'Employee Summary',
    description: 'Total hours and productivity percentage per employee',
  },
  'application-usage': {
    label: 'Application Usage',
    description: 'Time spent on each application across all employees',
  },
};

function ReportsPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [previewData, setPreviewData] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [exportingCSV, setExportingCSV] = useState(false);
  const [exportingPDF, setExportingPDF] = useState(false);
  
  // Report type
  const [reportType, setReportType] = useState('activity-logs');
  
  // Filters
  const [classification, setClassification] = useState('');
  const [selectedEmployee, setSelectedEmployee] = useState('');
  const [lobId, setLobId] = useState('');
  
  // Employee list for filter
  const [employees, setEmployees] = useState([]);
  
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
  }, [lobId]);

  const loadEmployees = async () => {
    try {
      const response = await employeesApi.getSimpleList(undefined, lobId || undefined);
      setEmployees(response.data || []);
    } catch (err) {
      console.error('Failed to load employees:', err);
    }
  };

  const handleGeneratePreview = async (newPage = 1) => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await reportsApi.getData({
        type: reportType,
        classification: classification || undefined,
        employee: selectedEmployee || undefined,
        lobId: lobId || undefined,
        from: dateRange.from,
        to: dateRange.to,
        page: newPage,
        limit: limit,
      });
      
      setPreviewData(response.data || []);
      setTotalCount(response.totalCount || 0);
      setPage(newPage);
    } catch (err) {
      console.error('Failed to generate report preview:', err);
      setError(err.response?.data?.error || 'Failed to generate report preview');
    } finally {
      setLoading(false);
    }
  };

  const handlePageChange = (newPage) => {
    handleGeneratePreview(newPage);
  };

  const handleExportCSV = async () => {
    setExportingCSV(true);
    setError(null);
    
    try {
      const blob = await reportsApi.exportCSV({
        type: reportType,
        classification: classification || undefined,
        employee: selectedEmployee || undefined,
        lobId: lobId || undefined,
        from: dateRange.from,
        to: dateRange.to,
      });
      
      // Create download link
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const timestamp = new Date().toISOString().split('T')[0];
      link.setAttribute('download', `${reportType}-${timestamp}.csv`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      
    } catch (err) {
      console.error('Failed to export CSV:', err);
      setError(err.response?.data?.error || 'Failed to export CSV');
    } finally {
      setExportingCSV(false);
    }
  };

  const handleExportPDF = async () => {
    setExportingPDF(true);
    setError(null);
    
    try {
      const blob = await reportsApi.exportPDF({
        type: reportType,
        classification: classification || undefined,
        employee: selectedEmployee || undefined,
        lobId: lobId || undefined,
        from: dateRange.from,
        to: dateRange.to,
      });
      
      // Create download link
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const timestamp = new Date().toISOString().split('T')[0];
      link.setAttribute('download', `${reportType}-${timestamp}.pdf`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      
    } catch (err) {
      console.error('Failed to export PDF:', err);
      setError(err.response?.data?.error || 'Failed to export PDF');
    } finally {
      setExportingPDF(false);
    }
  };

  // Dynamic columns based on report type
  const getColumns = () => {
    switch (reportType) {
      case 'daily-summary':
        return [
          { key: 'date', label: 'Date', sortable: true },
          { key: 'productiveHours', label: 'Productive Hours', sortable: true, render: (v) => v?.toFixed(2) || '0.00' },
          { key: 'nonProductiveHours', label: 'Non-Productive Hours', sortable: true, render: (v) => v?.toFixed(2) || '0.00' },
          { key: 'totalHours', label: 'Total Hours', sortable: true, render: (v) => v?.toFixed(2) || '0.00' },
          { key: 'productivityPercentage', label: 'Productivity %', sortable: true, render: (v) => `${v?.toFixed(1) || 0}%` },
          { key: 'employeeCount', label: 'Employees', sortable: true },
          { key: 'employees', label: 'Employee Names', sortable: false, render: (v) => v || 'N/A' },
        ];
      case 'employee-summary':
        return [
          { key: 'employeeName', label: 'Employee', sortable: true },
          { key: 'employeeEmail', label: 'Email', sortable: true },
          { key: 'productiveHours', label: 'Productive Hours', sortable: true, render: (v) => v?.toFixed(2) || '0.00' },
          { key: 'nonProductiveHours', label: 'Non-Productive Hours', sortable: true, render: (v) => v?.toFixed(2) || '0.00' },
          { key: 'totalHours', label: 'Total Hours', sortable: true, render: (v) => v?.toFixed(2) || '0.00' },
          { key: 'productivityPercentage', label: 'Productivity %', sortable: true, render: (v) => `${v?.toFixed(1) || 0}%` },
        ];
      case 'application-usage':
        return [
          { key: 'application', label: 'Application', sortable: true },
          { key: 'totalHours', label: 'Total Hours', sortable: true, render: (v) => v?.toFixed(2) || '0.00' },
          { key: 'sessionCount', label: 'Session Count', sortable: true },
          { key: 'employeeCount', label: 'Employees', sortable: true },
          { key: 'employees', label: 'Employee Names', sortable: false, render: (v) => v || 'N/A' },
        ];
      default: // activity-logs
        return [
          { key: 'userName', label: 'Employee', sortable: true },
          { key: 'startTime', label: 'Start Time', sortable: true, render: (value) => formatDateTime(value) },
          { key: 'endTime', label: 'End Time', sortable: true, render: (value) => formatDateTime(value) },
          { key: 'application', label: 'Application', sortable: true },
          { key: 'durationSeconds', label: 'Duration', sortable: true, render: (value) => formatDuration(value) },
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
    }
  };

  const columns = getColumns();

  return (
    <div className="space-y-3">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="page-title">Reports</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">Generate and export productivity reports</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={handleExportCSV}
            disabled={exportingCSV || previewData.length === 0}
            className="btn-success flex items-center gap-2"
          >
            <FileDown className="w-4 h-4" />
            {exportingCSV ? 'Exporting...' : 'Export CSV'}
          </button>
          <button
            onClick={handleExportPDF}
            disabled={exportingPDF || previewData.length === 0}
            className="btn-danger flex items-center gap-2"
          >
            <File className="w-4 h-4" />
            {exportingPDF ? 'Exporting...' : 'Export PDF'}
          </button>
        </div>
      </div>

      {error && (
        <ErrorBanner message={error} onClose={() => setError(null)} />
      )}

      {/* Report Configuration */}
      <div className="card-elevated">
        <h3 className="section-title mb-6">
          <div className="p-2 bg-primary-100 dark:bg-primary-900/30 rounded-lg">
            <FileText className="w-5 h-5 text-primary-600 dark:text-primary-400" />
          </div>
          Report Configuration
        </h3>
        
        <div className="space-y-3">
          {/* Report Configuration */}
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Report Configuration</h3>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
              {/* Report Type Filter */}
              <div>
                <label className="filter-label text-xs">Report Type</label>
                <select
                  value={reportType}
                  onChange={(e) => {
                    setReportType(e.target.value);
                    setPreviewData([]);
                    setPage(1);
                  }}
                  className="select-field"
                >
                  {Object.entries(REPORT_TYPES).map(([key, { label }]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              </div>

              {/* Classification Filter */}
            <div>
              <label className="filter-label text-xs">Classification</label>
              <select
                value={classification}
                onChange={(e) => setClassification(e.target.value)}
                className="select-field"
              >
                <option value="">All Classifications</option>
                <option value="productive">Productive</option>
                <option value="non-productive">Non-Productive</option>
              </select>
            </div>

            {/* Employee Filter — searchable (type to filter as you go) */}
            <div>
              <label className="filter-label text-xs">Employee</label>
              <EmployeeSelect
                employees={employees}
                value={selectedEmployee}
                onChange={setSelectedEmployee}
              />
            </div>

            {/* Date Range */}
            <div>
              <label className="filter-label text-xs">Date Range</label>
              <DateRangePicker
                from={dateRange.from}
                to={dateRange.to}
                onChange={setDateRange}
              />
            </div>

            {/* LOB Filter */}
            <LobFilter value={lobId} onChange={(v) => { setLobId(v); setSelectedEmployee(''); setPreviewData([]); setPage(1); }} />
          </div>
          </div>

          {/* Generate Button */}
          <button
            onClick={handleGeneratePreview}
            disabled={loading}
            className="btn-primary w-full flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Generating Preview...
              </>
            ) : (
              'Generate Preview'
            )}
          </button>
        </div>
      </div>

      {/* Preview */}
      {previewData.length > 0 && (
        <div className="card">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h3 className="section-title">Report Preview</h3>
            </div>
            <div className="badge-info">
              {REPORT_TYPES[reportType]?.label}
            </div>
          </div>
          
          <DataTable
            columns={columns}
            data={previewData}
            loading={loading}
            emptyMessage="No data available for the selected filters"
            pagination={{
              page: page,
              limit: limit,
              totalCount: totalCount,
              onPageChange: handlePageChange,
            }}
          />
        </div>
      )}

      {!loading && previewData.length === 0 && (
        <div className="card text-center py-16">
          <div className="w-20 h-20 mx-auto mb-6 bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-700 dark:to-gray-800 rounded-2xl flex items-center justify-center">
            <FileText className="w-10 h-10 text-gray-400 dark:text-gray-500" />
          </div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
            No Preview Generated
          </h3>
          <p className="text-gray-500 dark:text-gray-400 max-w-md mx-auto">
            Configure your report filters above and click "Generate Preview" to see the data before exporting.
          </p>
        </div>
      )}
    </div>
  );
}

export default ReportsPage;
