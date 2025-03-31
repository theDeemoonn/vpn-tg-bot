import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';

interface AutoscalingStatus {
  enabled: boolean;
  inProgress: boolean;
}

interface ServerMetrics {
  cpuUsage: number;
  memoryUsage: number;
  bandwidth: number;
  connections: number;
  latency: number;
  timestamp: Date;
}

interface Server {
  id: number;
  name: string;
  host: string;
  isActive: boolean;
  maxClients: number;
  currentUsers: number;
  metrics: ServerMetrics[];
  overloaded: boolean;
}

const AutoScaling: React.FC = () => {
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [autoscalingStatus, setAutoscalingStatus] = useState<AutoscalingStatus>({ enabled: false, inProgress: false });
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [servers, setServers] = useState<Server[]>([]);
  const [refreshInterval, setRefreshInterval] = useState<number>(30);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  
  // Загрузка данных
  const fetchData = async () => {
    try {
      setIsLoading(true);
      setError(null);
      
      // Получение статуса автомасштабирования
      const statusResponse = await axios.get('/api/servers/autoscaling/status');
      setAutoscalingStatus(statusResponse.data.autoscaling);
      
      // Получение списка серверов
      const serversResponse = await axios.get('/api/servers');
      
      // Получение метрик для каждого сервера
      const serversWithMetrics = await Promise.all(
        serversResponse.data.servers.map(async (server: any) => {
          try {
            const metricsResponse = await axios.get(`/api/servers/${server.id}/metrics`);
            return {
              ...server,
              metrics: metricsResponse.data.metrics || [],
              overloaded: metricsResponse.data.overloaded || false
            };
          } catch (err) {
            return {
              ...server,
              metrics: [],
              overloaded: false
            };
          }
        })
      );
      
      setServers(serversWithMetrics);
      setLastUpdate(new Date());
    } catch (err: any) {
      setError(`Ошибка при загрузке данных: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };
  
  // Включение/выключение автомасштабирования
  const toggleAutoscaling = async (enabled: boolean) => {
    try {
      setIsProcessing(true);
      const response = await axios.post('/api/servers/autoscaling', { enabled });
      setAutoscalingStatus(response.data.autoscaling);
    } catch (err: any) {
      setError(`Ошибка при изменении статуса автомасштабирования: ${err.message}`);
    } finally {
      setIsProcessing(false);
    }
  };
  
  // Запуск ручного масштабирования
  const triggerManualScaling = async () => {
    try {
      setIsProcessing(true);
      await axios.post('/api/servers/autoscaling/manual');
      fetchData(); // Обновляем данные после запуска масштабирования
    } catch (err: any) {
      setError(`Ошибка при запуске ручного масштабирования: ${err.message}`);
    } finally {
      setIsProcessing(false);
    }
  };
  
  // Изменение интервала обновления
  const changeRefreshInterval = (interval: number) => {
    setRefreshInterval(interval);
  };
  
  // Загрузка данных при первой загрузке страницы
  useEffect(() => {
    fetchData();
  }, []);
  
  // Настройка автоматического обновления
  useEffect(() => {
    if (refreshInterval <= 0) return;
    
    const interval = setInterval(() => {
      fetchData();
    }, refreshInterval * 1000);
    
    return () => clearInterval(interval);
  }, [refreshInterval]);
  
  return (
    <div className="autoscaling-page">
      <div className="page-header">
        <h1 className="page-title">Автомасштабирование</h1>
        <div className="header-actions">
          <button 
            className={`btn ${autoscalingStatus.enabled ? 'btn-danger' : 'btn-success'}`}
            onClick={() => toggleAutoscaling(!autoscalingStatus.enabled)}
            disabled={isProcessing}
          >
            {autoscalingStatus.enabled ? 'Выключить' : 'Включить'} автомасштабирование
          </button>
          
          <button 
            className="btn btn-primary"
            onClick={triggerManualScaling}
            disabled={isProcessing}
          >
            Масштабировать сейчас
          </button>
          
          <button 
            className="btn btn-secondary"
            onClick={fetchData}
            disabled={isLoading}
          >
            Обновить данные
          </button>
        </div>
      </div>
      
      {error && <div className="error-message">{error}</div>}
      
      <div className="autoscaling-status card">
        <div className="card-header">
          <h2 className="card-title">Статус автомасштабирования</h2>
        </div>
        <div className="card-body">
          <div className="status-item">
            <span className="label">Состояние:</span>
            <span className={`value ${autoscalingStatus.enabled ? 'active' : 'inactive'}`}>
              {autoscalingStatus.enabled ? 'Включено' : 'Выключено'}
            </span>
          </div>
          <div className="status-item">
            <span className="label">Процесс масштабирования:</span>
            <span className={`value ${autoscalingStatus.inProgress ? 'active' : 'inactive'}`}>
              {autoscalingStatus.inProgress ? 'В процессе' : 'Не выполняется'}
            </span>
          </div>
          <div className="status-item">
            <span className="label">Последнее обновление:</span>
            <span className="value">
              {lastUpdate ? lastUpdate.toLocaleString() : 'Н/Д'}
            </span>
          </div>
          <div className="status-item">
            <span className="label">Интервал обновления:</span>
            <div className="value refresh-controls">
              <select 
                value={refreshInterval} 
                onChange={(e) => changeRefreshInterval(parseInt(e.target.value))}
              >
                <option value="0">Отключено</option>
                <option value="10">10 секунд</option>
                <option value="30">30 секунд</option>
                <option value="60">1 минута</option>
                <option value="300">5 минут</option>
              </select>
            </div>
          </div>
        </div>
      </div>
      
      <div className="servers-metrics card">
        <div className="card-header">
          <h2 className="card-title">Метрики серверов</h2>
        </div>
        <div className="card-body">
          {isLoading ? (
            <div className="loading">Загрузка метрик...</div>
          ) : (
            <table className="metrics-table">
              <thead>
                <tr>
                  <th>Сервер</th>
                  <th>CPU</th>
                  <th>Память</th>
                  <th>Соединения</th>
                  <th>Пропускная способность</th>
                  <th>Задержка</th>
                  <th>Статус</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {servers.map(server => {
                  const lastMetrics = server.metrics.length > 0 ? server.metrics[server.metrics.length - 1] : null;
                  
                  return (
                    <tr key={server.id} className={server.overloaded ? 'overloaded' : ''}>
                      <td>
                        <div className="server-name">
                          <span className={`status-indicator ${server.isActive ? 'active' : 'inactive'}`}></span>
                          {server.name}
                        </div>
                        <div className="server-host">{server.host}</div>
                      </td>
                      <td>
                        {lastMetrics ? (
                          <div className="metric-value">
                            <div 
                              className={`meter ${lastMetrics.cpuUsage > 80 ? 'high' : lastMetrics.cpuUsage > 50 ? 'medium' : 'low'}`}
                              style={{ width: `${Math.min(lastMetrics.cpuUsage, 100)}%` }}
                            ></div>
                            <span>{lastMetrics.cpuUsage.toFixed(1)}%</span>
                          </div>
                        ) : (
                          'Н/Д'
                        )}
                      </td>
                      <td>
                        {lastMetrics ? (
                          <div className="metric-value">
                            <div 
                              className={`meter ${lastMetrics.memoryUsage > 80 ? 'high' : lastMetrics.memoryUsage > 50 ? 'medium' : 'low'}`}
                              style={{ width: `${Math.min(lastMetrics.memoryUsage, 100)}%` }}
                            ></div>
                            <span>{lastMetrics.memoryUsage.toFixed(1)}%</span>
                          </div>
                        ) : (
                          'Н/Д'
                        )}
                      </td>
                      <td>
                        {lastMetrics ? (
                          <div className="connections">
                            {lastMetrics.connections} / {server.maxClients}
                          </div>
                        ) : (
                          'Н/Д'
                        )}
                      </td>
                      <td>
                        {lastMetrics ? (
                          `${lastMetrics.bandwidth.toFixed(2)} Мбит/с`
                        ) : (
                          'Н/Д'
                        )}
                      </td>
                      <td>
                        {lastMetrics ? (
                          `${lastMetrics.latency.toFixed(2)} мс`
                        ) : (
                          'Н/Д'
                        )}
                      </td>
                      <td>
                        <span className={`server-status ${server.overloaded ? 'overloaded' : 'normal'}`}>
                          {server.overloaded ? 'Перегружен' : 'Нормальный'}
                        </span>
                      </td>
                      <td>
                        <Link to={`/servers/${server.id}`} className="btn btn-sm btn-primary">
                          Подробнее
                        </Link>
                      </td>
                    </tr>
                  );
                })}
                
                {servers.length === 0 && (
                  <tr>
                    <td colSpan={8} className="no-data">
                      Серверы не найдены
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
      
      <div className="autoscaling-rules card">
        <div className="card-header">
          <h2 className="card-title">Правила автомасштабирования</h2>
        </div>
        <div className="card-body">
          <div className="rules-description">
            <p>Система автоматически масштабирует VPN серверы на основе следующих правил:</p>
            <ul>
              <li><strong>Сервер считается перегруженным</strong>, если использование CPU больше 80% или памяти больше 85%</li>
              <li><strong>Новый сервер создается</strong>, если все существующие серверы перегружены или близки к максимальному количеству клиентов</li>
              <li><strong>Пользователи перераспределяются</strong> с перегруженных серверов на доступные серверы</li>
              <li><strong>Неиспользуемые серверы отключаются</strong>, если загрузка &lt; 10% и есть другие доступные серверы</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AutoScaling; 