import axios from 'axios';
import { prisma } from './database';
import logger from '../utils/logger';
import config from '../config';
import { v4 as uuidv4 } from 'uuid';
import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Интерфейс для провайдеров облачной инфраструктуры
interface CloudProvider {
  name: string;
  createServer: (options: ServerDeploymentOptions) => Promise<{ success: boolean; ip?: string; error?: string }>;
  deleteServer: (serverId: string, serverIp: string) => Promise<{ success: boolean; error?: string }>;
}

// Опции для развертывания сервера
export interface ServerDeploymentOptions {
  name: string;
  host?: string;      // Если пустой, будет создан новый сервер в облаке
  port?: number;      // По умолчанию 22
  location: string;   // Регион для развертывания
  provider: string;   // Облачный провайдер
  maxClients?: number;// Максимальное количество клиентов
  isAutoScaled?: boolean; // Флаг, что сервер создан автоматически
}

// Доступные облачные провайдеры
const cloudProviders: Record<string, CloudProvider> = {
  'DigitalOcean': {
    name: 'DigitalOcean',
    
    // Создание сервера в DigitalOcean
    createServer: async (options: ServerDeploymentOptions) => {
      try {
        logger.info(`Создание нового сервера в DigitalOcean (${options.name}, регион: ${options.location})`);
        
        // Проверяем наличие API ключа DigitalOcean
        const doApiKey = config.doApiKey;
        if (!doApiKey) {
          return { success: false, error: 'DigitalOcean API ключ не найден в конфигурации' };
        }
        
        // Получаем доступные регионы или используем соответствие из конфигурации
        const regionMap: Record<string, string> = {
          'amsterdam': 'ams3',
          'frankfurt': 'fra1',
          'london': 'lon1',
          'new-york': 'nyc3',
          'singapore': 'sgp1'
        };
        
        const regionSlug = regionMap[options.location.toLowerCase()] || 'ams3';
        
        // Создаем новый дроплет через API DigitalOcean
        const response = await axios.post('https://api.digitalocean.com/v2/droplets', {
          name: options.name,
          region: regionSlug, 
          size: 's-1vcpu-1gb',  // Наименьший размер дроплета
          image: 'ubuntu-20-04-x64',
          ssh_keys: [config.doSshKeyId], // ID SSH ключа в DigitalOcean
          backups: false,
          ipv6: false,
          monitoring: true,
          tags: ['vpn', 'auto-deployed']
        }, {
          headers: {
            'Authorization': `Bearer ${doApiKey}`,
            'Content-Type': 'application/json'
          }
        });
        
        if (response.status !== 202) {
          return { success: false, error: `Ошибка API DigitalOcean: ${response.statusText}` };
        }
        
        const dropletId = response.data.droplet.id;
        logger.info(`Дроплет ${options.name} (ID: ${dropletId}) создан в DigitalOcean`);
        
        // Ждем, пока дроплет получит IP адрес
        let dropletIp = '';
        let attempts = 0;
        
        while (!dropletIp && attempts < 30) {
          await new Promise(resolve => setTimeout(resolve, 5000)); // Ждем 5 секунд
          attempts++;
          
          const statusResponse = await axios.get(`https://api.digitalocean.com/v2/droplets/${dropletId}`, {
            headers: {
              'Authorization': `Bearer ${doApiKey}`
            }
          });
          
          const networks = statusResponse.data.droplet.networks.v4;
          if (networks && networks.length > 0) {
            for (const network of networks) {
              if (network.type === 'public') {
                dropletIp = network.ip_address;
                break;
              }
            }
          }
        }
        
        if (!dropletIp) {
          return { success: false, error: 'Не удалось получить IP адрес нового сервера' };
        }
        
        logger.info(`Сервер ${options.name} готов, IP адрес: ${dropletIp}`);
        
        // Ждем, пока сервер станет доступен по SSH
        await waitForSsh(dropletIp);
        
        return { success: true, ip: dropletIp };
      } catch (error: any) {
        logger.error(`Ошибка при создании сервера в DigitalOcean: ${error.message}`);
        return { success: false, error: `Ошибка при создании сервера: ${error.message}` };
      }
    },
    
    // Удаление сервера в DigitalOcean
    deleteServer: async (serverId: string, serverIp: string) => {
      try {
        logger.info(`Удаление сервера ${serverId} (${serverIp}) из DigitalOcean`);
        
        // Проверяем наличие API ключа DigitalOcean
        const doApiKey = config.doApiKey;
        if (!doApiKey) {
          return { success: false, error: 'DigitalOcean API ключ не найден в конфигурации' };
        }
        
        // Сначала находим ID дроплета по IP адресу
        const response = await axios.get('https://api.digitalocean.com/v2/droplets', {
          headers: {
            'Authorization': `Bearer ${doApiKey}`
          }
        });
        
        let dropletId = '';
        
        for (const droplet of response.data.droplets) {
          const networks = droplet.networks.v4;
          if (networks) {
            for (const network of networks) {
              if (network.type === 'public' && network.ip_address === serverIp) {
                dropletId = droplet.id;
                break;
              }
            }
          }
          
          if (dropletId) break;
        }
        
        if (!dropletId) {
          return { success: false, error: `Не найден дроплет с IP адресом ${serverIp}` };
        }
        
        // Удаляем дроплет
        const deleteResponse = await axios.delete(`https://api.digitalocean.com/v2/droplets/${dropletId}`, {
          headers: {
            'Authorization': `Bearer ${doApiKey}`
          }
        });
        
        if (deleteResponse.status !== 204) {
          return { success: false, error: `Ошибка API DigitalOcean: ${deleteResponse.statusText}` };
        }
        
        logger.info(`Дроплет ${dropletId} (${serverIp}) успешно удален из DigitalOcean`);
        return { success: true };
      } catch (error: any) {
        logger.error(`Ошибка при удалении сервера из DigitalOcean: ${error.message}`);
        return { success: false, error: `Ошибка при удалении сервера: ${error.message}` };
      }
    }
  },
  
  // Можно добавить другие провайдеры, например Vultr, AWS, GCP и т.д.
};

