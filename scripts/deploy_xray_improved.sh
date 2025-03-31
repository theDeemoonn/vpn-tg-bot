#!/bin/bash

# Скрипт для развертывания Xray VPN сервера
# Версия: 2.0.0
# Дата: 2025-03-31

# Обработка ошибок
set -e
trap 'echo "Произошла ошибка в строке $LINENO. Выход из скрипта."; exit 1' ERR

# Цветной вывод для лучшей читаемости
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # Сброс цвета

# Функция для вывода информации
log() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

# Функция для вывода успешных операций
success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

# Функция для вывода предупреждений
warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

# Функция для вывода ошибок
error() {
    echo -e "${RED}[ERROR]${NC} $1"
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
    apt-get install -y \
        curl \
        wget \
        unzip \
        socat \
        cron \
        iptables \
        nginx \
        certbot \
        python3-certbot-nginx \
        jq \
        ufw \
        lsb-release \
        moreutils

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
    if [ -z "$domain" ] || [[ "$domain" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
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
    
    server_name ${domain};
    
    location / {
        try_files \$uri \$uri/ =404;
    }
}
EOL
    
    # Перезапускаем Nginx
    systemctl restart nginx
    
    # Получаем SSL-сертификат
    if [ -n "$email" ]; then
        certbot --nginx -d ${domain} --non-interactive --agree-tos --email ${email}
    else
        certbot --nginx -d ${domain} --non-interactive --agree-tos --register-unsafely-without-email
    fi
    
    # Проверяем, был ли успешно получен сертификат
    if [ -d "/etc/letsencrypt/live/${domain}" ]; then
        success "SSL-сертификат успешно получен для ${domain}"
        
        # Настраиваем автообновление сертификата
        if ! crontab -l | grep -q "certbot renew"; then
            (crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet") | crontab -
            log "Настроено автоматическое обновление SSL-сертификатов (ежедневно в 3:00)"
        fi
        
        return 0
    else
        error "Не удалось получить SSL-сертификат для ${domain}"
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
    local cert_path="/etc/letsencrypt/live/${domain}/fullchain.pem"
    local key_path="/etc/letsencrypt/live/${domain}/privkey.pem"
    
    # Если домен не указан или используется IP, используем самоподписанные сертификаты
    if [ -z "$domain" ] || [[ "$domain" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        warning "Используется IP-адрес. Генерируем самоподписанные сертификаты..."
        
        # Создаем директорию для сертификатов
        mkdir -p /usr/local/etc/xray/ssl
        
        # Генерируем самоподписанный сертификат
        openssl req -x509 -newkey rsa:4096 -keyout /usr/local/etc/xray/ssl/private.key \
            -out /usr/local/etc/xray/ssl/cert.pem -days 3650 -nodes \
            -subj "/CN=${domain:-localhost}"
        
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
            "id": "${uuid}",
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
              "certificateFile": "${cert_path}",
              "keyFile": "${key_path}"
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
  "add": "${domain}",
  "port": "443",
  "id": "${uuid}",
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
    echo "${client_config}" > /root/xray-clients/client.json
    
    # Создаем QR-код, если qrencode установлен
    if check_command qrencode; then
        echo "${client_config}" | qrencode -t ansiutf8 -o /root/xray-clients/client.qr
        log "QR-код создан в /root/xray-clients/client.qr"
    else
        apt-get install -y qrencode
        echo "${client_config}" | qrencode -t ansiutf8 -o /root/xray-clients/client.qr
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

Сервер: ${domain}
Порт: 443
Протокол: VLESS
ID пользователя: ${uuid}
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
    echo "Сервер: ${domain}"
    echo "UUID пользователя: ${uuid}"
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
    cat > /usr/local/bin/vpn-api/server.js << 'EOL'
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
          email: configData.email || `user-${clientId.substring(0, 8)}`
        });
        message = `Клиент ${clientId} успешно добавлен`;
      } else {
        return { success: false, message: `Клиент с ID ${clientId} уже существует` };
      }
    } else if (configData.action === 'remove') {
      // Удаление клиента
      if (!configData.clientId) {
        return { success: false, message: 'Необходимо указать clientId для удаления' };
      }
      
      const initialLength = config.inbounds[0].settings.clients.length;
      config.inbounds[0].settings.clients = config.inbounds[0].settings.clients.filter(c => c.id !== configData.clientId);
      
      if (config.inbounds[0].settings.clients.length === initialLength) {
        return { success: false, message: `Клиент с ID ${configData.clientId} не найден` };
      }
      
      message = `Клиент ${configData.clientId} успешно удален`;
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
        ps: configData.email || `VPN-Client-${configData.clientId.substring(0, 8)}`,
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
      
      fs.writeFileSync(`/root/xray-clients/${configData.clientId}.json`, JSON.stringify(clientConfig, null, 2));
      
      // Добавляем информацию о созданной конфигурации
      message += `. Конфигурация клиента сохранена в /root/xray-clients/${configData.clientId}.json`;
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
  console.log(`API сервер запущен на порту ${port}`);
});
EOL
    
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

