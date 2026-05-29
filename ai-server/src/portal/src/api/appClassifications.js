/**
 * Application Classifications API
 */

import apiClient from './client';

export const appClassificationsApi = {
  /**
   * Get application classifications list.
   * 
   * @param {Object} params - { page, limit, classification, match_by, search }
   * @returns {Promise<Object>}
   */
  async getList(params) {
    const response = await apiClient.get('/api/portal/app-classifications', { params });
    return response.data;
  },

  /**
   * Create application classification.
   * 
   * @param {Object} data - { identifier, displayName, classification, matchBy, projectKey, isDefault }
   * @returns {Promise<Object>}
   */
  async create(data) {
    const response = await apiClient.post('/api/portal/app-classifications', data);
    return response.data;
  },

  /**
   * Update application classification.
   * 
   * @param {string} id 
   * @param {Object} data - { displayName, classification, isDefault }
   * @returns {Promise<Object>}
   */
  async update(id, data) {
    const response = await apiClient.put(`/api/portal/app-classifications/${id}`, data);
    return response.data;
  },

  /**
   * Delete application classification.
   * 
   * @param {string} id 
   * @returns {Promise<void>}
   */
  async delete(id) {
    await apiClient.delete(`/api/portal/app-classifications/${id}`);
  },

  /**
   * Bulk import application classifications.
   * 
   * @param {Array} data - [{ identifier, displayName, classification, matchBy, projectKey, isDefault }]
   * @returns {Promise<Object>}
   */
  async bulkImport(data) {
    const response = await apiClient.post('/api/portal/app-classifications/bulk-import', { data });
    return response.data;
  }
};

export default appClassificationsApi;
