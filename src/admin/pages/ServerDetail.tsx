import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import axios from 'axios';

interface Server {
  id: number;
  name: string;
  host: string;
  port: number;
  isActive: boolean;
  maxUsers: number;
  currentUsers: number;
  createdAt: string;
  updatedAt: string;
  config: string;
}

const ServerDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [server, setServer] = useState<Server | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchServerDetails = async () => {
      try {
        setIsLoading(true);
        const response = await axios.get(`/api/servers/${id}`);
        setServer(response.data);
      } catch (err: any) {
        setError('Ошибка при загрузке информации о сервере: ' + (err.response?.data?.message || err.message));
      } finally {
        setIsLoading(false);
      }
    };

    fetchServerDetails();
  }, [id]);

  if (isLoading) {
    return <div className="loading">Загрузка данных сервера...</div>;
  }

  if (error) {
    return <div className="error-message">{error}</div>;
  }

  if (!server) {
    return <div>Сервер не найден</div>;
  }

  return (
    <div className="server-detail-page">
      <div className="page-header">
        <h1 className="page-title">Сервер: {server.name}</h1>
        <div className="header-actions">
          <Link to="/servers" className="btn btn-secondary">
            Назад к списку
          </Link>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Основная информация</h2>
          <div className={`status-badge ${server.isActive ? 'active' : 'inactive'}`}>
            {server.isActive ? 'Активен' : 'Неактивен'}
          </div>
        </div>
        
        <div className="server-info">
          <div className="info-group">
            <span className="label">ID:</span>
            <span className="value">{server.id}</span>
          </div>
          
          <div className="info-group">
            <span className="label">Имя:</span>
            <span className="value">{server.name}</span>
          </div>
          
          <div className="info-group">
            <span className="label">Хост:</span>
            <span className="value">{server.host}</span>
          </div>
          
          <div className="info-group">
            <span className="label">Порт:</span>
            <span className="value">{server.port}</span>
          </div>
          
          <div className="info-group">
            <span className="label">Использование:</span>
            <span className="value">
              <div className="usage-bar">
                <div 
                  className="usage-fill" 
                  style={{ width: `${(server.currentUsers / server.maxUsers) * 100}%` }}
                ></div>
                <span className="usage-text">
                  {server.currentUsers} / {server.maxUsers} пользователей
                </span>
              </div>
            </span>
          </div>
          
          <div className="info-group">
            <span className="label">Создан:</span>
            <span className="value">{new Date(server.createdAt).toLocaleString()}</span>
          </div>
          
          <div className="info-group">
            <span className="label">Обновлен:</span>
            <span className="value">{new Date(server.updatedAt).toLocaleString()}</span>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Конфигурация сервера</h2>
        </div>
        
        <div className="config-container">
          <pre className="config-code">{server.config}</pre>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Действия</h2>
        </div>
        
        <div className="server-actions">
          <button className="btn btn-primary">
            Редактировать
          </button>
          
          <button className="btn btn-secondary">
            {server.isActive ? 'Деактивировать' : 'Активировать'}
          </button>
          
          <button className="btn btn-danger">
            Удалить
          </button>
        </div>
      </div>
    </div>
  );
};

export default ServerDetail; 