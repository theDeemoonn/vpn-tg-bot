import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import axios from 'axios';


// Интерфейс для пользователя VPN, возвращаемый API
interface VpnUser {
  id: string;
  email: string;
  flow: string; // Или другие поля, которые возвращает ваше API
}

// Интерфейс для базовой информации о сервере
interface ServerInfo {
  id: number;
  name: string;
  host: string;
}

const ServerUsers: React.FC = () => {
  const { serverId } = useParams<{ serverId: string }>();
  const navigate = useNavigate();
  const [users, setUsers] = useState<VpnUser[]>([]);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null); // Ошибка загрузки списка/инфо
  const [newUserEmail, setNewUserEmail] = useState<string>('');
  const [isAdding, setIsAdding] = useState<boolean>(false);
  const [addError, setAddError] = useState<string | null>(null); // Ошибка добавления
  const [deleteError, setDeleteError] = useState<Record<string, string | null>>({}); // Ошибки удаления по email

  const parsedServerId = serverId ? parseInt(serverId, 10) : NaN;

  // --- Функции для работы с API ---

  const fetchServerInfo = useCallback(async () => {
    if (isNaN(parsedServerId)) return;
    try {
      // Запрос на получение базовой информации о сервере
      const response = await axios.get(`/api/servers/${parsedServerId}`);
      // Убедитесь, что ответ содержит server.id, server.name, server.host
      if (response.data.server) {
           setServerInfo({
               id: response.data.server.id,
               name: response.data.server.name,
               host: response.data.server.host,
           });
      } else {
           throw new Error('Ответ API не содержит информации о сервере.');
      }

    } catch (err: any) {
      console.error(`Ошибка загрузки информации о сервере ${parsedServerId}:`, err);
      setError('Не удалось загрузить информацию о сервере.');
    }
  }, [parsedServerId]);

  const fetchUsers = useCallback(async () => {
    if (isNaN(parsedServerId)) return;
    setIsLoading(true);
    setError(null);
    setDeleteError({}); // Сбрасываем ошибки удаления
    setAddError(null);
    try {
      const response = await axios.get(`/api/servers/${parsedServerId}/users`);
      if (response.data.success) {
        setUsers(response.data.clients || []);
      } else {
        throw new Error(response.data.message || 'Не удалось получить список пользователей.');
      }
    } catch (err: any) {
      console.error(`Ошибка загрузки пользователей для сервера ${parsedServerId}:`, err);
      const message = err.response?.data?.message || err.message || 'Произошла ошибка при загрузке пользователей.';
      setError(message);
      setUsers([]);
    } finally {
      setIsLoading(false);
    }
  }, [parsedServerId]);

  // --- Эффекты ---

  useEffect(() => {
    if (isNaN(parsedServerId)) {
      setError('Некорректный ID сервера в URL.');
      setIsLoading(false);
      return;
    }
    // Загружаем сначала инфо о сервере, потом пользователей
    fetchServerInfo().then(() => {
        // Только если информация о сервере успешно загружена, грузим пользователей
        if (!error) {
           fetchUsers();
        } else {
           setIsLoading(false); // Завершаем загрузку, если сервер не найден
        }
    });
  }, [parsedServerId, fetchServerInfo, fetchUsers, error]); // Добавили error в зависимости

  // --- Обработчики событий ---

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUserEmail || isAdding || isNaN(parsedServerId)) return;

    // Простая валидация email на фронте
    if (!/\S+@\S+\.\S+/.test(newUserEmail)) {
        setAddError("Введите корректный email.");
        return;
    }


    setIsAdding(true);
    setAddError(null);
    setDeleteError({}); // Сброс ошибок удаления
    try {
      const response = await axios.post(`/api/servers/${parsedServerId}/users`, { email: newUserEmail });
      if (response.data.success && response.data.client) {
        setUsers(prevUsers => [...prevUsers, response.data.client]);
        setNewUserEmail('');
        console.info(`Пользователь ${newUserEmail} успешно добавлен на сервер ${parsedServerId}`);
      } else {
        // Ошибка уровня приложения (success: false)
        throw new Error(response.data.message || 'Не удалось добавить пользователя.');
      }
    } catch (err: any) {
      console.error(`Ошибка добавления пользователя ${newUserEmail} на сервер ${parsedServerId}:`, err);
      const message = err.response?.data?.message || err.message || 'Произошла ошибка при добавлении пользователя.';
      setAddError(message);
    } finally {
      setIsAdding(false);
    }
  };

  const handleDeleteUser = async (email: string) => {
    if (!email || isNaN(parsedServerId) || !window.confirm(`Вы уверены, что хотите удалить пользователя ${email}?`)) {
      return;
    }
    // Устанавливаем индикатор загрузки для конкретной строки (опционально)
    // setLoadingDelete(email);
     setDeleteError(prev => ({ ...prev, [email]: null })); // Сбрасываем ошибку для этого email

    try {
      const encodedEmail = encodeURIComponent(email);
      const response = await axios.delete(`/api/servers/${parsedServerId}/users/${encodedEmail}`);
      if (response.data.success) {
        setUsers(prevUsers => prevUsers.filter(user => user.email !== email));
        console.info(`Пользователь ${email} успешно удален с сервера ${parsedServerId}`);
      } else {
         throw new Error(response.data.message || 'Не удалось удалить пользователя.');
      }
    } catch (err: any) {
      console.error(`Ошибка удаления пользователя ${email} с сервера ${parsedServerId}:`, err);
      const message = err.response?.data?.message || err.message || 'Произошла ошибка при удалении пользователя.';
       setDeleteError(prev => ({ ...prev, [email]: message }));
    } finally {
       // Снимаем индикатор загрузки для строки (опционально)
       // setLoadingDelete(null);
    }
  };

  // --- Рендеринг ---

  // Состояние, когда ID невалидный или сервер не найден
  if (isNaN(parsedServerId) || (!isLoading && !serverInfo && error)) {
      return (
          <div className="server-users-page container mt-4">
              <div className="page-header d-flex justify-content-between align-items-center mb-3">
                  <h1 className="page-title h3">Управление пользователями</h1>
                  <Link to="/servers" className="btn btn-secondary">Назад к серверам</Link>
              </div>
              <div className="alert alert-danger">{error || 'Сервер не найден или неверный ID.'}</div>
          </div>
      );
  }

  return (
    <div className="server-users-page container mt-4">
      <div className="page-header d-flex justify-content-between align-items-center mb-3">
        <h1 className="page-title h3">
          {/* Показываем имя сервера, если загружено, иначе ID */}
          Пользователи сервера: {serverInfo ? `${serverInfo.name} (${serverInfo.host})` : (isLoading ? 'Загрузка...' : `ID ${parsedServerId}`)}
        </h1>
         <Link to="/servers" className="btn btn-secondary">Назад к списку серверов</Link>
      </div>

      {/* Сообщение об общей ошибке загрузки списка */}
      {error && !isLoading && <div className="alert alert-danger">Ошибка загрузки: {error}</div>}

      {/* Форма добавления пользователя */}
      <div className="add-user-form card mb-4">
          <div className="card-body">
            <h5 className="card-title">Добавить нового пользователя</h5>
            <form onSubmit={handleAddUser} className="form-row align-items-end">
              <div className="col-auto flex-grow-1">
                <label htmlFor="newUserEmail" className="sr-only">Email</label>
                <input
                  type="email"
                  id="newUserEmail"
                  value={newUserEmail}
                  onChange={(e) => setNewUserEmail(e.target.value)}
                  placeholder="Введите email пользователя"
                  required
                  className={`form-control ${addError ? 'is-invalid' : ''}`}
                  disabled={isAdding}
                />
                {addError && <div className="invalid-feedback">{addError}</div>}
              </div>
              <div className="col-auto">
                <button type="submit" className="btn btn-success" disabled={isAdding || !newUserEmail}>
                  {isAdding ? (
                      <>
                        <span className="spinner-border spinner-border-sm mr-2" role="status" aria-hidden="true"></span>
                        Добавление...
                      </>
                  ): 'Добавить'}
                </button>
              </div>
            </form>
          </div>
      </div>

      {/* Список пользователей */}
      {isLoading && !serverInfo ? ( // Показываем общую загрузку только в начале
        <div className="d-flex justify-content-center align-items-center" style={{ minHeight: '200px' }}>
            <div className="spinner-border text-primary" role="status">
                <span className="sr-only">Загрузка...</span>
            </div>
        </div>
      ) : !isLoading && users.length === 0 && !error ? (
        <div className="alert alert-info">На этом сервере еще нет пользователей.</div>
      ) : users.length > 0 ? (
        <div className="users-list card">
           <div className="card-header">
               Список пользователей ({users.length})
            </div>
          <div className="table-responsive">
              <table className="table table-striped table-hover mb-0">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>UUID (ID)</th>
                    {/* <th>Flow</th> */}
                    <th style={{ width: '100px' }}>Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.id}>
                      <td>{user.email}</td>
                      <td>
                        <small>{user.id}</small> {/* Уменьшил размер UUID */}
                      </td>
                      {/* <td>{user.flow}</td> */}
                      <td>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => handleDeleteUser(user.email)}
                          disabled={!!deleteError[user.email]} // Блокируем кнопку при ошибке удаления для этого юзера
                        >
                          Удалить
                        </button>
                         {/* Показываем ошибку удаления под кнопкой */}
                        {deleteError[user.email] && <small className="text-danger d-block mt-1">{deleteError[user.email]}</small>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
          </div>
        </div>
      ) : null /* Если есть error, сообщение уже выведено выше */}
    </div>
  );
};

export default ServerUsers;