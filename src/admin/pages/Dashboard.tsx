import React, { useEffect, useState } from 'react';
import axios from 'axios';
import '../styles/dashboard.css';

interface DashboardStats {
  totalUsers: number;
  activeUsers: number;
  totalServers: number;
  activeSubscriptions: number;
  totalRevenue: number;
  currentMonthRevenue: number;
  pendingPayments: number;
}

const Dashboard: React.FC = () => {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        setIsLoading(true);
        const response = await axios.get('/api/stats/dashboard');
        setStats(response.data);
        setError(null);
      } catch (err: any) {
        setError('Ошибка при загрузке статистики: ' + (err.response?.data?.message || err.message));
      } finally {
        setIsLoading(false);
      }
    };

    fetchStats();
  }, []);

  if (isLoading) {
    return <div className="loading">Загрузка данных...</div>;
  }

  if (error) {
    return <div className="error-message">{error}</div>;
  }

  if (!stats) {
    return <div>Нет данных для отображения</div>;
  }

  return (
    <div className="dashboard">
      <h1 className="page-title">Дашборд</h1>
      
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-title">Всего пользователей</div>
          <div className="stat-value">{stats.totalUsers}</div>
        </div>
        
        <div className="stat-card">
          <div className="stat-title">Активные пользователи</div>
          <div className="stat-value">{stats.activeUsers}</div>
        </div>
        
        <div className="stat-card">
          <div className="stat-title">Количество серверов</div>
          <div className="stat-value">{stats.totalServers}</div>
        </div>
        
        <div className="stat-card">
          <div className="stat-title">Активные подписки</div>
          <div className="stat-value">{stats.activeSubscriptions}</div>
        </div>
      </div>
      
      <div className="stats-grid">
        <div className="stat-card highlight">
          <div className="stat-title">Общая выручка</div>
          <div className="stat-value">{stats.totalRevenue.toLocaleString()} ₽</div>
        </div>
        
        <div className="stat-card highlight">
          <div className="stat-title">Выручка за текущий месяц</div>
          <div className="stat-value">{stats.currentMonthRevenue.toLocaleString()} ₽</div>
        </div>
        
        <div className="stat-card">
          <div className="stat-title">Ожидающие оплаты</div>
          <div className="stat-value">{stats.pendingPayments}</div>
        </div>
      </div>
      
      {/* Здесь можно добавить графики или дополнительные блоки информации */}
    </div>
  );
};

export default Dashboard; 