#!/bin/bash

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Функции для вывода сообщений
log() { echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')] $1${NC}"; }
error() { echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ОШИБКА: $1${NC}"; exit 1; }
warn() { echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] ВНИМАНИЕ: $1${NC}"; }
info() { echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')] ИНФО: $1${NC}"; }

# Проверка прав root
if [ "$EUID" -ne 0 ]; then
  error "Этот скрипт должен быть запущен с правами root на сервере!"
fi

# Настройка параметров
REPO_URL="https://github.com/theDeemoonn/vpn-tg-bot.git"
DOMAIN=""

# Парсинг аргументов
while [[ "$#" -gt 0 ]]; do
  case $1 in
    --repo) REPO_URL="$2"; shift ;;
    --domain) DOMAIN="$2"; shift ;;
    *) echo "Неизвестный параметр: $1"; exit 1 ;;
  esac
  shift
done

log "Начало установки VPN-бота..."
log "Репозиторий: $REPO_URL"

# Обновление системы
log "Обновление системы..."
apt update
apt upgrade -y

# Установка необходимых пакетов
log "Установка необходимых пакетов..."
apt install -y apt-transport-https ca-certificates curl software-properties-common git ufw nginx

# Установка Docker
log "Установка Docker..."
if ! command -v docker &> /dev/null; then
  curl -fsSL https://get.docker.com -o get-docker.sh
  sh get-docker.sh
  rm get-docker.sh
else
  info "Docker уже установлен"
fi

# Установка Docker Compose
log "Установка Docker Compose..."
if ! command -v docker compose &> /dev/null; then
  apt install -y docker-compose-plugin
else
  info "Docker Compose уже установлен"
fi

# Настройка Firewall
log "Настройка Firewall..."
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3000/tcp
ufw allow 3001/tcp
ufw allow 1194/udp
ufw --force enable

# Создание директории для проекта
log "Создание директории для проекта..."
mkdir -p /opt/vpn-bot
cd /opt/vpn-bot

# Клонирование репозитория
log "Клонирование репозитория..."
if [ -d ".git" ]; then
  git pull
else
  git clone "$REPO_URL" .
fi

# Создание директорий
log "Создание необходимых директорий..."
mkdir -p logs keys backups

# Генерация SSH ключа
log "Генерация SSH ключа..."
if [ ! -f "./keys/id_rsa" ]; then
  ssh-keygen -t rsa -b 4096 -f ./keys/id_rsa -N ""
  log "Публичный SSH ключ:"
  cat ./keys/id_rsa.pub
fi

# Настройка .env файла
log "Настройка .env файла..."
if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
    # Устанавливаем начальные параметры
    LOCAL_IP=$(hostname -I | awk '{print $1}')
    sed -i "s|^HOST=.*|HOST=$LOCAL_IP|g" .env
    sed -i "s|^SSH_PRIVATE_KEY_PATH=.*|SSH_PRIVATE_KEY_PATH=/opt/vpn-bot/keys/id_rsa|g" .env
    sed -i "s|^CREATE_TEST_DATA=.*|CREATE_TEST_DATA=false|g" .env
    log "Файл .env создан на основе примера"
  else
    log "Создаем базовый .env файл..."
    cat > .env << EOF
# Telegram Bot
TELEGRAM_BOT_TOKEN=7769413832:AAEphj7DB4nDhjpUs06WHMuWAiB9QpKmRfI
TELEGRAM_BOT_USERNAME=vpn_ug_bot
ADMIN_CHAT_ID=733510

# Database
POSTGRES_USER=postgres
POSTGRES_PASSWORD=secure_password_here
POSTGRES_DB=vpn_bot
DATABASE_URL=postgresql://postgres:secure_password_here@postgres:5432/vpn_bot?schema=public

# YooKassa API
YOOKASSA_SHOP_ID=1058968
YOOKASSA_SECRET_KEY=test_dpRoHy3tpS_5hR3iSlHFalxBg1jn5ErZfujIVKGTn2Y

# Server
PORT=3000
HOST=$LOCAL_IP

# VPN Configuration
DEFAULT_DOWNLOAD_SPEED=10
DEFAULT_UPLOAD_SPEED=10
TORRENT_ALLOWED=false

# Subscription plans
MONTHLY_SUBSCRIPTION_PRICE=299
QUARTERLY_SUBSCRIPTION_PRICE=799
ANNUAL_SUBSCRIPTION_PRICE=2999

# VPN Server Deployment
SSH_PRIVATE_KEY_PATH=/opt/vpn-bot/keys/id_rsa
SSH_USER=root

