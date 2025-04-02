import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import '../styles/deploy-server.css';
import { deployServer, getDeploymentStatus } from '../services/servers';

const DeployServer: React.FC = () => {
  const navigate = useNavigate();
  const [isDeploying, setIsDeploying] = useState(false);
  const [deploymentId, setDeploymentId] = useState<string | null>(null);
  const [deploymentStatus, setDeploymentStatus] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    ip: '',
    sshUsername: 'root',
    sshPort: '22',
    sshPassword: '',
    location: '',
    provider: ''
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsDeploying(true);
    setError(null);
    setDeploymentId(null);
    setDeploymentStatus(null);

    try {
      const response = await deployServer({
        name: formData.name,
        ip: formData.ip,
        sshUsername: formData.sshUsername,
        sshPort: formData.sshPort,
        sshPassword: formData.sshPassword || undefined,
        location: formData.location || undefined,
        provider: formData.provider || undefined
      });
      
      setDeploymentId(response.deploymentId);
      setDeploymentStatus({ status: 'pending', logs: 'Запрос на развертывание отправлен...' });
      startStatusPolling(response.deploymentId);

    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Произошла ошибка при запуске развертывания');
      setIsDeploying(false);
    }
  };

  const startStatusPolling = (depId: string) => {
    const pollInterval = setInterval(async () => {
      try {
        const status = await getDeploymentStatus(depId);
        setDeploymentStatus(status);

        if (status.status === 'completed' || status.status === 'failed') {
          clearInterval(pollInterval);
        }
      } catch (err: any) {
        if (err.response?.status !== 404) {
          console.error('Ошибка при получении статуса:', err);
          setError('Ошибка получения статуса развертывания');
          clearInterval(pollInterval);
        }
      }
    }, 5000);

    setTimeout(() => {
      clearInterval(pollInterval);
      if (deploymentStatus?.status !== 'completed' && deploymentStatus?.status !== 'failed') {
        setError('Таймаут ожидания завершения развертывания.');
      }
    }, 30 * 60 * 1000);
  };

  return (
    <div className="deploy-server-page">
      <div className="page-header">
        <h1 className="page-title">Развертывание VPN сервера (Docker)</h1>
      </div>

      {!isDeploying ? (
        <form className="deploy-form" onSubmit={handleSubmit}>
          {error && <div className="error-message">{error}</div>}
          <div className="form-group">
            <label htmlFor="name">Название сервера</label>
            <input
              type="text"
              id="name"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              required
              placeholder="Например, Amsterdam-1"
            />
          </div>

          <div className="form-group">
            <label htmlFor="ip">IP адрес сервера</label>
            <input
              type="text"
              id="ip"
              value={formData.ip}
              onChange={(e) => setFormData({ ...formData, ip: e.target.value })}
              required
              placeholder="Например, 123.45.67.89"
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="sshUsername">Имя пользователя SSH</label>
            <input
              type="text"
              id="sshUsername"
              value={formData.sshUsername}
              onChange={(e) => setFormData({ ...formData, sshUsername: e.target.value })}
              required
              placeholder="root"
            />
          </div>

          <div className="form-group">
            <label htmlFor="sshPort">SSH порт</label>
            <input
              type="number"
              id="sshPort"
              value={formData.sshPort}
              onChange={(e) => setFormData({ ...formData, sshPort: e.target.value })}
              required
              placeholder="22"
            />
          </div>

          <div className="form-group">
            <label htmlFor="sshPassword">Пароль SSH (оставьте пустым, если используется ключ из .env)</label>
            <input
              type="password"
              id="sshPassword"
              value={formData.sshPassword}
              onChange={(e) => setFormData({ ...formData, sshPassword: e.target.value })}
              placeholder="Введите пароль SSH"
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="location">Локация (опционально)</label>
            <input
              type="text"
              id="location"
              value={formData.location}
              onChange={(e) => setFormData({ ...formData, location: e.target.value })}
              placeholder="Например, Netherlands"
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="provider">Провайдер (опционально)</label>
            <input
              type="text"
              id="provider"
              value={formData.provider}
              onChange={(e) => setFormData({ ...formData, provider: e.target.value })}
              placeholder="Например, DigitalOcean"
            />
          </div>

          <div className="form-actions">
            <button type="submit" className="btn btn-primary">
              Развернуть сервер
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => navigate('/admin/servers')}
            >
              Отмена
            </button>
          </div>
        </form>
      ) : (
        <div className="deployment-status">
          <h3>Статус развертывания (ID: {deploymentId || '...'}):</h3>
          {deploymentStatus?.status === 'failed' && deploymentStatus?.error && 
              <div className="error-message">Ошибка: {deploymentStatus.error}</div>
          }
          {deploymentStatus?.status === 'completed' && 
              <div className="success-message">Развертывание успешно завершено!</div>
          }
          
          <div className="status-box">
            <pre>{deploymentStatus?.logs || 'Ожидание логов...'}</pre>
          </div>
          
          {deploymentStatus?.status !== 'completed' && deploymentStatus?.status !== 'failed' && (
            <div className="loading-spinner">
                <div className="spinner"></div>
                <p>Пожалуйста, подождите... Текущий этап: {deploymentStatus?.status || 'pending'}</p>
            </div>
          )}
          
          {(deploymentStatus?.status === 'completed' || deploymentStatus?.status === 'failed') && (
               <div className="form-actions">
                  <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => navigate('/admin/servers')}
                    >
                      Вернуться к серверам
                    </button>
               </div>
           )}
        </div>
      )}
    </div>
  );
};

export default DeployServer; 