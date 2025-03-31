import { Request, Response } from 'express';
import { prisma } from '../../services/database';
import logger from '../../utils/logger';
import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import config from '../../config';
import { v4 as uuidv4 } from 'uuid';

/**
 * Получение списка серверов
 */
export const getServers = async (req: Request, res: Response) => {
  try {
    const servers = await prisma.vpnServer.findMany({
      orderBy: { id: 'asc' }
    });
    
    // Получаем количество активных пользователей для каждого сервера
    const serversWithUsers = await Promise.all(
      servers.map(async (server) => {
        const activeUsers = await prisma.subscription.count({
          where: {
            vpnServerId: server.id,
            status: 'ACTIVE'
          }
        });
        
        return {
          ...server,
          currentUsers: activeUsers
        };
      })
    );
    
    res.json({ servers: serversWithUsers });
  } catch (error) {
    logger.error(`Ошибка при получении списка серверов: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при получении списка серверов' });
  }
};

/**
 * Получение информации о конкретном сервере
 */
export const getServerById = async (req: Request, res: Response) => {
  try {
    const serverId = parseInt(req.params.id);
    
    const server = await prisma.vpnServer.findUnique({
      where: { id: serverId }
    });
    
    if (!server) {
      return res.status(404).json({ error: true, message: 'Сервер не найден' });
    }
    
    // Получаем количество активных пользователей
    const activeUsers = await prisma.subscription.count({
      where: {
        vpnServerId: serverId,
        status: 'ACTIVE'
      }
    });
    
    // Получаем конфигурацию сервера
    const serverConfig = "# Конфигурация сервера\n# Это пример конфигурации\nserver {\n  listen 80;\n  server_name example.com;\n}";
    
    res.json({
      ...server,
      currentUsers: activeUsers,
      config: serverConfig
    });
  } catch (error) {
    logger.error(`Ошибка при получении информации о сервере: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при получении информации о сервере' });
  }
};

/**
 * Создание нового сервера
 */
export const createServer = async (req: Request, res: Response) => {
  try {
    const { name, host, port, maxUsers, isActive } = req.body;
    
    // Проверка обязательных полей
    if (!name || !host || !port) {
      return res.status(400).json({ 
        error: true, 
        message: 'Необходимо указать название, хост и порт сервера' 
      });
    }

    const location = req.body.location;
    const provider = req.body.provider;
    
    // Создаем новый сервер
    const server = await prisma.vpnServer.create({
      data: {
        name,
        host,
        port: parseInt(port),
        location,
        provider,
        maxClients: maxUsers ? parseInt(maxUsers) : 100,
        isActive: typeof isActive === 'boolean' ? isActive : true
      }
    });
    
    res.status(201).json({ server });
  } catch (error) {
    logger.error(`Ошибка при создании сервера: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при создании сервера' });
  }
};

/**
 * Обновление информации о сервере
 */
export const updateServer = async (req: Request, res: Response) => {
  try {
    const serverId = parseInt(req.params.id);
    const { name, host, port, maxUsers, isActive } = req.body;
    
    // Проверяем существование сервера
    const existingServer = await prisma.vpnServer.findUnique({
      where: { id: serverId }
    });
    
    if (!existingServer) {
      return res.status(404).json({ error: true, message: 'Сервер не найден' });
    }
    
    // Обновляем информацию о сервере
    const server = await prisma.vpnServer.update({
      where: { id: serverId },
      data: {
        name: name !== undefined ? name : undefined,
        host: host !== undefined ? host : undefined,
        port: port !== undefined ? parseInt(port) : undefined,
        maxClients: maxUsers !== undefined ? parseInt(maxUsers) : undefined,
        isActive: isActive !== undefined ? isActive : undefined
      }
    });
    
    res.json({ server });
  } catch (error) {
    logger.error(`Ошибка при обновлении сервера: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при обновлении сервера' });
  }
};

/**
 * Удаление сервера
 */
export const deleteServer = async (req: Request, res: Response) => {
  try {
    const serverId = parseInt(req.params.id);
    
    // Проверяем существование сервера
    const existingServer = await prisma.vpnServer.findUnique({
      where: { id: serverId }
    });
    
    if (!existingServer) {
      return res.status(404).json({ error: true, message: 'Сервер не найден' });
    }
    
    // Проверяем, есть ли активные подписки на этот сервер
    const activeSubscriptions = await prisma.subscription.count({
      where: {
        vpnServerId: serverId,
        status: 'ACTIVE'
      }
    });
    
    if (activeSubscriptions > 0) {
      return res.status(400).json({
        error: true,
        message: `Невозможно удалить сервер, так как на нем ${activeSubscriptions} активных подписок`
      });
    }
    
    // Удаляем сервер
    await prisma.vpnServer.delete({
      where: { id: serverId }
    });
    
    res.json({ 
      success: true, 
      message: `Сервер ${existingServer.name} успешно удален` 
    });
  } catch (error) {
    logger.error(`Ошибка при удалении сервера: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при удалении сервера' });
  }
};

// Объект для хранения процессов развертывания и их статусов
interface DeploymentProcess {
  status: 'running' | 'completed' | 'failed';
  serverId?: number;
  logs: string;
  error?: string;
}

const deployments: Record<string, DeploymentProcess> = {};

/**
 * Запуск процесса развертывания VPN сервера
 */
export const deployServer = async (req: Request, res: Response) => {
  try {
    const { name, host, port, location, provider, maxClients } = req.body;
    
    // Проверка обязательных полей
    if (!name || !host || !port) {
      return res.status(400).json({ 
        error: true, 
        message: 'Необходимо указать название, хост и порт сервера' 
      });
    }

    // Создаем запись о сервере в базе данных
    const server = await prisma.vpnServer.create({
      data: {
        name,
        host,
        port: parseInt(port),
        location,
        provider,
        maxClients: parseInt(maxClients) || 50,
        isActive: true,
        currentClients: 0
      }
    });
    
    logger.info(`Сервер ${name} (${host}) добавлен в базу данных с ID: ${server.id}`);
    
    // Генерируем уникальный ID для процесса развертывания
    const deploymentId = uuidv4();
    
    // Создаем запись о процессе развертывания
    deployments[deploymentId] = {
      status: 'running',
      serverId: server.id,
      logs: `Начало развертывания сервера ${name} (${host})...\n`
    };
    
    // Запускаем процесс развертывания в фоновом режиме
    deployVpnServerBackground(deploymentId, server);
    
    // Отправляем ответ клиенту
    res.status(201).json({ 
      success: true, 
      message: 'Процесс развертывания запущен', 
      serverId: server.id,
      deploymentId
    });
  } catch (error: any) {
    logger.error(`Ошибка при запуске процесса развертывания: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при запуске процесса развертывания' });
  }
};

/**
 * Получение статуса развертывания
 */
export const getDeploymentStatus = async (req: Request, res: Response) => {
  try {
    const deploymentId = req.params.deploymentId;
    
    if (!deployments[deploymentId]) {
      return res.status(404).json({ error: true, message: 'Процесс развертывания не найден' });
    }
    
    res.json({
      status: deployments[deploymentId].status,
      serverId: deployments[deploymentId].serverId,
      logs: deployments[deploymentId].logs,
      error: deployments[deploymentId].error
    });
  } catch (error) {
    logger.error(`Ошибка при получении статуса развертывания: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при получении статуса развертывания' });
  }
};

/**
 * Функция для запуска процесса развертывания VPN сервера в фоновом режиме
 */
async function deployVpnServerBackground(deploymentId: string, server: any): Promise<void> {
  try {
    // Подготавливаем директорию для SSH ключей
    const sshKeyPath = config.sshPrivateKeyPath;
    
    // Проверка наличия SSH ключа
    if (!fs.existsSync(sshKeyPath)) {
      deployments[deploymentId].status = 'failed';
      deployments[deploymentId].error = `SSH ключ не найден по пути: ${sshKeyPath}`;
      logger.error(deployments[deploymentId].error);
      return;
    }
    
    // Создаем директорию для скриптов установки
    const installDir = path.resolve(process.cwd(), 'install');
    if (!fs.existsSync(installDir)) {
      fs.mkdirSync(installDir, { recursive: true });
    }
    
    // Создаем скрипт для установки Xray (аналогично deploy.ts)
    const installScriptPath = path.join(installDir, `install_xray_${deploymentId}.sh`);
    
    // Добавляем запись в логи
    deployments[deploymentId].logs += `Подготовка скрипта установки...\n`;
    
    // Создаем скрипт установки
    const installScript = `#!/bin/bash
    
# Обновление системы
apt-get update -y
apt-get upgrade -y

# Установка зависимостей
apt-get install -y curl wget unzip nginx certbot python3-certbot-nginx

# Установка Xray
bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install

# Создание директорий для конфигураций
mkdir -p /usr/local/etc/xray
mkdir -p /var/log/xray

# Базовая конфигурация Xray с VLESS + TLS + TCP + XTLS-Vision
cat > /usr/local/etc/xray/config.json << 'EOL'
{
  "log": {
    "loglevel": "warning",
    "access": "/var/log/xray/access.log",
    "error": "/var/log/xray/error.log"
  },
  "inbounds": [
    {
      "port": 443,
      "protocol": "vless",
      "settings": {
        "clients": [],
        "decryption": "none",
        "fallbacks": [
          {
            "dest": 80
          }
        ]
      },
      "streamSettings": {
        "network": "tcp",
        "security": "tls",
        "tlsSettings": {
          "alpn": ["http/1.1"],
          "certificates": [
            {
              "certificateFile": "/etc/letsencrypt/live/${server.host}/fullchain.pem",
              "keyFile": "/etc/letsencrypt/live/${server.host}/privkey.pem"
            }
          ]
        }
      }
    }
  ],
  "outbounds": [
    {
      "protocol": "freedom",
      "tag": "direct"
    },
    {
      "protocol": "blackhole",
      "tag": "block"
    }
  ],
  "routing": {
    "rules": [
      {
        "type": "field",
        "ip": ["geoip:private"],
        "outboundTag": "block"
      }
    ]
  }
}
EOL

# Настройка Nginx
cat > /etc/nginx/sites-available/default << 'EOL'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    
    root /var/www/html;
    index index.html index.htm;
    
    server_name ${server.host};
    
    location / {
        try_files $uri $uri/ =404;
    }
}
EOL

# Получение SSL сертификата
certbot --nginx -d ${server.host} --non-interactive --agree-tos --email admin@example.com

# Перезапуск сервисов
systemctl restart nginx
systemctl restart xray

# Настройка файрвола
apt-get install -y ufw
ufw allow ssh
ufw allow http
ufw allow https
ufw enable

# Создаем API для управления сервером
mkdir -p /usr/local/bin/vpn-api
cat > /usr/local/bin/vpn-api/server.js << 'EOL'
const express = require('express');
const fs = require('fs');
const { execSync } = require('child_process');
const app = express();
const port = 3000;

app.use(express.json());

// Функция для обновления конфигурации Xray
function updateXrayConfig(configData) {
  try {
    const configPath = '/usr/local/etc/xray/config.json';
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    // Найти или создать клиента
    let clientIndex = config.inbounds[0].settings.clients.findIndex(c => c.id === configData.clientId);
    
    if (clientIndex === -1) {
      // Добавить нового клиента
      config.inbounds[0].settings.clients.push({
        id: configData.clientId,
        flow: "xtls-rprx-vision",
        email: \`user-\${configData.clientId.substring(0, 8)}\`
      });
    }
    
    // Обновить конфигурацию
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    
    // Перезапустить Xray
    execSync('systemctl restart xray');
    
    return { success: true, message: 'Конфигурация обновлена' };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

// Маршрут для обновления конфигурации
app.post('/api/config', (req, res) => {
  const result = updateXrayConfig(req.body);
  if (result.success) {
    res.status(200).json(result);
  } else {
    res.status(500).json(result);
  }
});

// Запуск сервера
app.listen(port, '127.0.0.1', () => {
  console.log(\`API сервер запущен на порту \${port}\`);
});
EOL

# Установка Node.js и необходимых пакетов
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs
npm install -g pm2
cd /usr/local/bin/vpn-api
npm init -y
npm install express

# Запуск API сервера через PM2 для сохранения работы после перезагрузки
pm2 start server.js --name "vpn-api"
pm2 save
pm2 startup

echo "Установка Xray завершена!"
echo "API сервер запущен и настроен на автозагрузку"
`;
    
    fs.writeFileSync(installScriptPath, installScript);
    fs.chmodSync(installScriptPath, '755');
    
    // Добавляем запись в логи
    deployments[deploymentId].logs += `Скрипт установки создан.\nКопирование скрипта на сервер ${server.host}...\n`;
    
    // Копируем скрипт на сервер
    try {
      execSync(`scp -i ${sshKeyPath} -P ${server.port} ${installScriptPath} ${config.sshUser}@${server.host}:/tmp/install_xray.sh`);
      deployments[deploymentId].logs += `Скрипт успешно скопирован на сервер.\nЗапуск установки Xray...\n`;
    } catch (error: any) {
      deployments[deploymentId].status = 'failed';
      deployments[deploymentId].error = `Ошибка при копировании скрипта на сервер: ${error.message}`;
      logger.error(deployments[deploymentId].error);
      return;
    }
    
    // Запускаем процесс установки на удаленном сервере
    const sshProcess = spawn('ssh', [
      '-i', sshKeyPath,
      '-p', server.port.toString(),
      `${config.sshUser}@${server.host}`,
      'chmod +x /tmp/install_xray.sh && sudo /tmp/install_xray.sh'
    ]);
    
    // Обрабатываем вывод процесса
    sshProcess.stdout.on('data', (data) => {
      const output = data.toString();
      deployments[deploymentId].logs += output;
      logger.info(`[Deployment ${deploymentId}] ${output}`);
    });
    
    sshProcess.stderr.on('data', (data) => {
      const output = data.toString();
      deployments[deploymentId].logs += output;
      logger.warn(`[Deployment ${deploymentId}] ${output}`);
    });
    
    // Обрабатываем завершение процесса
    sshProcess.on('close', (code) => {
      if (code === 0) {
        deployments[deploymentId].status = 'completed';
        deployments[deploymentId].logs += `\nРазвертывание VPN сервера ${server.name} (${server.host}) успешно завершено!\n`;
        logger.info(`Развертывание сервера ${server.id} (${server.name}) успешно завершено`);
      } else {
        deployments[deploymentId].status = 'failed';
        deployments[deploymentId].error = `Процесс установки завершился с кодом ошибки: ${code}`;
        deployments[deploymentId].logs += `\nОшибка: процесс установки завершился с кодом: ${code}\n`;
        logger.error(`Ошибка при развертывании сервера ${server.id} (${server.name}): код ${code}`);
      }
    });
    
    // Обрабатываем ошибки процесса
    sshProcess.on('error', (error) => {
      deployments[deploymentId].status = 'failed';
      deployments[deploymentId].error = `Ошибка при выполнении SSH команды: ${error.message}`;
      deployments[deploymentId].logs += `\nОшибка: ${error.message}\n`;
      logger.error(`Ошибка при выполнении SSH команды: ${error}`);
    });
  } catch (error: any) {
    deployments[deploymentId].status = 'failed';
    deployments[deploymentId].error = `Неожиданная ошибка при развертывании: ${error.message}`;
    deployments[deploymentId].logs += `\nНеожиданная ошибка: ${error.message}\n`;
    logger.error(`Неожиданная ошибка при развертывании сервера ${server.id} (${server.name}): ${error}`);
  }
} 