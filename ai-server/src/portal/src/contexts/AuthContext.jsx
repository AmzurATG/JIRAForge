import { createContext, useContext, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../api/auth';

const AuthContext = createContext(null);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    // Check for existing token on mount
    const token = localStorage.getItem('portal_token');
    const storedUser = localStorage.getItem('portal_user');
    
    if (token && storedUser) {
      try {
        setUser(JSON.parse(storedUser));
      } catch (error) {
        localStorage.removeItem('portal_token');
        localStorage.removeItem('portal_user');
      }
    }
    
    setLoading(false);
  }, []);

  const login = async (email, password, orgId) => {
    const response = await authApi.login(email, password, orgId);
    
    localStorage.setItem('portal_token', response.token);
    localStorage.setItem('portal_user', JSON.stringify(response.user));
    
    setUser(response.user);
    navigate('/dashboard');
  };

  const logout = async () => {
    await authApi.logout();
    setUser(null);
    navigate('/login');
  };

  const value = {
    user,
    loading,
    login,
    logout,
    isAuthenticated: !!user,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
