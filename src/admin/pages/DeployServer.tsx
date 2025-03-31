import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';

const DeployServer: React.FC = () => {
  const navigate = useNavigate();
  const [isDeploying, setIsDeploying] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<boolean>(false);
  const [deploymentStatus, setDeploymentStatus] = useState<string>('');
  const [formData, setFormData] = useState({
    name: '',
    host: '',
    port: '22',
    location: '',
    provider: '',
    maxClients: '50',
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsDeploying(true);
      setError(null);
      setDeploymentStatus('Начало развертывания VPN сервера...');

      // API запрос на развертывание сервера
      const response = await axios.post('/api/servers/deploy', formData);
      
      setDeploymentStatus('Сервер успешно добавлен в базу данных');

      // Проверяем статус развертывания
      const deploymentId = response.data.deploymentId;
      let isCompleted = false;
      
      // Периодически проверяем статус развертывания
      const statusCheck = setInterval(async () => {
        try {
          const statusResponse = await axios.get(`/api/servers/deploy/${deploymentId}/status`);
          
          if (statusResponse.data.logs) {
            setDeploymentStatus(statusResponse.data.logs);
          }
          
          if (statusResponse.data.status === 'completed') {
            clearInterval(statusCheck);
            isCompleted = true;
            setSuccess(true);
            setDeploymentStatus('Развертывание успешно завершено!');
            setTimeout(() => navigate('/servers'), 3000);
          } else if (statusResponse.data.status === 'failed') {
            clearInterval(statusCheck);
            isCompleted = true;
            setError(`Ошибка при развертывании: ${statusResponse.data.error}`);
          }
        } catch (err: any) {
          clearInterval(statusCheck);
          setError('Ошибка при проверке статуса развертывания');
        }
      }, 5000); // Проверяем каждые 5 секунд
      
      // Остановка проверки статуса через 30 минут, если не завершено
      setTimeout(() => {
        if (!isCompleted) {
          clearInterval(statusCheck);
          setError('Превышено время ожидания развертывания. Проверьте статус сервера позже.');
        }
      }, 30 * 60 * 1000);
      
    } catch (err: any) {
      setError('Ошибка при запуске развертывания: ' + (err.response?.data?.message || err.message));
    } finally {
      setIsDeploying(false);
    }
  };

  return (
    <div className="deploy-server-page">
      <div className="page-header">
        <h1 className="page-title">Развертывание нового VPN сервера</h1>
      </div>
      
      {error && <div className="error-message">{error}</div>}
      {success && <div className="success-message">Сервер успешно развернут!</div>}
      
      {!isDeploying && !success ? (
        <form onSubmit={handleSubmit} className="deploy-form">
          <div className="form-group">
            <label htmlFor="name">Название сервера</label>
            <input
              type="text"
              id="name"
              name="name"
              value={formData.name}
              onChange={handleChange}
              placeholder="Например: Amsterdam-1"
              required
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="host">IP-адрес или доменное имя</label>
            <input
              type="text"
              id="host"
              name="host"
              value={formData.host}
              onChange={handleChange}
              placeholder="Например: 123.45.67.89"
              required
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="port">SSH порт</label>
            <input
              type="number"
              id="port"
              name="port"
              value={formData.port}
              onChange={handleChange}
              placeholder="22"
              required
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="location">Географическое расположение</label>
            <input
              type="text"
              id="location"
              name="location"
              value={formData.location}
              onChange={handleChange}
              placeholder="Например: Netherlands"
              required
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="provider">Провайдер сервера</label>
            <input
              type="text"
              id="provider"
              name="provider"
              value={formData.provider}
              onChange={handleChange}
              placeholder="Например: DigitalOcean"
              required
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="maxClients">Макс. количество пользователей</label>
            <input
              type="number"
              id="maxClients"
              name="maxClients"
              value={formData.maxClients}
              onChange={handleChange}
              placeholder="50"
              required
            />
          </div>
          
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/servers')}>
              Отмена
            </button>
            <button type="submit" className="btn btn-primary">
              Развернуть сервер
            </button>
          </div>
        </form>
      ) : (
        <div className="deployment-status">
          <h3>Статус развертывания:</h3>
          <div className="status-box">
            <pre>{deploymentStatus}</pre>
          </div>
          {isDeploying && (
            <div className="loading-spinner">
              <div className="spinner"></div>
              <p>Пожалуйста, подождите. Это может занять несколько минут...</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default DeployServer; 