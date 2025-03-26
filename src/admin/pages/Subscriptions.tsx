import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';

interface Subscription {
  id: number;
  userId: number;
  serverId: number;
  status: string;
  startDate: string;
  endDate: string;
  createdAt: string;
  user: {
    id: number;
    firstName: string;
    lastName: string;
    telegramId: string;
  };
  vpnServer: {
    id: number;
    name: string;
  };
}

const Subscriptions: React.FC = () => {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<number>(1);
  const [totalPages, setTotalPages] = useState<number>(1);

  useEffect(() => {
    const fetchSubscriptions = async () => {
      try {
        setIsLoading(true);
        const response = await axios.get('/api/subscriptions', {
          params: { page, limit: 10 }
        });
        setSubscriptions(response.data.subscriptions);
        setTotalPages(response.data.totalPages);
        setError(null);
      } catch (err: any) {
        setError('Ошибка при загрузке подписок: ' + (err.response?.data?.message || err.message));
      } finally {
        setIsLoading(false);
      }
    };

    fetchSubscriptions();
  }, [page]);

  // Функция для форматирования дат
  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString();
  };

  // Обработчик отмены подписки
  const handleCancelSubscription = async (subscriptionId: number) => {
    if (!window.confirm('Вы уверены, что хотите отменить эту подписку?')) {
      return;
    }

    try {
      await axios.patch(`/api/subscriptions/${subscriptionId}/cancel`);
      
      // Обновляем статус подписки в локальном состоянии
      setSubscriptions(subscriptions.map(sub => {
        if (sub.id === subscriptionId) {
          return { ...sub, status: 'CANCELLED' };
        }
        return sub;
      }));
    } catch (err: any) {
      setError('Ошибка при отмене подписки: ' + (err.response?.data?.message || err.message));
    }
  };

  // Рендер пагинации
  const renderPagination = () => {
    const pages = [];
    for (let i = 1; i <= totalPages; i++) {
      pages.push(
        <button
          key={i}
          onClick={() => setPage(i)}
          className={page === i ? 'active' : ''}
        >
          {i}
        </button>
      );
    }
    
    return (
      <div className="pagination">
        <button 
          onClick={() => setPage(prev => Math.max(prev - 1, 1))} 
          disabled={page === 1}
        >
          &laquo;
        </button>
        {pages}
        <button 
          onClick={() => setPage(prev => Math.min(prev + 1, totalPages))} 
          disabled={page === totalPages}
        >
          &raquo;
        </button>
      </div>
    );
  };

  if (isLoading && subscriptions.length === 0) {
    return <div className="loading">Загрузка подписок...</div>;
  }

  return (
    <div className="subscriptions-page">
      <h1 className="page-title">Подписки</h1>
      
      {error && <div className="error-message">{error}</div>}
      
      <div className="filters">
        <div className="filter-group">
          <label>Статус:</label>
          <select defaultValue="all">
            <option value="all">Все</option>
            <option value="ACTIVE">Активные</option>
            <option value="PENDING">Ожидающие</option>
            <option value="EXPIRED">Истекшие</option>
            <option value="CANCELLED">Отмененные</option>
          </select>
        </div>
      </div>
      
      <div className="table-container">
        <table className="subscriptions-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Пользователь</th>
              <th>Сервер</th>
              <th>Статус</th>
              <th>Начало</th>
              <th>Окончание</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            {subscriptions.map(subscription => (
              <tr key={subscription.id} className={subscription.status !== 'ACTIVE' ? 'inactive-row' : ''}>
                <td>{subscription.id}</td>
                <td>
                  <Link to={`/users/${subscription.userId}`}>
                    {subscription.user.firstName} {subscription.user.lastName}
                  </Link>
                </td>
                <td>
                  <Link to={`/servers/${subscription.serverId}`}>
                    {subscription.vpnServer.name}
                  </Link>
                </td>
                <td>
                  <span className={`status-badge ${subscription.status.toLowerCase()}`}>
                    {subscription.status}
                  </span>
                </td>
                <td>{formatDate(subscription.startDate)}</td>
                <td>{formatDate(subscription.endDate)}</td>
                <td>
                  {subscription.status === 'ACTIVE' && (
                    <button 
                      className="btn btn-danger btn-sm"
                      onClick={() => handleCancelSubscription(subscription.id)}
                    >
                      Отменить
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      
      {subscriptions.length === 0 && (
        <div className="no-data">Подписки не найдены</div>
      )}
      
      {renderPagination()}
    </div>
  );
};

export default Subscriptions; 