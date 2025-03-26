import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { prisma } from '../services/database';
import logger from '../utils/logger';
import config from '../config';

// Функция для запуска команды и логирования результата
function runCommand(command: string): void {
  try {
    logger.info(`Выполнение команды: ${command}`);
    const output = execSync(command, { encoding: 'utf-8' });
    logger.info(output);
  } catch (error) {
    logger.error(`Ошибка при выполнении команды: ${command}`);
    logger.error(error);
    throw error;
  }
}

// Создание интерфейса для чтения ввода пользователя
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Запрос информации у пользователя
function askQuestion(query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve(answer);
    });
  });
}

// Основная функция развертывания
async function deployVpnServer(): Promise<void> {
  try {
    console.log('=== Скрипт развертывания VPN сервера ===');
    
    // Запрашиваем информацию о сервере
    const name = await askQuestion('Название сервера (например, Amsterdam-1): ');
    const host = await askQuestion('IP-адрес или доменное имя сервера: ');
    const port = parseInt(await askQuestion('SSH порт (обычно 22): '), 10) || 22;
    const location = await askQuestion('Географическое расположение (например, Netherlands): ');
    const provider = await askQuestion('Провайдер сервера (например, DigitalOcean): ');
    const maxClients = parseInt(await askQuestion('Максимальное количество одновременных подключений (50): '), 10) || 50;
    
    // Генерируем и сохраняем сервер в базе данных
    const server = await prisma.vpnServer.create({
      data: {
        name,
        host,
        port,
        location,
        provider,
        isActive: true,
        maxClients,
        currentClients: 0,
      }
    });
    
    logger.info(`Сервер ${name} (${host}) добавлен в базу данных с ID: ${server.id}`);
    
    // Подготавливаем директорию для SSH ключей
    const sshKeyPath = config.sshPrivateKeyPath;
    
    // Проверка наличия SSH ключа
    if (!fs.existsSync(sshKeyPath)) {
      logger.error(`SSH ключ не найден по пути: ${sshKeyPath}`);
      throw new Error(`SSH ключ не найден: ${sshKeyPath}`);
    }
    
    // Создаем директорию для скриптов установки
    const installDir = path.resolve(process.cwd(), 'install');
    if (!fs.existsSync(installDir)) {
      fs.mkdirSync(installDir, { recursive: true });
    }
    
    // Создаем скрипт для установки Xray
    const installScriptPath = path.join(installDir, 'install_xray.sh');
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
              "certificateFile": "/etc/letsencrypt/live/${host}/fullchain.pem",
              "keyFile": "/etc/letsencrypt/live/${host}/privkey.pem"
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
    
    server_name ${host};
    
    location / {
        try_files $uri $uri/ =404;
    }
}
EOL

# Получение SSL сертификата
certbot --nginx -d ${host} --non-interactive --agree-tos --email admin@example.com

# Перезапуск сервисов
systemctl restart nginx
systemctl restart xray

# Настройка файрвола (если необходимо)
apt-get install -y ufw
ufw allow ssh
ufw allow http
ufw allow https
ufw enable

# Создаем API для управления сервером (упрощенная версия)
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
    
    // Запуск скрипта установки через SSH
    console.log(`\nНачинаем установку Xray на сервер ${host}...`);
    
    // Копируем скрипт на сервер
    runCommand(`scp -i ${sshKeyPath} -P ${port} ${installScriptPath} ${config.sshUser}@${host}:/tmp/install_xray.sh`);
    
    // Запускаем скрипт на сервере
    runCommand(`ssh -i ${sshKeyPath} -p ${port} ${config.sshUser}@${host} "chmod +x /tmp/install_xray.sh && sudo /tmp/install_xray.sh"`);
    
    console.log(`\n✅ Установка Xray на сервер ${host} успешно завершена!`);
    console.log(`\nСервер ${name} (${host}) добавлен в базу данных и готов к использованию.`);
    
    // Закрываем интерфейс ввода
    rl.close();
  } catch (error: any) {
    logger.error(`Ошибка при развертывании VPN сервера: ${error}`);
    console.error(`❌ Ошибка: ${error.message}`);
    rl.close();
    process.exit(1);
  }
}

// Запускаем функцию развертывания
deployVpnServer(); 