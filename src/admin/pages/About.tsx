import React from 'react';

const About: React.FC = () => {
  return (
    <div className="about-page">
      <div className="page-header">
        <h1 className="page-title">О проекте</h1>
      </div>
      
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">VPN Telegram Бот</h2>
        </div>
        <div className="card-body">
          <p>
            VPN Telegram Бот - это проект с открытым исходным кодом для автоматизации 
            предоставления VPN сервисов через Telegram. Проект включает в себя:
          </p>
          
          <ul>
            <li>Telegram бот для взаимодействия с пользователями</li>
            <li>Систему автоматического развертывания VPN серверов</li>
            <li>Админ-панель для управления инфраструктурой</li>
            <li>Систему оплаты и подписок</li>
          </ul>
          
          <p>
            Используемые технологии: Node.js, TypeScript, React, PostgreSQL, Docker, Xray.
          </p>
        </div>
      </div>
      
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Как развернуть VPN сервер</h2>
        </div>
        <div className="card-body">
          <p>
            Для развертывания нового VPN сервера:
          </p>
          
          <ol>
            <li>Убедитесь, что у вас есть SSH ключ в директории <code>keys/id_rsa</code> или настроены соответствующие переменные окружения.</li>
            <li>Перейдите в раздел "Серверы" и нажмите кнопку "Развернуть VPN сервер".</li>
            <li>Заполните необходимую информацию о сервере.</li>
            <li>Нажмите "Развернуть сервер" и дождитесь завершения процесса.</li>
          </ol>
          
          <p>
            Детальная инструкция по настройке и требованиям к серверам доступна в файле <code>keys/README.md</code>.
          </p>
        </div>
      </div>
      
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Документация</h2>
        </div>
        <div className="card-body">
          <p>
            Подробная документация доступна в репозитории проекта:
          </p>
          
          <ul>
            <li>
              <a href="https://github.com/yourproject/vpn-tg-bot" target="_blank" rel="noopener noreferrer">
                GitHub репозиторий
              </a>
            </li>
            <li>
              <a href="https://github.com/yourproject/vpn-tg-bot/wiki" target="_blank" rel="noopener noreferrer">
                Wiki с документацией
              </a>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
};

export default About; 