# Auto Renewal Settings
ENABLE_AUTO_RENEWAL=true
REMINDER_DAYS=7,3,1

# Payment Systems
ENABLE_TELEGRAM_PAYMENTS=true
TELEGRAM_PAYMENT_TOKEN=381764678:TEST:117591
PAYMENT_RETURN_URL=http://$LOCAL_IP/payment/return

# Отключаем создание тестовых данных
CREATE_TEST_DATA=false
EOF
  fi
else
  log "Файл .env уже существует"
fi

# Настройка Nginx
log "Настройка Nginx..."
if [ -n "$DOMAIN" ]; then
  cat > /etc/nginx/sites-available/vpn-bot.conf << EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }

    location /admin {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF

  # Настройка SSL
  apt install -y certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email admin@"$DOMAIN" || warn "Не удалось настроить SSL"
else
  cat > /etc/nginx/sites-available/vpn-bot.conf << EOF
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }

    location /admin {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF
fi

# Активация конфигурации Nginx
ln -sf /etc/nginx/sites-available/vpn-bot.conf /etc/nginx/sites-enabled/
nginx -t && systemctl restart nginx

# Создание скриптов для обслуживания
log "Создание скриптов для обслуживания..."

# Скрипт запуска
cat > "/opt/vpn-bot/start.sh" << 'EOF'
#!/bin/bash
cd "$(dirname "$0")"
if [ ! -f ".env" ]; then
  echo "ОШИБКА: Файл .env не найден"
  exit 1
fi

# Запускаем контейнеры
echo "Запуск Docker контейнеров..."
docker-compose up -d

# Ждем, пока база данных запустится
echo "Ожидание запуска базы данных (20 секунд)..."
sleep 20

# Применяем миграции
echo "Применение миграций базы данных..."
docker-compose exec -T app npx prisma migrate deploy

# Запускаем инициализацию базы данных
echo "Инициализация базы данных..."
docker-compose exec -T app npx prisma db seed

echo "VPN-бот успешно запущен!"
echo "Админ-панель доступна по адресу: http://localhost:3001/admin"
echo "Логин: admin"
echo "Пароль: admin123"
EOF
chmod +x "/opt/vpn-bot/start.sh"

# Скрипт остановки
cat > "/opt/vpn-bot/stop.sh" << 'EOF'
#!/bin/bash
cd "$(dirname "$0")"
docker-compose down
echo "VPN-бот остановлен."
EOF
chmod +x "/opt/vpn-bot/stop.sh"

# Скрипт обновления
cat > "/opt/vpn-bot/update.sh" << 'EOF'
#!/bin/bash
cd "$(dirname "$0")"
git pull
docker-compose down
docker-compose build
docker-compose up -d
sleep 20
docker-compose exec -T app npx prisma migrate deploy
echo "VPN-бот обновлен!"
EOF
chmod +x "/opt/vpn-bot/update.sh"

# Скрипт бэкапа
cat > "/opt/vpn-bot/backup.sh" << 'EOF'
#!/bin/bash
cd "$(dirname "$0")"
DATE=$(date +%Y-%m-%d_%H-%M-%S)
docker-compose exec -T postgres pg_dump -U postgres vpn_bot > ./backups/vpn_bot_$DATE.sql
echo "Бэкап базы данных создан: ./backups/vpn_bot_$DATE.sql"
EOF
chmod +x "/opt/vpn-bot/backup.sh"

# Планировщик задач
(crontab -l 2>/dev/null || echo "") | grep -v "/opt/vpn-bot/" > /tmp/crontab.tmp
echo "0 4 * * 0 /opt/vpn-bot/update.sh >> /var/log/vpn-bot-update.log 2>&1" >> /tmp/crontab.tmp
echo "0 2 * * * /opt/vpn-bot/backup.sh >> /var/log/vpn-bot-backup.log 2>&1" >> /tmp/crontab.tmp
crontab /tmp/crontab.tmp
rm /tmp/crontab.tmp

log "============================================="
log "Установка VPN-бота завершена!"
log ""
log "1. Отредактируйте файл .env: nano /opt/vpn-bot/.env"
log "   Укажите TELEGRAM_BOT_TOKEN и настройте пароли для базы данных"
log ""
log "2. Запустите бота командой: /opt/vpn-bot/start.sh"
log ""
log "Админ доступ:"
log "- Логин: admin"
log "- Пароль: admin"
log ""
log "ВАЖНО: После первого входа смените пароль администратора!"
log "============================================="