/**
 * Ожидание доступности сервера по SSH
 */
async function waitForSsh(host: string, port: number = 22, timeout: number = 180): Promise<boolean> {
  logger.info(`Ожидание доступности SSH на сервере ${host}:${port}...`);
  
  const startTime = Date.now();
  let isReady = false;
  
  while (!isReady && (Date.now() - startTime) / 1000 < timeout) {
    try {
      execSync(`ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes -i ${config.sshPrivateKeyPath} -p ${port} ${config.sshUser}@${host} echo "SSH connection test"`, {
        timeout: 5000
      });
      isReady = true;
      logger.info(`SSH на сервере ${host}:${port} доступен`);
    } catch (error) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // Ждем 5 секунд между попытками
    }
  }
  
  if (!isReady) {
    logger.error(`Таймаут ожидания SSH соединения с ${host}:${port}`);
  }
  
  return isReady;
}

/**
 * Развертывание VPN сервера (автоматическое или на существующем сервере)
 */
export async function deployVpnServer(options: ServerDeploymentOptions): Promise<{ success: boolean; serverId?: number; deploymentId?: string; error?: string }> {
  try {
    // Проверяем обязательные поля
    if (!options.name || !options.location || !options.provider) {
      return { success: false, error: 'Необходимо указать название, регион и провайдер' };
    }
    
    // Если не указан хост, создаем новый сервер в облаке
    let serverHost = options.host;
    
    if (!serverHost) {
      // Проверяем, поддерживается ли указанный провайдер
      const provider = cloudProviders[options.provider];
      if (!provider) {
        return { success: false, error: `Провайдер ${options.provider} не поддерживается` };
      }
      
      // Создаем новый сервер в облаке
      const createResult = await provider.createServer(options);
      if (!createResult.success || !createResult.ip) {
        return { success: false, error: createResult.error || 'Не удалось создать сервер' };
      }
      
      serverHost = createResult.ip;
    }
    
    // Создаем запись о сервере в базе данных
    const server = await prisma.vpnServer.create({
      data: {
        name: options.name,
        host: serverHost,
        port: options.port || 22,
        location: options.location,
        provider: options.provider,
        maxClients: options.maxClients || 50,
        isActive: true,
        currentClients: 0,
        isAutoScaled: options.isAutoScaled || false
      }
    });
    
    logger.info(`Сервер ${options.name} (${serverHost}) добавлен в базу данных с ID: ${server.id}`);
    
    // Генерируем уникальный ID для процесса развертывания
    const deploymentId = uuidv4();
    
    // Запускаем процесс развертывания в фоновом режиме
    deployVpnServerBackground(deploymentId, server);
    
    return { 
      success: true, 
      serverId: server.id,
      deploymentId
    };
  } catch (error: any) {
    logger.error(`Ошибка при запуске процесса развертывания: ${error.message}`);
    return { success: false, error: `Ошибка при развертывании: ${error.message}` };
  }
}

