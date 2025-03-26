import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import axios from 'axios';

interface User {
  id: number;
  firstName: string;
  lastName: string;
  username: string;
  telegramId: string;
  isAdmin: boolean;
  isActive: boolean;
  createdAt: string;
  subscriptions: any[];
  payments: any[];
}

const UserDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchUserDetails = async () => {
      try {
        setIsLoading(true);
        const response = await axios.get(`/api/users/${id}`);
        setUser(response.data);
      } catch (err: any) {
        setError('Ошибка при загрузке информации о пользователе: ' + (err.response?.data?.message || err.message));
      } finally {
        setIsLoading(false);
      }
    };

    fetchUserDetails();
  }, [id]);

  if (isLoading) {
    return <div className="loading">Загрузка данных пользователя...</div>;
  }

  if (error) {
    return <div className="error-message">{error}</div>;
  }

  if (!user) {
    return <div>Пользователь не найден</div>;
  }

  return (
    <div className="user-detail-page">
      <div className="page-header">
        <h1 className="page-title">Пользователь #{user.id}</h1>
        <Link to="/users" className="btn btn-secondary">
          Назад к списку
        </Link>
      </div>

      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Основная информация</h2>
          <div className="status-badge">
            {user.isActive ? 'Активный' : 'Заблокирован'}
          </div>
        </div>
        
        <div className="user-info">
          <div className="info-group">
            <span className="label">Имя:</span>
            <span className="value">{user.firstName} {user.lastName}</span>
          </div>
          
          {user.username && (
            <div className="info-group">
              <span className="label">Имя пользователя:</span>
              <span className="value">@{user.username}</span>
            </div>
          )}
          
          <div className="info-group">
            <span className="label">Telegram ID:</span>
            <span className="value">{user.telegramId}</span>
          </div>
          
          <div className="info-group">
            <span className="label">Роль:</span>
            <span className="value">{user.isAdmin ? 'Администратор' : 'Пользователь'}</span>
          </div>
          
          <div className="info-group">
            <span className="label">Дата регистрации:</span>
            <span className="value">{new Date(user.createdAt).toLocaleString()}</span>
          </div>
        </div>
      </div>

      {/* Подписки пользователя */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Подписки</h2>
        </div>
        
        {user.subscriptions.length > 0 ? (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Сервер</th>
                  <th>Статус</th>
                  <th>Начало</th>
                  <th>Окончание</th>
                </tr>
              </thead>
              <tbody>
                {user.subscriptions.map(sub => (
                  <tr key={sub.id}>
                    <td>{sub.id}</td>
                    <td>{sub.vpnServer?.name || '-'}</td>
                    <td>{sub.status}</td>
                    <td>{new Date(sub.startDate).toLocaleDateString()}</td>
                    <td>{new Date(sub.endDate).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="no-data">У пользователя нет подписок</div>
        )}
      </div>

      {/* Платежи пользователя */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Платежи</h2>
        </div>
        
        {user.payments.length > 0 ? (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Сумма</th>
                  <th>Статус</th>
                  <th>Дата создания</th>
                  <th>Дата оплаты</th>
                </tr>
              </thead>
              <tbody>
                {user.payments.map(payment => (
                  <tr key={payment.id}>
                    <td>{payment.id}</td>
                    <td>{payment.amount} ₽</td>
                    <td>{payment.status}</td>
                    <td>{new Date(payment.createdAt).toLocaleString()}</td>
                    <td>{payment.confirmedAt ? new Date(payment.confirmedAt).toLocaleString() : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="no-data">У пользователя нет платежей</div>
        )}
      </div>
    </div>
  );
};

export default UserDetail; 