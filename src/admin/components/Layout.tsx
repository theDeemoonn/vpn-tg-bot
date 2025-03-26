import React from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { logout } from '../services/auth';
import '../styles/layout.css';

const Layout: React.FC = () => {
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="admin-layout">
      <header className="header">
        <div className="logo">
          <h1>VPN Админ-панель</h1>
        </div>
        <div className="user-menu">
          <button onClick={handleLogout} className="logout-btn">Выйти</button>
        </div>
      </header>
      
      <div className="container">
        <aside className="sidebar">
          <nav className="nav">
            <ul>
              <li>
                <NavLink to="/" end className={({ isActive }) => isActive ? 'active' : ''}>
                  Дашборд
                </NavLink>
              </li>
              <li>
                <NavLink to="/users" className={({ isActive }) => isActive ? 'active' : ''}>
                  Пользователи
                </NavLink>
              </li>
              <li>
                <NavLink to="/servers" className={({ isActive }) => isActive ? 'active' : ''}>
                  Серверы
                </NavLink>
              </li>
              <li>
                <NavLink to="/subscriptions" className={({ isActive }) => isActive ? 'active' : ''}>
                  Подписки
                </NavLink>
              </li>
              <li>
                <NavLink to="/payments" className={({ isActive }) => isActive ? 'active' : ''}>
                  Платежи
                </NavLink>
              </li>
              <li>
                <NavLink to="/settings" className={({ isActive }) => isActive ? 'active' : ''}>
                  Настройки
                </NavLink>
              </li>
            </ul>
          </nav>
        </aside>
        
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
};

export default Layout; 