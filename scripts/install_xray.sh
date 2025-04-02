#!/bin/bash

# Скрипт для развертывания Xray VPN сервера
# Версия: 2.1.2

# --- Плейсхолдеры для замены ---
# Заменяются перед копированием на сервер
SERVER_HOST="PLACEHOLDER_SERVER_HOST"
ADMIN_EMAIL="PLACEHOLDER_ADMIN_EMAIL"
SERVER_SSH_PORT="PLACEHOLDER_SERVER_SSH_PORT"
# ------------------------------

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
        return 1
    else
        return 0
    fi
}

# Обновление системы
update_system() {
    log "Обновление системных пакетов..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get -o Dpkg::Options::="--force-confold" -o Dpkg::Options::="--force-confdef" upgrade -y
    apt-get -o Dpkg::Options::="--force-confold" -o Dpkg::Options::="--force-confdef" dist-upgrade -y
    apt-get autoremove -y
    apt-get clean
    success "Система обновлена"
}

# Установка необходимых зависимостей
install_dependencies() {
    log "Установка необходимых зависимостей..."
    export DEBIAN_FRONTEND=noninteractive
    # Добавил ca-certificates для корректной работы curl/wget с HTTPS
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
        moreutils \
        dnsutils \
        qrencode \
        uuid-runtime \
        ca-certificates

    success "Зависимости установлены"
}

# Установка Node.js (для API сервера)
install_nodejs() {
    if ! check_command node; then
        log "Установка Node.js 18.x..."
        curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
        apt-get install -y nodejs
        success "Node.js установлен: $(node -v)"
    else
        log "Node.js уже установлен: $(node -v)"
    fi

    if ! check_command pm2; then
        log "Установка PM2..."
        npm install -g pm2
        pm2 startup systemd -u root --hp /root
        success "PM2 установлен и настроен для автозапуска"
    else
        log "PM2 уже установлен"
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

    if sysctl -p; then
      success "Настройки sysctl применены"
    else
      warning "Не удалось применить настройки sysctl. Возможно, потребуется перезагрузка."
    fi

    if lsmod | grep -q "bbr"; then
        success "TCP BBR включен"
    else
        warning "Не удалось включить TCP BBR. Производительность может быть ниже оптимальной. Попробуйте перезагрузить сервер."
    fi
}

# Настройка файрвола
setup_firewall() {
    log "Настройка файрвола (UFW)..."
    ufw default deny incoming
    ufw default allow outgoing

    local ssh_port="${SERVER_SSH_PORT:-22}" # Используем переданный порт SSH
    log "Разрешение SSH на порту ${ssh_port}"
    ufw allow ${ssh_port}/tcp comment 'SSH Access'

    log "Разрешение HTTP (80) и HTTPS (443)"
    ufw allow 80/tcp comment 'HTTP for Certbot & Fallback'
    ufw allow 443/tcp comment 'HTTPS for Xray & Certbot'

    if ! ufw status | grep -q "Status: active"; then
        log "Включение UFW..."
        echo "y" | ufw enable
    else
        log "UFW уже активен."
    fi

    ufw status verbose
    success "Файрвол настроен"
}

