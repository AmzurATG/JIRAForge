/**
 * Authentication API
 */

import apiClient from './client';

export const authApi = {
  /**
   * Login with email and password.
   * 
   * @param {string} email 
   * @param {string} password 
   * @param {string} orgId 
   * @returns {Promise<Object>} { token, user }
   */
  async login(email, password, orgId) {
    const response = await apiClient.post('/api/portal/auth/login', {
      email,
      password,
      orgId,
    });
    return response.data;
  },

  /**
   * Logout (clear token client-side).
   */
  async logout() {
    try {
      await apiClient.post('/api/portal/auth/logout');
    } catch (error) {
      // Ignore errors on logout
    }
    localStorage.removeItem('portal_token');
    localStorage.removeItem('portal_user');
  },

  /**
   * Change password.
   * 
   * @param {string} currentPassword 
   * @param {string} newPassword 
   * @returns {Promise<Object>}
   */
  async changePassword(currentPassword, newPassword) {
    const response = await apiClient.post('/api/portal/auth/change-password', {
      currentPassword,
      newPassword,
    });
    return response.data;
  },
};
