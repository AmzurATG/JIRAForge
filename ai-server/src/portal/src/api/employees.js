/**
 * Employees API
 */

import apiClient from './client';

export const employeesApi = {
  /**
   * Get simple employees list for dropdowns (lightweight, no metrics).
   * 
   * @param {string} search - Optional search term
   * @returns {Promise<Array>} [{userId, name, email}]
   */
  async getSimpleList(search, lobId) {
    const params = {};
    if (search) params.search = search;
    if (lobId) params.lobId = lobId;
    const response = await apiClient.get('/api/portal/employees/list', { params });
    return response.data;
  },

  /**
   * Get employees list.
   * 
   * @param {Object} params - { search, productivityRange, from, to, page, limit }
   * @returns {Promise<Object>}
   */
  async getList(params) {
    try {
      const response = await apiClient.get('/api/portal/employees', { params });
      return response.data;
    } catch (error) {
      // If timeout, provide more helpful error message
      if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        throw new Error('Query timeout: The database is taking longer than expected. Please try narrowing your date range or filters.');
      }
      throw error;
    }
  },

  /**
   * Get employee detail.
   * 
   * @param {string} userId 
   * @param {Object} params - { from, to }
   * @returns {Promise<Object>}
   */
  async getDetail(userId, params) {
    const response = await apiClient.get(`/api/portal/employees/${userId}`, { params });
    return response.data;
  },

  /**
   * Get employee logs.
   * 
   * @param {string} userId 
   * @param {Object} params - { classification, from, to, page, limit }
   * @returns {Promise<Object>}
   */
  async getLogs(userId, params) {
    const response = await apiClient.get(`/api/portal/employees/${userId}/logs`, { params });
    return response.data;
  },
};
