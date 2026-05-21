/**
 * Admin Users API
 */

import apiClient from './client';

export const adminUsersApi = {
  /**
   * Get admin users list.
   * 
   * @param {Object} params - { page, limit }
   * @returns {Promise<Object>}
   */
  async getList(params) {
    const response = await apiClient.get('/api/portal/admin-users', { params });
    return response.data;
  },

  /**
   * Create admin user.
   * 
   * @param {Object} data - { email, displayName, role }
   * @returns {Promise<Object>}
   */
  async create(data) {
    const response = await apiClient.post('/api/portal/admin-users', data);
    return response.data;
  },

  /**
   * Update admin user.
   * 
   * @param {string} userId 
   * @param {Object} data - { displayName, role }
   * @returns {Promise<Object>}
   */
  async update(userId, data) {
    const response = await apiClient.put(`/api/portal/admin-users/${userId}`, data);
    return response.data;
  },

  /**
   * Delete admin user.
   * 
   * @param {string} userId 
   * @returns {Promise<void>}
   */
  async delete(userId) {
    await apiClient.delete(`/api/portal/admin-users/${userId}`);
  },
};
