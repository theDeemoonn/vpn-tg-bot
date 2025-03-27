import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import '../styles/users.css';

interface User {
  id: number;
  firstName: string;
  lastName: string;
  username: string;
  telegramId: string;
  isAdmin: boolean;
  isActive: boolean;
  createdAt: string;
  activeSubscriptions: number;
}

interface UsersResponse {
  users: User[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

const Users: React.FC = () => {
  const [usersData, setUsersData] = useState<UsersResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<number>(1);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchTimeout, setSearchTimeout] = useState<NodeJS.Timeout | null>(null);

  const fetchUsers = async (currentPage: number, query: string = '') => {
    try {
      setIsLoading(true);
      const response = await axios.get('/api/users', {
        params: {
          page: currentPage,
          limit: 10,
          search: query || undefined
        }
      });
      setUsersData(response.data);
      setError(null);
    } catch (err: any) {
      setError('Ошибка при загрузке пользователей: ' + (err.response?.data?.message || err.message));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers(page, searchQuery);
  }, [page]);

  // Обработка изменения в поле поиска с задержкой
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const query = e.target.value;
    setSearchQuery(query);
    
    if (searchTimeout) {
      clearTimeout(searchTimeout);
    }
    
    const timeout = setTimeout(() => {
      setPage(1); // Сбрасываем на первую страницу при новом поиске
      fetchUsers(1, query);
    }, 500);
    
    setSearchTimeout(timeout);
  };

  // Обработка изменения статуса пользователя
  const handleStatusChange = async (userId: number, isActive: boolean) => {
    try {
      await axios.patch(`/api/users/${userId}/status`, { isActive });
      
      // Обновляем статус пользователя в локальном состоянии
      if (usersData) {
        const updatedUsers = usersData.users.map(user => {
          if (user.id === userId) {
            return { ...user, isActive };
          }
          return user;
        });
        
        setUsersData({
          ...usersData,
          users: updatedUsers
        });
      }
    } catch (err: any) {
      setError('Ошибка при изменении статуса пользователя: ' + (err.response?.data?.message || err.message));
    }
  };

  // Обработка изменения роли пользователя
  const handleAdminChange = async (userId: number, isAdmin: boolean) => {
    try {
      await axios.patch(`/api/users/${userId}/admin`, { isAdmin });
      
      // Обновляем роль пользователя в локальном состоянии
      if (usersData) {
        const updatedUsers = usersData.users.map(user => {
          if (user.id === userId) {
            return { ...user, isAdmin };
          }
          return user;
        });
        
        setUsersData({
          ...usersData,
          users: updatedUsers
        });
      }
    } catch (err: any) {
      setError('Ошибка при изменении роли пользователя: ' + (err.response?.data?.message || err.message));
    }
  };

  // Формирование кнопок пагинации
  const renderPagination = () => {
    if (!usersData) return null;
    
    const { page: currentPage, totalPages } = usersData;
    
    const pages: JSX.Element[] = [];
    for (let i = 1; i <= totalPages; i++) {
      pages.push(
        <button
          key={i}
          onClick={() => setPage(i)}
          className={i === currentPage ? 'active' : ''}
        >
          {i}
        </button>
      );
    }
    
    return (
      <div className="pagination">
        <button 
          onClick={() => setPage(currentPage - 1)} 
          disabled={currentPage === 1}
        >
          &laquo;
        </button>
        
        {pages}
        
        <button 
          onClick={() => setPage(currentPage + 1)} 
          disabled={currentPage === totalPages}
        >
          &raquo;
        </button>
      </div>
    );
  };

  if (isLoading && !usersData) {
    return <div className="loading">Загрузка пользователей...</div>;
  }

  return (
    <div className="users-page">
      <div className="page-header">
        <h1 className="page-title">Пользователи</h1>
        <div className="search-container">
          <input
            type="text"
            placeholder="Поиск пользователей..."
            value={searchQuery}
            onChange={handleSearchChange}
            className="search-input"
          />
        </div>
      </div>
      
      {error && <div className="error-message">{error}</div>}
      
      <div className="table-container">
        <table className="users-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Имя</th>
              <th>Телеграм</th>
              <th>Активные подписки</th>
              <th>Дата регистрации</th>
              <th>Статус</th>
              <th>Роль</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            {usersData?.users.map(user => (
              <tr key={user.id} className={!user.isActive ? 'inactive-row' : ''}>
                <td>{user.id}</td>
                <td>
                  {user.firstName} {user.lastName}
                  {user.username && <span className="username">@{user.username}</span>}
                </td>
                <td>{user.telegramId}</td>
                <td>{user.activeSubscriptions}</td>
                <td>{new Date(user.createdAt).toLocaleDateString()}</td>
                <td>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={user.isActive}
                      onChange={() => handleStatusChange(user.id, !user.isActive)}
                    />
                    <span className="slider"></span>
                  </label>
                </td>
                <td>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={user.isAdmin}
                      onChange={() => handleAdminChange(user.id, !user.isAdmin)}
                    />
                    <span className="slider"></span>
                  </label>
                </td>
                <td>
                  <Link to={`/users/${user.id}`} className="btn btn-primary btn-sm">
                    Подробнее
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      
      {usersData && usersData.users.length === 0 && (
        <div className="no-data">Пользователи не найдены</div>
      )}
      
      {renderPagination()}
    </div>
  );
};

export default Users; 