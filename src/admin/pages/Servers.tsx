import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import axios from "axios";

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
}

const Servers: React.FC = () => {
  const [servers, setServers] = useState<Server[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchServers = async () => {
      try {
        setIsLoading(true);
        const response = await axios.get("/api/servers");
        setServers(response.data.servers);
        setError(null);
      } catch (err: any) {
        setError(
          "Ошибка при загрузке серверов: " +
            (err.response?.data?.message || err.message)
        );
      } finally {
        setIsLoading(false);
      }
    };

    fetchServers();
  }, []);

  if (isLoading) {
    return <div className="loading">Загрузка серверов...</div>;
  }

  return (
    <div className="servers-page">
      <div className="page-header">
        <h1 className="page-title">Серверы</h1>
        <div className="header-actions">
          <Link to="/servers/deploy" className="btn btn-success">
            Развернуть VPN сервер
          </Link>
          <Link to="/servers/new" className="btn btn-primary">
            Добавить сервер
          </Link>
        </div>
      </div>

      {error && <div className="error-message">{error}</div>}

      <div className="table-container">
        <table className="servers-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Название</th>
              <th>Хост</th>
              <th>Порт</th>
              <th>Использование</th>
              <th>Статус</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            {servers.map((server) => (
              <tr
                key={server.id}
                className={!server.isActive ? "inactive-row" : ""}
              >
                <td>{server.id}</td>
                <td>{server.name}</td>
                <td>{server.host}</td>
                <td>{server.port}</td>
                <td>
                  <div className="usage-bar">
                    <div
                      className="usage-fill"
                      style={{
                        width: `${
                          (server.currentUsers / server.maxUsers) * 100
                        }%`,
                      }}
                    ></div>
                    <span className="usage-text">
                      {server.currentUsers} / {server.maxUsers}
                    </span>
                  </div>
                </td>
                <td>
                  <span
                    className={`status ${
                      server.isActive ? "active" : "inactive"
                    }`}
                  >
                    {server.isActive ? "Активен" : "Неактивен"}
                  </span>
                </td>
                <td>
                  <Link
                    to={`/servers/${server.id}`}
                    className="btn btn-primary btn-sm"
                  >
                    Подробнее
                  </Link>
                </td>
                <td>
                  <Link
                    to={`/servers/${server.id}/users`}
                    className="btn btn-info btn-sm ml-2"
                  >
                    {" "}
                    Пользователи
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {servers.length === 0 && (
        <div className="no-data">Серверы не найдены</div>
      )}
    </div>
  );
};

export default Servers;
