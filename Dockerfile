FROM node:18-alpine as builder

WORKDIR /app

# Устанавливаем необходимые зависимости для Prisma и компиляции
RUN apk add --no-cache openssl libc6-compat

# Устанавливаем больше памяти для Node.js при сборке проекта
ENV NODE_OPTIONS="--max-old-space-size=4096"

# Указываем переменную окружения для Prisma, чтобы использовать OpenSSL 3.x
ENV PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1
ENV PRISMA_CLI_QUERY_ENGINE_TYPE=binary

# Копируем package.json и package-lock.json
COPY package*.json ./

# Устанавливаем зависимости
RUN npm install

# Копируем исходный код
COPY . .

# Генерируем Prisma клиент
RUN npx prisma generate

# Компилируем TypeScript, игнорируя ошибки
RUN npm run build:ignore || echo "Ignoring TypeScript errors"

# Второй этап сборки для минимизации размера образа
FROM node:18-alpine

WORKDIR /app

# Устанавливаем системные зависимости: OpenSSL, libc, SSH И XRAY (для генерации ключей)
RUN apk add --no-cache openssl libc6-compat sshpass openssh-client unzip wget && \
    XRAY_VERSION=$(wget -qO- "https://api.github.com/repos/XTLS/Xray-core/releases/latest" | grep '"tag_name":' | sed -E 's/.*"v([^"]+)".*/\1/') && \
    echo "Downloading Xray version: $XRAY_VERSION" && \
    wget -O /tmp/xray.zip "https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/Xray-linux-64.zip" && \
    unzip /tmp/xray.zip -d /usr/local/bin xray geoip.dat geosite.dat && \
    rm /tmp/xray.zip && \
    chmod +x /usr/local/bin/xray /usr/bin/sshpass /usr/bin/ssh /usr/bin/scp && \
    # Проверяем наличие
    which xray && which sshpass && which ssh && which scp
    

# Указываем переменную окружения для Prisma, чтобы использовать OpenSSL 3.x
ENV PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1
ENV PRISMA_CLI_QUERY_ENGINE_TYPE=binary

# Копируем только необходимые файлы
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules ./node_modules

# Переменные окружения
ENV NODE_ENV=production

# Создаем директорию для логов
RUN mkdir -p logs

# Порт, на котором работает приложение
EXPOSE 3000

# Запускаем приложение
CMD ["node", "dist/index.js"] 