import { v4 as uuidv4 } from 'uuid';
import { execSync } from 'child_process'; // Импортируем execSync
import logger from '../utils/logger'; // Для логов

export interface XrayConfigOptions {
  domain: string; // Домен или IP-адрес сервера
  adminEmail: string; // Email для SSL (если используется Let's Encrypt)
  initialUserEmail: string; // Email первого пользователя
}

/**
 * Генерирует базовую конфигурацию Xray (VLESS + TCP + XTLS-Reality)
 */
export function generateXrayConfig(options: XrayConfigOptions): { config: object, initialUserId: string, publicKey: string } {
  const initialUserId = uuidv4();
  const initialUserEmail = options.initialUserEmail || `user-${initialUserId.substring(0, 8)}`;

  // Генерируем реальные ключи Reality
  const realityKeys = generateRealityKeys(); 
  if (!realityKeys) {
      // Если генерация не удалась, можно вернуть ошибку или стандартный конфиг без Reality
      throw new Error("Не удалось сгенерировать ключи Reality для Xray.");
  }

  const config = {
    log: {
      loglevel: "warning",
      access: "/var/log/xray/access.log",
      error: "/var/log/xray/error.log"
    },
    inbounds: [
      {
        listen: "0.0.0.0",
        port: 443,
        protocol: "vless",
        settings: {
          clients: [
            {
              id: initialUserId, // UUID первого пользователя
              email: initialUserEmail,
              flow: "xtls-rprx-vision" // Используем Vision
            }
          ],
          decryption: "none"
        },
        streamSettings: {
          network: "tcp",
          security: "reality", // Используем Reality
          realitySettings: {
            show: false,
            dest: "www.google.com:443", // Пример SNI для обхода блокировок
            xver: 0,
            serverNames: [options.domain], // Домен сервера
            privateKey: realityKeys.privateKey, // Приватный ключ Reality
            // minClientVer: "1.8.0", // Можно указать минимальную версию клиента
            // maxClientVer: "1.8.1", // Можно указать максимальную версию клиента
            // maxTimeDiff: 60000,
            shortIds: [realityKeys.shortId] // Короткий ID Reality
          }
        },
        sniffing: {
          enabled: true,
          destOverride: ["http", "tls"]
        }
      }
    ],
    outbounds: [
      {
        protocol: "freedom",
        tag: "direct"
      },
      {
        protocol: "blackhole",
        tag: "block"
      }
    ]
    // routing, policy и т.д. можно добавить по необходимости
  };

  // Возвращаем и публичный ключ, он может понадобиться для генерации клиентских ссылок
  return { config, initialUserId, publicKey: realityKeys.publicKey };
}

/**
 * Генерирует пару ключей и shortId для Xray Reality с помощью команды xray x25519
 */
function generateRealityKeys(): { privateKey: string; publicKey: string; shortId: string } | null {
    try {
        logger.info('Генерация ключей Xray Reality...');
        const output = execSync('/usr/local/bin/xray x25519', { encoding: 'utf8' });
        
        // Парсим вывод команды
        const privateKeyMatch = output.match(/Private key:\s*(\S+)/);
        const publicKeyMatch = output.match(/Public key:\s*(\S+)/);
        
        if (!privateKeyMatch || !publicKeyMatch) {
            logger.error('Не удалось распарсить вывод команды xray x25519:', output);
            return null;
        }
        
        const privateKey = privateKeyMatch[1];
        const publicKey = publicKeyMatch[1];
        // Генерируем shortId (случайная hex-строка длиной 8-16 символов)
        const shortId = Array.from({ length: Math.floor(Math.random() * 9) + 8 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
        
        logger.info('Ключи Reality успешно сгенерированы.');
        return {
            privateKey,
            publicKey,
            shortId
        };
    } catch (error: any) {
        logger.error('Ошибка при выполнении команды xray x25519:', error.message);
        return null;
    }
} 