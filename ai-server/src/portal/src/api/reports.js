/**
 * Reports API
 */

import apiClient from './client';

export const reportsApi = {
  /**
   * Get report data preview.
   * 
   * @param {Object} params - { type, ...filters }
   * @returns {Promise<Object>}
   */
  async getData(params) {
    const response = await apiClient.get('/api/portal/reports/data', { params });
    return response.data;
  },

  /**
   * Export report as CSV.
   * 
   * @param {Object} params - { type, ...filters }
   * @returns {Promise<Blob>}
   */
  async exportCSV(params) {
    const response = await apiClient.get('/api/portal/reports/export/csv', {
      params,
      responseType: 'blob',
    });
    return response.data;
  },

  /**
   * Export report as PDF.
   * 
   * @param {Object} params - { type, ...filters }
   * @returns {Promise<Blob>}
   */
  async exportPDF(params) {
    const response = await apiClient.get('/api/portal/reports/export/pdf', {
      params,
      responseType: 'blob',
    });
    return response.data;
  },

  /**
   * Export report as XLSX.
   *
   * @param {Object} params - { type, ...filters }
   * @returns {Promise<Blob>}
   */
  async exportXLSX(params) {
    const response = await apiClient.get('/api/portal/reports/export/xlsx', {
      params,
      responseType: 'blob',
    });
    return response.data;
  },
};