/**
 * Создает скрипт установки для указанного сервера
 */
function createInstallScript(server: any): string {
  return `#!/bin/bash

# Скрипт для развертывания Xray VPN сервера
# Версия: 2.0.0

# Обработка ошибок
set -e
trap 'echo "Произошла ошибка в строке $LINENO. Выход из скрипта."; exit 1' ERR

# Цветной вывод для лучшей читаемости
RED='\\x1b[0;31m'
GREEN='\\x1b[0;32m'
YELLOW='\\x1b[0;33m'
BLUE='\\x1b[0;34m'
NC='\\x1b[0m' # Сброс цвета

# Функция для вывода информации
log() {
    echo -e "\${BLUE}[INFO]\${NC} $1"
}

# Функция для вывода успешных операций
success() {
    echo -e "\${GREEN}[SUCCESS]\${NC} $1"
}

# Функция для вывода предупреждений
warning() {
    echo -e "\${YELLOW}[WARNING]\${NC} $1"
}

# Функция для вывода ошибок
error() {
    echo -e "\${RED}[ERROR]\${NC} $1"
}

# Функция проверки прав суперпользователя
check_root() {
    if [ "$(id -u)" -ne 0 ]; then
        error "Этот скрипт должен быть запущен с правами суперпользователя."
        exit 1
    fi
    success "Проверка прав: OK"
}

# Проверка наличия команды
check_command() {
    if ! command -v $1 &> /dev/null; then
        warning "Команда $1 не найдена. Устанавливаем..."
        return 1
    else
        log "Команда $1 найдена."
        return 0
    fi
}

# Обновление системы
update_system() {
    log "Обновление системных пакетов..."
    apt-get update -y
    apt-get upgrade -y
    success "Система обновлена"
}

# Установка необходимых зависимостей
install_dependencies() {
    log "Установка необходимых зависимостей..."
    apt-get install -y \\
        curl \\
        wget \\
        unzip \\
        socat \\
        cron \\
        iptables \\
        nginx \\
        certbot \\
        python3-certbot-nginx \\
        jq \\
        ufw \\
        lsb-release \\
        moreutils \\
        openssh-client

    success "Зависимости установлены"
}

# Установка Node.js (для API сервера)
install_nodejs() {
    if ! check_command node; then
        log "Установка Node.js 18.x..."
        curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
        apt-get install -y nodejs
        success "Node.js установлен: $(node -v)"
    fi

    if ! check_command pm2; then
        log "Установка PM2..."
        npm install -g pm2
        success "PM2 установлен: $(pm2 -v)"
    fi
}

# Установка BBR для улучшения сетевой производительности
enable_bbr() {
    log "Включение TCP BBR..."
    if ! grep -q "net.core.default_qdisc=fq" /etc/sysctl.conf; then
        echo "net.core.default_qdisc=fq" >> /etc/sysctl.conf
    fi
    
    if ! grep -q "net.ipv4.tcp_congestion_control=bbr" /etc/sysctl.conf; then
        echo "net.ipv4.tcp_congestion_control=bbr" >> /etc/sysctl.conf
    fi
    
    sysctl -p
    
    if lsmod | grep -q "bbr"; then
        success "TCP BBR включен"
    else
        warning "Не удалось включить TCP BBR. Производительность может быть ниже оптимальной."
    fi
}

# Настройка файрвола
setup_firewall() {
    log "Настройка файрвола..."
    
    # Разрешаем SSH, HTTP и HTTPS
    ufw allow ssh
    ufw allow http
    ufw allow https
    
    # Разрешаем порты для Xray
    ufw allow 443/tcp
    
    # Включаем файрвол, если он не включен
    if ! ufw status | grep -q "Status: active"; then
        echo "y" | ufw enable
    fi
    
    success "Файрвол настроен"
}

# Получение SSL сертификата
setup_ssl() {
    local domain=$1
    local email=$2
    
    log "Настройка SSL для домена: $domain"
    
    # Проверяем, доступен ли домен
    if [ -z "$domain" ] || [[ "$domain" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then
        warning "Указан IP-адрес или домен отсутствует. Пропускаем получение SSL сертификата."
        return 1
    fi
    
    # Настройка Nginx
    cat > /etc/nginx/sites-available/default << EOL
server {
    listen 80;
    listen [::]:80;
    
    root /var/www/html;
    index index.html index.htm;
    
    server_name \${domain};
    
    location / {
        try_files \$uri \$uri/ =404;
    }
}
EOL
    
    # Перезапускаем Nginx
    systemctl restart nginx
    
    # Получаем SSL-сертификат
    if [ -n "$email" ]; then
        certbot --nginx -d \${domain} --non-interactive --agree-tos --email \${email}
    else
        certbot --nginx -d \${domain} --non-interactive --agree-tos --register-unsafely-without-email
    fi
    
    # Проверяем, был ли успешно получен сертификат
    if [ -d "/etc/letsencrypt/live/\${domain}" ]; then
        success "SSL-сертификат успешно получен для \${domain}"
        
        # Настраиваем автообновление сертификата
        if ! crontab -l | grep -q "certbot renew"; then
            (crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet") | crontab -
            log "Настроено автоматическое обновление SSL-сертификатов (ежедневно в 3:00)"
        fi
        
        return 0
    else
        error "Не удалось получить SSL-сертификат для \${domain}"
        return 1
    fi
}

# Установка Xray
install_xray() {
    log "Установка Xray..."
    
    # Удаляем существующую установку Xray, если она есть
    if [ -f "/usr/local/bin/xray" ]; then
        log "Найдена существующая установка Xray. Удаляем..."
        bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ remove
    fi
    
    # Устанавливаем Xray
    bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
    
    # Проверяем, установлен ли Xray
    if [ -f "/usr/local/bin/xray" ]; then
        success "Xray установлен: $(/usr/local/bin/xray -version | head -n 1)"
    else
        error "Не удалось установить Xray."
        exit 1
    fi
    
    # Создаем необходимые директории
    mkdir -p /usr/local/etc/xray
    mkdir -p /var/log/xray
    
    # Устанавливаем права на директории
    chmod 700 /usr/local/etc/xray
    chmod 700 /var/log/xray
}

# Генерация UUID для клиентов
generate_uuid() {
    cat /proc/sys/kernel/random/uuid
}

# Создание базовой конфигурации Xray
configure_xray() {
    local domain=$1
    log "Настройка конфигурации Xray..."
    
    # Генерируем UUID для первого клиента
    local uuid=$(generate_uuid)
    
    # Определяем пути к сертификатам
    local cert_path="/etc/letsencrypt/live/\${domain}/fullchain.pem"
    local key_path="/etc/letsencrypt/live/\${domain}/privkey.pem"
    
    # Если домен не указан или используется IP, используем самоподписанные сертификаты
    if [ -z "$domain" ] || [[ "$domain" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then
        warning "Используется IP-адрес. Генерируем самоподписанные сертификаты..."
        
        # Создаем директорию для сертификатов
        mkdir -p /usr/local/etc/xray/ssl
        
        # Генерируем самоподписанный сертификат
        openssl req -x509 -newkey rsa:4096 -keyout /usr/local/etc/xray/ssl/private.key \\
            -out /usr/local/etc/xray/ssl/cert.pem -days 3650 -nodes \\
            -subj "/CN=\${domain:-localhost}"
        
        cert_path="/usr/local/etc/xray/ssl/cert.pem"
        key_path="/usr/local/etc/xray/ssl/private.key"
    fi
    
    # Создаем конфигурацию Xray
    cat > /usr/local/etc/xray/config.json << EOL
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
        "clients": [
          {
            "id": "\${uuid}",
            "flow": "xtls-rprx-vision",
            "email": "default-user"
          }
        ],
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
              "certificateFile": "\${cert_path}",
              "keyFile": "\${key_path}"
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
    
    # Устанавливаем правильные права на конфигурацию
    chmod 644 /usr/local/etc/xray/config.json
    
    # Генерируем конфигурацию для клиента
    log "Генерация конфигурации для клиента..."
    mkdir -p /root/xray-clients
    
    local client_config=$(cat << EOL
{
  "v": "2",
  "ps": "VPN-Server",
  "add": "\${domain}",
  "port": "443",
  "id": "\${uuid}",
  "aid": "0",
  "scy": "auto",
  "net": "tcp",
  "type": "none",
  "tls": "tls",
  "flow": "xtls-rprx-vision",
  "sni": ""
}
EOL
)
    
    # Сохраняем конфигурацию клиента
    echo "\${client_config}" > /root/xray-clients/client.json
    
    # Создаем QR-код, если qrencode установлен
    if check_command qrencode; then
        echo "\${client_config}" | qrencode -t ansiutf8 -o /root/xray-clients/client.qr
        log "QR-код создан в /root/xray-clients/client.qr"
    else
        apt-get install -y qrencode
        echo "\${client_config}" | qrencode -t ansiutf8 -o /root/xray-clients/client.qr
        log "QR-код создан в /root/xray-clients/client.qr"
    fi
    
    # Перезапускаем Xray
    systemctl restart xray
    systemctl enable xray
    
    # Проверяем статус Xray
    if systemctl is-active --quiet xray; then
        success "Xray успешно настроен и запущен"
    else
        error "Не удалось запустить Xray. Проверьте журналы: systemctl status xray"
        exit 1
    fi
    
    # Создаем инструкцию для пользователя
    cat > /root/xray-clients/README.txt << EOL
Информация о конфигурации VPN:

Сервер: \${domain}
Порт: 443
Протокол: VLESS
ID пользователя: \${uuid}
Flow: xtls-rprx-vision
TLS: включен
Network: tcp

Для подключения используйте клиент Xray или v2rayN.
Файл конфигурации находится в: /root/xray-clients/client.json
QR-код для быстрой настройки: /root/xray-clients/client.qr
EOL
    
    log "Инструкция по подключению создана в /root/xray-clients/README.txt"
    
    # Выводим информацию для импорта
    echo ""
    echo "======== ИНФОРМАЦИЯ ДЛЯ ПОДКЛЮЧЕНИЯ ========"
    echo "Сервер: \${domain}"
    echo "UUID пользователя: \${uuid}"
    echo "Конфигурация клиента сохранена в /root/xray-clients/client.json"
    echo "Инструкция по подключению: /root/xray-clients/README.txt"
    echo "============================================="
}

# Создание API для управления VPN
setup_api() {
    log "Настройка API для управления VPN..."
    
    # Создаем директорию для API
    mkdir -p /usr/local/bin/vpn-api
    
    # Создаем сервер API
    cat > /usr/local/bin/vpn-api/server.js << 'EOLJS'
const express = require('express');
const fs = require('fs');
const { execSync } = require('child_process');
const app = express();
const port = 3000;

app.use(express.json());

// Функция для генерации UUID
function generateUUID() {
  return execSync('cat /proc/sys/kernel/random/uuid').toString().trim();
}

// Функция для обновления конфигурации Xray
function updateXrayConfig(configData) {
  try {
    const configPath = '/usr/local/etc/xray/config.json';
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    let message = '';
    
    // Действие с клиентом
    if (configData.action === 'add') {
      // Генерируем UUID если не указан
      const clientId = configData.clientId || generateUUID();
      
      // Проверяем, существует ли клиент с таким ID
      const clientExists = config.inbounds[0].settings.clients.some(c => c.id === clientId);
      
      if (!clientExists) {
        // Добавить нового клиента
        config.inbounds[0].settings.clients.push({
          id: clientId,
          flow: "xtls-rprx-vision",
          email: configData.email || 'user-' + clientId.substring(0, 8)
        });
        message = 'Клиент ' + clientId + ' успешно добавлен';
      } else {
        return { success: false, message: 'Клиент с ID ' + clientId + ' уже существует' };
      }
    } else if (configData.action === 'remove') {
      // Удаление клиента
      if (!configData.clientId) {
        return { success: false, message: 'Необходимо указать clientId для удаления' };
      }
      
      const initialLength = config.inbounds[0].settings.clients.length;
      config.inbounds[0].settings.clients = config.inbounds[0].settings.clients.filter(c => c.id !== configData.clientId);
      
      if (config.inbounds[0].settings.clients.length === initialLength) {
        return { success: false, message: 'Клиент с ID ' + configData.clientId + ' не найден' };
      }
      
      message = 'Клиент ' + configData.clientId + ' успешно удален';
    } else if (configData.action === 'list') {
      // Просмотр списка клиентов
      return { 
        success: true, 
        clients: config.inbounds[0].settings.clients.map(c => ({
          id: c.id,
          email: c.email
        }))
      };
    } else {
      return { success: false, message: 'Неизвестное действие' };
    }
    
    // Обновляем конфигурацию
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    
    // Перезапускаем Xray
    execSync('systemctl restart xray');
    
    // Генерируем клиентскую конфигурацию, если добавлен новый клиент
    if (configData.action === 'add') {
      // Получаем домен из конфигурации
      const domain = configData.domain || execSync('hostname -f').toString().trim();
      
      // Создаем директорию для конфигураций клиентов
      if (!fs.existsSync('/root/xray-clients')) {
        fs.mkdirSync('/root/xray-clients', { recursive: true });
      }
      
      // Создаем конфигурацию для клиента
      const clientConfig = {
        v: "2",
        ps: configData.email || 'VPN-Client-' + configData.clientId.substring(0, 8),
        add: domain,
        port: "443",
        id: configData.clientId,
        aid: "0",
        scy: "auto",
        net: "tcp",
        type: "none",
        tls: "tls",
        flow: "xtls-rprx-vision",
        sni: ""
      };
      
      fs.writeFileSync('/root/xray-clients/' + configData.clientId + '.json', JSON.stringify(clientConfig, null, 2));
      
      // Добавляем информацию о созданной конфигурации
      message += '. Конфигурация клиента сохранена в /root/xray-clients/' + configData.clientId + '.json';
    }
    
    return { success: true, message };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

// Маршрут для управления клиентами
app.post('/api/clients', (req, res) => {
  const result = updateXrayConfig(req.body);
  if (result.success) {
    res.status(200).json(result);
  } else {
    res.status(400).json(result);
  }
});

// Маршрут для получения статуса сервера
app.get('/api/status', (req, res) => {
  try {
    // Проверяем, работает ли Xray
    const xrayStatus = execSync('systemctl is-active xray').toString().trim();
    
    // Получаем версию Xray
    const xrayVersion = execSync('/usr/local/bin/xray -version | head -n 1').toString().trim();
    
    // Получаем информацию о системе
    const uptime = execSync('uptime -p').toString().trim();
    const memory = execSync('free -m | grep Mem').toString().trim().split(/\s+/);
    const disk = execSync('df -h / | tail -n 1').toString().trim().split(/\s+/);
    const load = execSync('cat /proc/loadavg').toString().trim().split(' ').slice(0, 3);
    
    res.json({
      status: xrayStatus === 'active' ? 'running' : 'stopped',
      xrayVersion,
      system: {
        uptime,
        memory: {
          total: parseInt(memory[1]),
          used: parseInt(memory[2]),
          free: parseInt(memory[3])
        },
        disk: {
          total: disk[1],
          used: disk[2],
          free: disk[3],
          usage: disk[4]
        },
        load
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Запуск сервера
app.listen(port, '127.0.0.1', () => {
  console.log('API сервер запущен на порту ' + port);
});
EOLJS
    
    # Создаем package.json для API
    cat > /usr/local/bin/vpn-api/package.json << EOL
{
  "name": "vpn-api",
  "version": "1.0.0",
  "description": "API для управления VPN-сервером",
  "main": "server.js",
  "dependencies": {
    "express": "^4.18.2"
  }
}
EOL
    
    # Устанавливаем зависимости
    cd /usr/local/bin/vpn-api
    npm install
    
    # Создаем системную службу для API
    cat > /etc/systemd/system/vpn-api.service << EOL
[Unit]
Description=VPN API Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/usr/local/bin/vpn-api
ExecStart=/usr/bin/node /usr/local/bin/vpn-api/server.js
Restart=on-failure
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=vpn-api

[Install]
WantedBy=multi-user.target
EOL
    
    # Запускаем и включаем службу
    systemctl daemon-reload
    systemctl start vpn-api
    systemctl enable vpn-api
    
    # Проверяем, запущена ли служба
    if systemctl is-active --quiet vpn-api; then
        success "API сервер успешно настроен и запущен"
    else
        warning "Не удалось запустить API сервер. Проверьте журналы: systemctl status vpn-api"
    fi
}

# Главная функция
main() {
    # Параметры
    local domain="${server.host}"
    local email="admin@example.com"
    
    log "Начало установки Xray VPN сервера..."
    log "Домен/IP: \${domain}"
    
    # Проверка прав суперпользователя
    check_root
    
    # Обновление системы
    update_system
    
    # Установка зависимостей
    install_dependencies
    
    # Установка Node.js
    install_nodejs
    
    # Включение BBR
    enable_bbr
    
    # Настройка файрвола
    setup_firewall
    
    # Установка SSL (если указан домен)
    if [ -n "$domain" ] && ! [[ "$domain" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then
        setup_ssl "$domain" "$email"
    fi
    
    # Установка Xray
    install_xray
    
    # Настройка Xray
    configure_xray "$domain"
    
    # Настройка API
    setup_api
    
    success "Установка и настройка Xray VPN сервера завершена!"
    
    # Вывод информации о сервере
    echo ""
    echo "===================== ИТОГИ УСТАНОВКИ ====================="
    echo "Xray VPN сервер успешно установлен и настроен!"
    echo "Xray версия: $(/usr/local/bin/xray -version | head -n 1)"
    echo ""
    echo "Файл конфигурации: /usr/local/etc/xray/config.json"
    echo "API доступен по адресу: http://127.0.0.1:3000/api"
    echo ""
    echo "Статус служб:"
    echo "Xray: $(systemctl is-active xray)"
    echo "API сервер: $(systemctl is-active vpn-api)"
    echo ""
    echo "Конфигурация клиента сохранена в: /root/xray-clients/"
    echo "Инструкция по подключению: /root/xray-clients/README.txt"
    echo "============================================================"
}

# Запуск установки
main "$@"`;
}

