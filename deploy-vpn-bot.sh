#!/bin/bash

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Функция для вывода сообщений
log() {
  echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')] $1${NC}"
}

error() {
  echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ОШИБКА: $1${NC}"
  exit 1
}

warn() {
  echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] ВНИМАНИЕ: $1${NC}"
}

info() {
  echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')] ИНФО: $1${NC}"
}

# Проверка root прав
if [ "$EUID" -ne 0 ]; then
  error "Этот скрипт должен быть запущен с правами root!"
fi

# Проверка аргументов
REPO_URL="https://github.com/theDeemoonn/vpn-tg-bot.git"
INSTALL_DIR="/opt/vpn-bot"
DOMAIN=""

# Парсинг аргументов
while [[ "$#" -gt 0 ]]; do
  case $1 in
    --repo) REPO_URL="$2"; shift ;;
    --dir) INSTALL_DIR="$2"; shift ;;
    --domain) DOMAIN="$2"; shift ;;
    *) error "Неизвестный параметр: $1" ;;
  esac
  shift
done

log "Начало установки VPN-бота..."
log "Репозиторий: $REPO_URL"
log "Каталог установки: $INSTALL_DIR"
if [ -n "$DOMAIN" ]; then
  log "Домен: $DOMAIN"
else
  warn "Домен не указан. SSL-сертификат не будет настроен."
fi

# Обновление системы
log "Обновление системы..."
apt update || error "Не удалось обновить пакеты"
apt upgrade -y || warn "Не удалось обновить систему полностью"

# Установка необходимых пакетов
log "Установка необходимых пакетов..."
apt install -y apt-transport-https ca-certificates curl software-properties-common git ufw nginx || error "Не удалось установить необходимые пакеты"

# Установка Docker
log "Установка Docker..."
if ! command -v docker &> /dev/null; then
  curl -fsSL https://get.docker.com -o get-docker.sh || error "Не удалось загрузить скрипт установки Docker"
  sh get-docker.sh || error "Не удалось установить Docker"
  rm get-docker.sh
else
  info "Docker уже установлен, пропускаем..."
fi

# Установка Docker Compose
log "Установка Docker Compose..."
if ! command -v docker compose &> /dev/null; then
  apt install -y docker-compose-plugin || error "Не удалось установить Docker Compose"
else
  info "Docker Compose уже установлен, пропускаем..."
fi

# Настройка Firewall
log "Настройка Firewall..."
ufw allow 22/tcp || warn "Не удалось настроить правило для SSH"
ufw allow 80/tcp || warn "Не удалось настроить правило для HTTP"
ufw allow 443/tcp || warn "Не удалось настроить правило для HTTPS"
ufw allow 3000/tcp || warn "Не удалось настроить правило для порта приложения"
ufw allow 1194/udp || warn "Не удалось настроить правило для OpenVPN"
ufw --force enable || warn "Не удалось включить Firewall"

# Создание директории для проекта
log "Создание директории для проекта..."
mkdir -p "$INSTALL_DIR" || error "Не удалось создать директорию для проекта"
cd "$INSTALL_DIR" || error "Не удалось перейти в директорию проекта"

# Клонирование репозитория
log "Клонирование репозитория..."
if [ -d ".git" ]; then
  git pull || warn "Не удалось обновить репозиторий"
else
  git clone "$REPO_URL" . || error "Не удалось клонировать репозиторий"
fi

# Создание директорий
log "Создание необходимых директорий..."
mkdir -p logs keys backups || warn "Не удалось создать некоторые директории"

# Генерация SSH ключа
log "Генерация SSH ключа для автоматического развертывания..."
if [ ! -f "./keys/id_rsa" ]; then
  ssh-keygen -t rsa -b 4096 -f ./keys/id_rsa -N "" || warn "Не удалось сгенерировать SSH ключ"
  log "Публичный SSH ключ (добавьте его в DigitalOcean и запишите ID в .env):"
  cat ./keys/id_rsa.pub
else
  info "SSH ключ уже существует, пропускаем..."
  log "Публичный SSH ключ (если вы еще не добавили его в DigitalOcean):"
  cat ./keys/id_rsa.pub