# Функция настройки мониторинга
setup_monitoring() {
    log "Настройка мониторинга..."
    
    # Создаем скрипт для сбора статистики
    cat > /usr/local/bin/vpn-monitor.sh << 'EOL'
#!/bin/bash

# Файл для записи статистики
STATS_FILE="/var/log/xray/stats.json"

# Получаем использование CPU
CPU_USAGE=$(top -bn1 | grep "Cpu(s)" | sed "s/.*, *\([0-9.]*\)%* id.*/\1/" | awk '{print 100 - $1}')

# Получаем использование памяти
MEM_TOTAL=$(free -m | grep Mem | awk '{print $2}')
MEM_USED=$(free -m | grep Mem | awk '{print $3}')
MEM_PERCENT=$(echo "scale=2; $MEM_USED*100/$MEM_TOTAL" | bc)

# Получаем использование диска
DISK_USAGE=$(df -h / | tail -n 1 | awk '{print $5}' | sed 's/%//')

# Получаем количество подключений
CONNECTIONS=$(netstat -an | grep ESTABLISHED | wc -l)

# Получаем количество клиентов Xray
XRAY_CLIENTS=$(cat /usr/local/etc/xray/config.json | jq '.inbounds[0].settings.clients | length')

# Создаем JSON с данными
cat > $STATS_FILE << EOF
{
  "timestamp": "$(date +%s)",
  "cpu_usage": $CPU_USAGE,
  "memory_usage": $MEM_PERCENT,
  "disk_usage": $DISK_USAGE,
  "connections": $CONNECTIONS,
  "xray_clients": $XRAY_CLIENTS
}
EOF

# Выводим статистику
echo "Статистика системы сохранена в $STATS_FILE"
EOL
    
    # Делаем скрипт исполняемым
    chmod +x /usr/local/bin/vpn-monitor.sh
    
    # Добавляем в cron для запуска каждые 5 минут
    if ! crontab -l | grep -q "vpn-monitor.sh"; then
        (crontab -l 2>/dev/null; echo "*/5 * * * * /usr/local/bin/vpn-monitor.sh > /dev/null 2>&1") | crontab -
        log "Настроен мониторинг системы (каждые 5 минут)"
    fi
    
    # Запускаем первый раз
    /usr/local/bin/vpn-monitor.sh
    
    success "Мониторинг успешно настроен"
}

# Главная функция
main() {
    # Параметры
    local domain=${1:-""}
    local email=${2:-"admin@example.com"}
    
    log "Начало установки Xray VPN сервера..."
    log "Домен: ${domain:-"IP-адрес"}"
    
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
    if [ -n "$domain" ] && ! [[ "$domain" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        setup_ssl "$domain" "$email"
    else
        warning "Используется IP-адрес вместо домена. SSL-сертификат не будет установлен автоматически."
    fi
    
    # Установка Xray
    install_xray
    
    # Настройка Xray
    configure_xray "$domain"
    
    # Настройка API
    setup_api
    
    # Настройка мониторинга
    setup_monitoring
    
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
main "$@" 