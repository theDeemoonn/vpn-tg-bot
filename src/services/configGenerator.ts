import { v4 as uuidv4 } from 'uuid';

export interface XrayConfigOptions {
  domain: string; // Домен или IP-адрес сервера
  adminEmail: string; // Email для SSL (если используется Let's Encrypt)
  initialUserEmail: string; // Email первого пользователя
}

/**
 * Генерирует базовую конфигурацию Xray (VLESS + TCP + XTLS-Reality)
 */
export function generateXrayConfig(options: XrayConfigOptions): { config: object, initialUserId: string } {
  const initialUserId = uuidv4();
  const initialUserEmail = options.initialUserEmail || `user-${initialUserId.substring(0, 8)}`;

  // TODO: Реализовать генерацию ключей Reality (пока плейсхолдеры)
  const realityKeys = generateRealityKeys(); // Нужна функция генерации

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

  return { config, initialUserId };
}

/**
 * Генерирует пару ключей и shortId для Xray Reality
 * TODO: Реализовать фактическую генерацию ключей
 */
function generateRealityKeys(): { privateKey: string; publicKey: string; shortId: string } {
    // Пока заглушка, нужно использовать 'xray x25519' или аналог
    console.warn("Генерация ключей Reality еще не реализована. Используются плейсхолдеры!");
    return {
        privateKey: "PLACEHOLDER_PRIVATE_KEY_REPLACE_ME",
        publicKey: "PLACEHOLDER_PUBLIC_KEY_REPLACE_ME",
        shortId: Math.random().toString(16).substring(2, 18) // Генерация случайного shortId
    };
} 