fi

# Создание .env.example если его нет
if [ ! -f ".env.example" ]; then
  log "Создание примера .env файла..."
  cat > .env.example << 'EOL'
# Telegram Bot
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_BOT_USERNAME=your_bot_username
ADMIN_CHAT_ID=your_admin_chat_id

# Database
POSTGRES_USER=postgres
POSTGRES_PASSWORD=secure_password_here
POSTGRES_DB=vpn_bot
DATABASE_URL=postgresql://postgres:secure_password_here@postgres:5432/vpn_bot?schema=public

# YooKassa API
YOOKASSA_SHOP_ID=your_shop_id
YOOKASSA_SECRET_KEY=your_secret_key

# Server
PORT=3000
HOST=0.0.0.0

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

# DigitalOcean API доступ
DO_API_KEY=
DO_SSH_KEY_ID=

# Настройки масштабирования
DEFAULT_PROVIDER=DigitalOcean
DEFAULT_MAX_CLIENTS=100
DEPLOYMENT_REGIONS=amsterdam,frankfurt,london

# Пороги для автомасштабирования
AUTO_SCALING_CPU_THRESHOLD=80
AUTO_SCALING_MEMORY_THRESHOLD=80
AUTO_SCALING_CONNECTION_THRESHOLD=90

# Auto Renewal Settings
ENABLE_AUTO_RENEWAL=true
REMINDER_DAYS=7,3,1
YOOKASSA_AUTO_PAYMENT_METHOD_ID=

# Payment Systems
ENABLE_TELEGRAM_PAYMENTS=true
TELEGRAM_PAYMENT_TOKEN=381764678:TEST:117591
PAYMENT_RETURN_URL=http://your-domain.com/payment/return

# QR Code Settings
QR_CODE_SIZE=300

# ЮKassa Telegram интеграция
YOOKASSA_TELEGRAM_ENABLED=false
YOOKASSA_TELEGRAM_WEBHOOK_URL=

# Fiscalization (чеки)
ENABLE_FISCALIZATION=false
FISCALIZATION_DEFAULT_EMAIL=client@example.com
FISCALIZATION_VAT_CODE=1

# Отключаем создание тестовых данных
CREATE_TEST_DATA=false
EOL
fi

# Проверка наличия .env файла
if [ ! -f ".env" ]; then
  log "Копирование .env.example в .env..."
  cp .env.example .env || warn "Не удалось создать файл .env"
  log "Пожалуйста, отредактируйте файл .env и заполните необходимые переменные окружения"
  log "Путь к файлу: $INSTALL_DIR/.env"
else
  info ".env файл уже существует. Убедитесь, что в нем заполнены все необходимые переменные."
fi

