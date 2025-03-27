import React, { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Users from './pages/Users';
import UserDetail from './pages/UserDetail';
import Servers from './pages/Servers';
import ServerDetail from './pages/ServerDetail';
import Subscriptions from './pages/Subscriptions';
import Payments from './pages/Payments';
import Settings from './pages/Settings';
import { checkAuthStatus } from './services/auth';

const App: React.FC = () => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const navigate = useNavigate();

  useEffect(() => {
    const verifyAuth = async () => {
      try {
        const token = localStorage.getItem('adminToken');
        if (!token) {
          setIsAuthenticated(false);
          setIsLoading(false);
          return;
        }

        const isValid = await checkAuthStatus();
        setIsAuthenticated(isValid.status === 200);
      } catch (error) {
        console.error('Ошибка проверки аутентификации:', error);
        setIsAuthenticated(false);
        localStorage.removeItem('adminToken');
      } finally {
        setIsLoading(false);
      }
    };

    verifyAuth();
  }, [navigate]);

  if (isLoading) {
    return <div className="loading">Загрузка...</div>;
  }

  // Защищенный маршрут
  const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
    if (!isAuthenticated) {
      return <Navigate to="/login" replace />;
    }
    return <>{children}</>;
  };

  return (
    <Routes>
      <Route path="/login" element={
        isAuthenticated ? <Navigate to="/" replace /> : <Login onLoginSuccess={() => setIsAuthenticated(true)} />
      } />
      
      <Route path="/" element={
        <ProtectedRoute>
          <Layout />
        </ProtectedRoute>
      }>
        <Route index element={<Dashboard />} />
        <Route path="users" element={<Users />} />
        <Route path="users/:id" element={<UserDetail />} />
        <Route path="servers" element={<Servers />} />
        <Route path="servers/:id" element={<ServerDetail />} />
        <Route path="subscriptions" element={<Subscriptions />} />
        <Route path="payments" element={<Payments />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
};

export default App; 