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
   * @returns {Promise<Object>} { token, user }
   */
  async login(email, password) {
    const response = await apiClient.post('/api/portal/auth/login', {
      email,
      password,
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

  /**
   * Request password reset (forgot password).
   * 
   * @param {string} email 
   * @returns {Promise<Object>}
   */
  async forgotPassword(email) {
    const response = await apiClient.post('/api/portal/auth/forgot-password', {
      email,
    });
    return response.data;
  },

  /**
   * Reset password with token.
   * 
   * @param {string} token 
   * @param {string} newPassword 
   * @returns {Promise<Object>}
   */
  async resetPassword(token, newPassword) {
    const response = await apiClient.post('/api/portal/auth/reset-password', {
      token,
      newPassword,
    });
    return response.data;
  },

  /**
   * Admin reset password for another user (superadmin only).
   * 
   * @param {string} targetUserId 
   * @param {string} newPassword 
   * @returns {Promise<Object>}
   */
  async adminResetPassword(targetUserId, newPassword) {
    const response = await apiClient.post('/api/portal/auth/admin-reset-password', {
      targetUserId,
      newPassword,
    });
    return response.data;
  },
};