# Настройка Nginx
log "Настройка Nginx..."
if [ -n "$DOMAIN" ]; then
  cat > /etc/nginx/sites-available/vpn-bot.conf << EOL
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
EOL
else
  cat > /etc/nginx/sites-available/vpn-bot.conf << 'EOL'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    location /admin {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
EOL
fi

# Активация конфигурации Nginx
ln -sf /etc/nginx/sites-available/vpn-bot.conf /etc/nginx/sites-enabled/ || warn "Не удалось активировать конфигурацию Nginx"
nginx -t || warn "Проверка конфигурации Nginx завершилась с ошибками"
systemctl restart nginx || warn "Не удалось перезапустить Nginx"

# Настройка SSL (если указан домен)
if [ -n "$DOMAIN" ]; then
  log "Настройка SSL для домена $DOMAIN..."
  apt install -y certbot python3-certbot-nginx || warn "Не удалось установить Certbot"
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email admin@"$DOMAIN" || warn "Не удалось настроить SSL сертификат"
fi

# Создание скриптов для обслуживания
log "Создание скриптов для обслуживания..."

# Скрипт запуска
cat > "$INSTALL_DIR/start.sh" << 'EOL'
#!/bin/bash
cd "$(dirname "$0")"
if [ ! -f ".env" ]; then
  echo "ОШИБКА: Файл .env не найден. Пожалуйста, создайте его на основе .env.example"
  exit 1
fi

# Проверяем, настроены ли основные переменные для работы
if grep -q "TELEGRAM_BOT_TOKEN=" .env || ! grep -q "DATABASE_URL=" .env; then
  echo "ОШИБКА: Необходимые переменные окружения не настроены в файле .env"
  echo "Пожалуйста, отредактируйте файл .env и заполните все необходимые переменные"
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

# Запускаем инициализацию базы данных (без тестовых данных)
echo "Инициализация базы данных..."
docker-compose exec -T app npx prisma db seed

echo "VPN-бот успешно запущен!"
echo "Админ-панель доступна по адресу: http://localhost:3001/admin"
echo "Логин: admin"
echo "Пароль: admin"
EOL
chmod +x "$INSTALL_DIR/start.sh" || warn "Не удалось установить права на скрипт запуска"

# Скрипт остановки
cat > "$INSTALL_DIR/stop.sh" << 'EOL'
#!/bin/bash
cd "$(dirname "$0")"
docker-compose down
echo "VPN-бот остановлен."
EOL
chmod +x "$INSTALL_DIR/stop.sh" || warn "Не удалось установить права на скрипт остановки"

# Скрипт обновления
cat > "$INSTALL_DIR/update.sh" << 'EOL'
#!/bin/bash
cd "$(dirname "$0")"
git pull
docker-compose down
docker-compose build
docker-compose up -d
echo "Ожидание запуска контейнеров (20 секунд)..."
sleep 20
docker-compose exec -T app npx prisma migrate deploy
echo "VPN-бот обновлен!"
EOL
chmod +x "$INSTALL_DIR/update.sh" || warn "Не удалось установить права на скрипт обновления"

# Скрипт для бэкапа базы данных
cat > "$INSTALL_DIR/backup.sh" << 'EOL'
#!/bin/bash
cd "$(dirname "$0")"
DATE=$(date +%Y-%m-%d_%H-%M-%S)
docker-compose exec -T postgres pg_dump -U postgres vpn_bot > ./backups/vpn_bot_$DATE.sql
echo "Бэкап базы данных создан: ./backups/vpn_bot_$DATE.sql"
EOL
chmod +x "$INSTALL_DIR/backup.sh" || warn "Не удалось установить права на скрипт бэкапа"

# Добавление задач в cron
log "Настройка планировщика задач..."
(crontab -l 2>/dev/null || echo "") | grep -v "$INSTALL_DIR" > /tmp/crontab.tmp
echo "0 4 * * 0 $INSTALL_DIR/update.sh >> /var/log/vpn-bot-update.log 2>&1" >> /tmp/crontab.tmp
echo "0 2 * * * $INSTALL_DIR/backup.sh >> /var/log/vpn-bot-backup.log 2>&1" >> /tmp/crontab.tmp
crontab /tmp/crontab.tmp || warn "Не удалось настроить планировщик задач"
rm /tmp/crontab.tmp

# Завершение
log "============================================="
log "Установка VPN-бота завершена!"
log ""
log "Что дальше:"
log "1. Отредактируйте файл .env: $INSTALL_DIR/.env"
log "   * Обязательно укажите TELEGRAM_BOT_TOKEN и настройки базы данных"
log "   * Для автоматического развертывания VPN серверов укажите DO_API_KEY и DO_SSH_KEY_ID"
log ""
log "2. Запустите бота командой: $INSTALL_DIR/start.sh"
log ""
log "3. Войдите в админ-панель:"
log "   Логин: admin"
log "   Пароль: admin"
log ""
log "4. ВАЖНО: после первого входа в админ-панель смените пароль администратора!"
log ""
log "Другие команды:"
log "- Остановить бота: $INSTALL_DIR/stop.sh"
log "- Обновить бота: $INSTALL_DIR/update.sh"
log "- Сделать бэкап: $INSTALL_DIR/backup.sh"
log ""
if [ -n "$DOMAIN" ]; then
  log "Бот будет доступен по адресу: https://$DOMAIN"
  log "Админ-панель: https://$DOMAIN/admin"
else
  log "Бот будет доступен по адресу: http://ваш_ip:3000"
  log "Админ-панель: http://ваш_ip:3001"
fi
log "=============================================" 