# Получение SSL сертификата
setup_ssl() {
    local domain="$1"
    local email="$2"

    log "Настройка SSL..."

    if [[ "${domain}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        warning "Обнаружен IP-адрес (${domain}). Пропускаем получение SSL сертификата от Let's Encrypt."
        generate_self_signed_cert "${domain}"
        return 0
    elif [ -z "${domain}" ]; then
         warning "Доменное имя не указано. Пропускаем получение SSL сертификата от Let's Encrypt."
         generate_self_signed_cert "localhost"
         return 0
    fi

    log "Попытка получения SSL-сертификата для домена: ${domain}"

    if systemctl is-active --quiet nginx; then
        log "Временно останавливаем Nginx для Certbot..."
        systemctl stop nginx
    fi

    # Используем --nginx плагин, если Nginx установлен, или --standalone, если нет
    if check_command nginx; then
        # Подготовка Nginx для Certbot
        mkdir -p /var/www/certbot
        cat > /etc/nginx/sites-available/certbot << EOL
server {
    listen 80;
    server_name ${domain};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 404; # Или перенаправление на HTTPS, если нужно
    }
}
EOL
        ln -sf /etc/nginx/sites-available/certbot /etc/nginx/sites-enabled/
        systemctl restart nginx || error "Не удалось перезапустить Nginx для Certbot"

        certbot certonly --webroot -w /var/www/certbot -d "${domain}" --non-interactive --agree-tos --email "${email}"
        rm -f /etc/nginx/sites-enabled/certbot # Удаляем временный конфиг Nginx
        systemctl restart nginx || log "Nginx не запущен, пропускаем перезапуск"
    else
        certbot certonly --standalone -d "${domain}" --non-interactive --agree-tos --email "${email}" --preferred-challenges http --http-01-port 80
    fi


    if [ -d "/etc/letsencrypt/live/${domain}" ]; then
        success "SSL-сертификат успешно получен для ${domain}"
        if ! crontab -l | grep -q "certbot renew"; then
            (crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet --deploy-hook 'systemctl restart xray'") | crontab -
            log "Настроено автоматическое обновление SSL-сертификатов (ежедневно в 3:00) с перезапуском Xray"
        fi

        if ! systemctl is-active --quiet nginx && check_command nginx; then
           log "Запускаем Nginx..."
           systemctl start nginx
        fi
        return 0
    else
        error "Не удалось получить SSL-сертификат для ${domain}. Проверьте DNS записи и доступность порта 80."
        generate_self_signed_cert "${domain}"
        return 1
    fi
}

# Генерация самоподписанных сертификатов
generate_self_signed_cert() {
    local cn="$1"
    log "Генерация самоподписанного SSL сертификата (CN: ${cn})..."

    local cert_dir="/usr/local/etc/xray/ssl"
    local key_path="${cert_dir}/private.key"
    local cert_path="${cert_dir}/certificate.crt"

    mkdir -p "${cert_dir}"

    openssl req -x509 -newkey rsa:4096 -keyout "${key_path}" \
        -out "${cert_path}" -days 3650 -nodes \
        -subj "/C=XX/ST=State/L=City/O=Organization/OU=IT Department/CN=${cn}"

    chmod 600 "${key_path}"
    chmod 644 "${cert_path}"

    success "Самоподписанный сертификат сгенерирован: ${cert_path}"
    warning "Используется самоподписанный сертификат. Клиенты могут выдавать предупреждения безопасности."
}

# Установка Xray
install_xray() {
    log "Установка Xray..."
    log "Запуск скрипта установки/обновления Xray..."
    # Установка последней стабильной версии
    bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install

    if command -v xray &> /dev/null; then
        success "Xray установлен: $(xray version | head -n 1)"
    else
        error "Не удалось установить Xray."
        exit 1
    fi

    mkdir -p /usr/local/etc/xray
    mkdir -p /var/log/xray
    chown nobody:nogroup /var/log/xray
    chmod 700 /var/log/xray

    if [ ! -f "/usr/local/etc/xray/config.json" ]; then
        echo "{}" > /usr/local/etc/xray/config.json
        chown nobody:nogroup /usr/local/etc/xray/config.json
        chmod 600 /usr/local/etc/xray/config.json
    fi
}

# Создание базовой конфигурации Xray
configure_xray() {
    local domain="$1"
    log "Настройка конфигурации Xray для ${domain:-IP Address}..."

    local user_uuid=$(uuidgen)
    local user_email="user_${user_uuid:0:8}"

    log "Первый пользователь UUID: ${user_uuid}"
    log "Первый пользователь Email: ${user_email}"

    local cert_path=""
    local key_path=""

    if [ -d "/etc/letsencrypt/live/${domain}" ]; then
        log "Используем сертификаты Let's Encrypt для ${domain}"
        cert_path="/etc/letsencrypt/live/${domain}/fullchain.pem"
        key_path="/etc/letsencrypt/live/${domain}/privkey.pem"
    elif [ -f "/usr/local/etc/xray/ssl/certificate.crt" ]; then
        log "Используем самоподписанные сертификаты"
        cert_path="/usr/local/etc/xray/ssl/certificate.crt"
        key_path="/usr/local/etc/xray/ssl/private.key"
    else
        error "Не найдены SSL сертификаты. Не удалось сгенерировать конфигурацию Xray."
        exit 1
    fi

    # Используем jq для безопасной вставки переменных в JSON
    jq -n \
      --argjson port 443 \
      --arg user_uuid "$user_uuid" \
      --arg user_email "$user_email" \
      --arg domain "$domain" \
      --arg cert_path "$cert_path" \
      --arg key_path "$key_path" \
      '{
        log: {
          access: "/var/log/xray/access.log",
          error: "/var/log/xray/error.log",
          loglevel: "warning"
        },
        api: {
          tag: "api",
          services: [ "HandlerService", "LoggerService", "StatsService" ]
        },
        policy: {
          levels: {
            "0": { statsUserUplink: true, statsUserDownlink: true }
          },
          system: { statsInboundUplink: true, statsInboundDownlink: true, statsOutboundUplink: true, statsOutboundDownlink: true }
        },
        inbounds: [
          {
            listen: "0.0.0.0",
            port: $port,
            protocol: "vless",
            settings: {
              clients: [
                { id: $user_uuid, flow: "xtls-rprx-vision", level: 0, email: $user_email }
              ],
              decryption: "none",
              fallbacks: [ { dest: 80, xver: 1 } ]
            },
            streamSettings: {
              network: "tcp",
              security: "xtls",
              xtlsSettings: {
                serverName: $domain,
                alpn: ["http/1.1"],
                certificates: [ { certificateFile: $cert_path, keyFile: $key_path } ],
                minVersion: "1.2"
              }
            },
            sniffing: { enabled: true, destOverride: ["http", "tls"] },
            tag: "vless-in"
          },
          {
            listen: "127.0.0.1",
            port: 10085,
            protocol: "dokodemo-door",
            settings: { address: "127.0.0.1" },
            tag: "api"
          }
        ],
        outbounds: [
          { protocol: "freedom", settings: {}, tag: "direct" },
          { protocol: "blackhole", settings: {}, tag: "block" }
        ],
        routing: {
          domainStrategy: "AsIs",
          rules: [
            { type: "field", inboundTag: ["api"], outboundTag: "api" },
            { type: "field", ip: ["geoip:private"], outboundTag: "block" },
            { type: "field", protocol: ["bittorrent"], outboundTag: "block" }
          ]
        },
        stats: {}
      }' > /usr/local/etc/xray/config.json


    chown nobody:nogroup /usr/local/etc/xray/config.json
    chmod 600 /usr/local/etc/xray/config.json
    log "Конфигурация Xray создана: /usr/local/etc/xray/config.json"

    log "Проверка конфигурации Xray..."
    if xray run -test -config /usr/local/etc/xray/config.json; then
       success "Конфигурация Xray корректна."
    else
       error "Обнаружены ошибки в конфигурации Xray. Пожалуйста, проверьте /usr/local/etc/xray/config.json"
       if [ -f "/var/log/xray/error.log" ]; then
         tail -n 10 /var/log/xray/error.log
       fi
       exit 1
    fi

    log "Перезапуск и включение службы Xray..."
    systemctl restart xray
    systemctl enable xray
    sleep 3

    if systemctl is-active --quiet xray; then
        success "Xray успешно настроен и запущен"
    else
        error "Не удалось запустить Xray. Проверьте журналы:"
        echo "  systemctl status xray"
        echo "  journalctl -u xray --no-pager | tail -n 20"
        if [ -f "/var/log/xray/error.log" ]; then
          tail -n 10 /var/log/xray/error.log
        fi
        exit 1
    fi

    local client_dir="/root/xray-clients"
    mkdir -p "${client_dir}"
    log "Директория для клиентских файлов: ${client_dir}"

    local vless_link="vless://${user_uuid}@${domain}:443?security=xtls&flow=xtls-rprx-vision&type=tcp&sni=${domain}#${user_email}"
    echo "${vless_link}" > "${client_dir}/${user_email}.txt"
    log "Ссылка VLESS сохранена: ${client_dir}/${user_email}.txt"

    echo "${vless_link}" | qrencode -t PNG -o "${client_dir}/${user_email}.png"
    log "QR-код для VLESS сохранен (PNG): ${client_dir}/${user_email}.png"

    # Генерация JSON с помощью jq
    jq -n \
      --arg ps "$user_email" \
      --arg add "$domain" \
      --arg port "443" \
      --arg id "$user_uuid" \
      --arg sni "$domain" \
      '{ v: "2", ps: $ps, add: $add, port: $port, id: $id, aid: "0", scy: "auto", net: "tcp", type: "none", host: "", path: "", tls: "xtls", sni: $sni, alpn: "", flow: "xtls-rprx-vision" }' > "${client_dir}/${user_email}.json"

    log "Конфигурация клиента (JSON) сохранена: ${client_dir}/${user_email}.json"

    echo ""
    echo -e "${GREEN}======== ИНФОРМАЦИЯ О ПЕРВОМ КЛИЕНТЕ ========${NC}"
    echo -e "Email: ${YELLOW}${user_email}${NC}"
    echo -e "UUID: ${YELLOW}${user_uuid}${NC}"
    echo -e "Адрес: ${YELLOW}${domain}${NC}"
    echo -e "Порт: ${YELLOW}443${NC}"
    echo -e "Flow: ${YELLOW}xtls-rprx-vision${NC}"
    echo ""
    echo -e "Ссылка VLESS: ${GREEN}${vless_link}${NC}"
    echo ""
    echo -e "QR-код (PNG файл): ${BLUE}${client_dir}/${user_email}.png${NC}"
    echo -e "Файлы конфигурации находятся в директории: ${BLUE}${client_dir}${NC}"
    echo -e "${GREEN}=============================================${NC}"
    echo ""
}

# Установка и настройка API для управления пользователями Xray
setup_api() {
    log "Настройка API для управления пользователями Xray..."

    local api_dir="/usr/local/share/vpn-api"
    local api_port=3000
    local api_token=$(uuidgen)

    log "API будет слушать на 127.0.0.1:${api_port}"
    log "Токен для доступа к API: ${api_token}"

    mkdir -p "${api_dir}"
    echo "API_TOKEN=${api_token}" > "${api_dir}/.env"
    chmod 600 "${api_dir}/.env"

    # Создаем основной файл API сервера (server.js)
    cat > "${api_dir}/server.js" << 'EOLJS'
const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');
const jq = require('node-jq'); // Используем node-jq для работы с JSON

const app = express();
const port = process.env.API_PORT || 3000;
const configPath = '/usr/local/etc/xray/config.json';
const clientDir = '/root/xray-clients';
const envPath = path.join(__dirname, '.env');

require('dotenv').config({ path: envPath });
const API_TOKEN = process.env.API_TOKEN;

if (!API_TOKEN) {
    console.error("Ошибка: API_TOKEN не найден в .env файле!");
    process.exit(1);
}

app.use(express.json());

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.status(401).json({ success: false, message: 'Токен доступа не предоставлен' });
    if (token !== API_TOKEN) return res.status(403).json({ success: false, message: 'Неверный токен доступа' });
    next();
};

function generateUUID() { return crypto.randomUUID(); }

async function restartXray() {
    return new Promise((resolve) => {
        console.log('Перезапуск Xray...');
        const proc = spawn('systemctl', ['restart', 'xray']);
        proc.on('close', (code) => {
            if (code === 0) {
                console.log('Xray успешно перезапущен.');
                resolve(true);
            } else {
                console.error(`Ошибка при перезапуске Xray (код: ${code})`);
                resolve(false);
            }
        });
        proc.on('error', (err) => {
             console.error('Ошибка при выполнении systemctl restart xray:', err.message);
             resolve(false);
        });
    });
}

async function testXrayConfig() {
     return new Promise((resolve) => {
        console.log('Проверка конфигурации Xray...');
        const proc = spawn('xray', ['run', '-test', '-config', configPath]);
        let stderr = '';
        proc.stderr.on('data', (data) => { stderr += data; });
        proc.on('close', (code) => {
            if (code === 0) {
                console.log('Конфигурация Xray корректна.');
                resolve(true);
            } else {
                console.error('Ошибка в конфигурации Xray:', stderr || `Процесс завершился с кодом ${code}`);
                resolve(false);
            }
        });
         proc.on('error', (err) => {
             console.error('Ошибка при выполнении xray run -test:', err.message);
             resolve(false);
        });
    });
}

async function readXrayConfig() {
    try {
        const data = await fs.promises.readFile(configPath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Ошибка чтения конфигурации Xray:', error.message);
        return null;
    }
}

async function writeXrayConfig(config) {
    try {
        await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
        return true;
    } catch (error) {
        console.error('Ошибка записи конфигурации Xray:', error.message);
        return false;
    }
}

async function generateClientFiles(client, domain) {
    const { id: uuid, email } = client;
    if (!uuid || !email || !domain) { console.error('Ошибка: Недостаточно данных для генерации клиентских файлов.'); return; }
    try {
        await fs.promises.mkdir(clientDir, { recursive: true });
        const vlessLink = `vless://${uuid}@${domain}:443?security=xtls&flow=xtls-rprx-vision&type=tcp&sni=${domain}#${email}`;
        await fs.promises.writeFile(path.join(clientDir, `${email}.txt`), vlessLink);

        // QR Code generation using spawn
        const qrProcess = spawn('qrencode', ['-t', 'PNG', '-o', path.join(clientDir, `${email}.png`)]);
        qrProcess.stdin.write(vlessLink);
        qrProcess.stdin.end();
        await new Promise((resolve, reject) => { // Wait for QR code generation
          qrProcess.on('close', (code) => code === 0 ? resolve() : reject(`qrencode exited with code ${code}`));
          qrProcess.on('error', reject);
        });


        // Client JSON Config using node-jq
        const clientJsonConfig = { v: "2", ps: email, add: domain, port: "443", id: uuid, aid: "0", scy: "auto", net: "tcp", type: "none", host: "", path: "", tls: "xtls", sni: domain, alpn: "", flow: "xtls-rprx-vision" };
        await fs.promises.writeFile(path.join(clientDir, `${email}.json`), JSON.stringify(clientJsonConfig, null, 2));

        console.log(`Файлы для клиента ${email} сгенерированы в ${clientDir}`);
    } catch (error) { console.error(`Ошибка при генерации файлов для клиента ${email}:`, error.message); }
}

async function deleteClientFiles(email) {
    if (!email) return;
    const extensions = ['.txt', '.png', '.json'];
    for (const ext of extensions) {
        const filePath = path.join(clientDir, `${email}${ext}`);
        try {
            await fs.promises.unlink(filePath);
            console.log(`Удален файл: ${filePath}`);
        } catch (error) {
            if (error.code !== 'ENOENT') { // Ignore "file not found" errors
               console.error(`Ошибка удаления файла ${filePath}:`, error.message);
            }
        }
    }
}

// --- API Routes ---

app.get('/api/clients', authenticateToken, async (req, res) => {
    const config = await readXrayConfig();
    if (!config) return res.status(500).json({ success: false, message: 'Не удалось прочитать конфигурацию Xray' });
    const vlessInbound = config.inbounds?.find(ib => ib.protocol === 'vless' && ib.settings?.clients);
    const clients = vlessInbound ? vlessInbound.settings.clients.map(c => ({ id: c.id, email: c.email, flow: c.flow })) : [];
    res.json({ success: true, clients });
});

app.post('/api/clients', authenticateToken, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Необходимо указать email клиента' });

    const config = await readXrayConfig();
    if (!config) return res.status(500).json({ success: false, message: 'Не удалось прочитать конфигурацию Xray' });

    const vlessInboundIndex = config.inbounds?.findIndex(ib => ib.protocol === 'vless' && ib.settings?.clients);
    if (vlessInboundIndex === -1 || vlessInboundIndex === undefined) return res.status(500).json({ success: false, message: 'Не найден подходящий inbound VLESS в конфигурации' });

    const clientExists = config.inbounds[vlessInboundIndex].settings.clients.some(c => c.email === email);
    if (clientExists) return res.status(409).json({ success: false, message: `Клиент с email ${email} уже существует` });

    const newClient = { id: generateUUID(), flow: "xtls-rprx-vision", level: 0, email: email };
    const backupConfig = JSON.stringify(config, null, 2); // Backup before modification

    // Use jq to add the new client safely
    try {
        const filter = `.inbounds[${vlessInboundIndex}].settings.clients += [$newClient]`;
        const updatedConfigJson = await jq.run(filter, configPath, {
            input: 'file',
            output: 'json',
            slurp: true, // Read the whole file
            arg: 'newClient', // Define jq variable name
            argjson: JSON.stringify(newClient) // Pass the new client object as JSON
        });

        // Overwrite the config file with the updated JSON
        await fs.promises.writeFile(configPath, JSON.stringify(updatedConfigJson, null, 2));

    } catch (jqError) {
        console.error("Ошибка при обновлении конфигурации с помощью jq:", jqError);
        // Attempt to restore backup on jq error
        await writeXrayConfig(JSON.parse(backupConfig));
        return res.status(500).json({ success: false, message: 'Ошибка при модификации конфигурации Xray (jq)' });
    }


    if (!await testXrayConfig()) {
        console.error("Откат конфигурации из-за ошибки...");
        await writeXrayConfig(JSON.parse(backupConfig));
        return res.status(500).json({ success: false, message: 'Ошибка в новой конфигурации Xray, изменения отменены' });
    }

    if (!await restartXray()) {
        return res.status(500).json({ success: false, message: 'Не удалось перезапустить Xray после добавления клиента' });
    }

    const finalConfig = await readXrayConfig(); // Read the final successful config
    const domain = finalConfig?.inbounds?.[vlessInboundIndex]?.streamSettings?.xtlsSettings?.serverName || 'YOUR_DOMAIN_OR_IP';
    await generateClientFiles(newClient, domain);

    res.status(201).json({ success: true, message: `Клиент ${email} успешно добавлен`, client: newClient });
});

app.delete('/api/clients/:email', authenticateToken, async (req, res) => {
    const emailToDelete = req.params.email;

    const config = await readXrayConfig();
    if (!config) return res.status(500).json({ success: false, message: 'Не удалось прочитать конфигурацию Xray' });

    const vlessInboundIndex = config.inbounds?.findIndex(ib => ib.protocol === 'vless' && ib.settings?.clients);
     if (vlessInboundIndex === -1 || vlessInboundIndex === undefined) return res.status(500).json({ success: false, message: 'Не найден подходящий inbound VLESS в конфигурации' });

    const clientIndex = config.inbounds[vlessInboundIndex].settings.clients.findIndex(c => c.email === emailToDelete);
    if (clientIndex === -1) return res.status(404).json({ success: false, message: `Клиент с email ${emailToDelete} не найден` });

    const backupConfig = JSON.stringify(config, null, 2);

    // Use jq to delete the client
    try {
        const filter = `del(.inbounds[${vlessInboundIndex}].settings.clients[${clientIndex}])`;
         const updatedConfigJson = await jq.run(filter, configPath, {
            input: 'file',
            output: 'json',
            slurp: true
        });
        await fs.promises.writeFile(configPath, JSON.stringify(updatedConfigJson, null, 2));
    } catch (jqError) {
         console.error("Ошибка при удалении клиента с помощью jq:", jqError);
        await writeXrayConfig(JSON.parse(backupConfig)); // Restore
        return res.status(500).json({ success: false, message: 'Ошибка при модификации конфигурации Xray (jq)' });
    }


    if (!await testXrayConfig()) {
        console.error("Откат конфигурации из-за ошибки...");
        await writeXrayConfig(JSON.parse(backupConfig));
        return res.status(500).json({ success: false, message: 'Ошибка в новой конфигурации Xray, изменения отменены' });
    }

    if (!await restartXray()) {
        return res.status(500).json({ success: false, message: 'Не удалось перезапустить Xray после удаления клиента' });
    }

    await deleteClientFiles(emailToDelete);

    res.json({ success: true, message: `Клиент ${emailToDelete} успешно удален` });
});

app.get('/api/status', authenticateToken, async (req, res) => {
    try {
        // Use spawn for better error handling and non-blocking nature
        const getStatus = (command) => new Promise((resolve) => {
            const proc = spawn(command, { shell: true });
            let output = '';
            proc.stdout.on('data', (data) => output += data);
            proc.on('close', () => resolve(output.trim() || 'error'));
            proc.on('error', () => resolve('error'));
        });

        const [xrayStatus, apiStatus, uptime] = await Promise.all([
            getStatus('systemctl is-active xray'),
            getStatus('pm2 describe vpn-api | grep -oP "status\\\\s*:\\\\s*\\\\K\\\\w+" || echo stopped'), // Get PM2 status
            getStatus('uptime -p')
        ]);

         const xrayVersion = await getStatus('xray version | head -n 1');

        res.json({ success: true, status: { xray: xrayStatus, xrayVersion, api: apiStatus, uptime } });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Ошибка получения статуса: ' + error.message });
    }
});


app.listen(port, '127.0.0.1', () => {
  console.log(`VPN API сервер запущен на http://127.0.0.1:${port}`);
  console.log(`Используйте токен: ${API_TOKEN} для авторизации (Bearer Token)`);
});
EOLJS

    # Создаем package.json для API
    cat > "${api_dir}/package.json" << EOL
{
  "name": "vpn-api",
  "version": "1.1.0",
  "description": "API для управления пользователями Xray",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "dotenv": "^16.3.1",
    "node-jq": "^4.0.0"
  }
}
EOL

    log "Установка зависимостей для API..."
    cd "${api_dir}"
    npm install --production
    cd -

    log "Настройка службы API с помощью PM2..."
    # Удаляем старый процесс, если он существует
    pm2 delete vpn-api || true
    # Запускаем новый процесс
    pm2 start "${api_dir}/server.js" --name vpn-api --max-memory-restart 200M --env production
    # Сохраняем конфигурацию PM2 для автозапуска
    pm2 save

    # Небольшая задержка для запуска PM2 процесса
    sleep 5

    if pm2 list | grep -qw "vpn-api.*online"; then
        success "API сервер успешно настроен и запущен через PM2"
    else
        error "Не удалось запустить API сервер через PM2. Проверьте журналы PM2: pm2 logs vpn-api"
        pm2 logs vpn-api --lines 20 --no-stream
    fi

    log "Не забудьте сохранить API токен: ${api_token}"
}