// Объект для хранения процессов развертывания и их статусов
interface DeploymentProcess {
  status: 'running' | 'completed' | 'failed';
  serverId?: number;
  logs: string;
  error?: string;
}

const deployments: Record<string, DeploymentProcess> = {};

/**
 * Функция для запуска процесса развертывания VPN сервера в фоновом режиме
 */
export async function deployVpnServerBackground(deploymentId: string, server: any): Promise<void> {
  try {
    // Создаем запись о процессе развертывания
    deployments[deploymentId] = {
      status: 'running',
      serverId: server.id,
      logs: `Начало развертывания сервера ${server.name} (${server.host})...\n`
    };
    
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
    
    // Создаем скрипт для установки Xray
    const installScriptPath = path.join(installDir, `install_xray_${deploymentId}.sh`);
    
    // Добавляем запись в логи
    deployments[deploymentId].logs += `Подготовка скрипта установки...\n`;
    
    // Создаем скрипт установки
    const installScript = createInstallScript(server);
    
    fs.writeFileSync(installScriptPath, installScript);
    fs.chmodSync(installScriptPath, '755');
    
    // Добавляем запись в логи
    deployments[deploymentId].logs += `Скрипт установки создан.\nКопирование скрипта на сервер ${server.host}...\n`;
    
    // Копируем скрипт на сервер
    try {
      execSync(`scp -o StrictHostKeyChecking=no -i ${sshKeyPath} -P ${server.port} ${installScriptPath} ${config.sshUser}@${server.host}:/tmp/install_xray.sh`);
      deployments[deploymentId].logs += `Скрипт успешно скопирован на сервер.\nЗапуск установки Xray...\n`;
    } catch (error: any) {
      deployments[deploymentId].status = 'failed';
      deployments[deploymentId].error = `Ошибка при копировании скрипта на сервер: ${error.message}`;
      logger.error(deployments[deploymentId].error);
      return;
    }
    
    // Запускаем процесс установки на удаленном сервере
    const sshProcess = spawn('ssh', [
      '-o', 'StrictHostKeyChecking=no',
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

/**
 * Получение статуса развертывания
 */
export function getDeploymentStatus(deploymentId: string): DeploymentProcess | null {
  return deployments[deploymentId] || null;
} 