# Главная функция установки
main() {
    # Используем переменные, переданные как плейсхолдеры
    local domain="${SERVER_HOST}"
    local email="${ADMIN_EMAIL}"

    log "==========================================="
    log " Начало установки Xray VPN на ${domain:-IP Address} "
    log "==========================================="

    check_root
    update_system
    install_dependencies
    install_nodejs
    enable_bbr
    setup_firewall

    # Передаем переменные в bash функции с кавычками для безопасности
    setup_ssl "${domain}" "${email}"
    install_xray
    configure_xray "${domain}"
    setup_api

    log "==========================================="
    success "Установка и настройка Xray VPN завершена!"
    log "==========================================="
    echo ""
    echo "Пожалуйста, проверьте вывод выше на наличие данных первого пользователя."
    echo "API токен для управления пользователями сохранен в /usr/local/share/vpn-api/.env"
    echo "Не забудьте сохранить этот токен в безопасном месте!"
    echo ""
    echo "Статус служб:"
    echo "  Xray: $(systemctl is-active xray)"
    # Используем pm2 describe для получения статуса, он надежнее
    echo "  API (PM2): $(pm2 describe vpn-api 2>/dev/null | grep 'status' | awk '{print $NF}' || echo stopped)"
    echo ""
        # Выводим токен для захвата родительским процессом
    echo "API_TOKEN_OUTPUT:${api_token}"
}

# Запуск главной функции установки
main
# Последняя строка выводит API токен для захвата вызывающим скриптом

exit 0
