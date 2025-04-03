import { VpnServer } from '@prisma/client';

/**
 * Параметры для генерации VLESS Reality URL.
 */
interface VlessUrlParams {
  uuid: string;                  // UUID пользователя
  address: string;               // IP или домен сервера
  port: number;                  // Порт сервера (обычно 443)
  publicKey: string;             // Публичный ключ Reality
  shortId: string;               // Короткий ID Reality
  serverName: string;            // Имя сервера (SNI) для Reality (например, www.google.com)
  fingerprint: string;           // Отпечаток TLS (например, chrome, firefox, safari, ios)
  serverDescription?: string;    // Описание сервера для клиента (название)
}

/**
 * Генерирует VLESS URL для конфигурации с Reality.
 * 
 * @param params - Параметры конфигурации.
 * @returns Сформированный VLESS URL.
 * @throws Ошибка, если не хватает обязательных параметров.
 */
export function generateVlessUrl(params: VlessUrlParams): string {
  const {
    uuid,
    address,
    port,
    publicKey,
    shortId,
    serverName,
    fingerprint,
    serverDescription = 'VPN', // Название по умолчанию
  } = params;

  // Проверка обязательных параметров
  if (!uuid || !address || !port || !publicKey || !shortId || !serverName || !fingerprint) {
    throw new Error('Недостаточно параметров для генерации VLESS URL.');
  }

  // Собираем параметры URL
  const queryParams = new URLSearchParams({
    type: 'tcp',
    security: 'reality',
    sni: serverName,
    fp: fingerprint,
    pbk: publicKey,
    sid: shortId,
    // flow: 'xtls-rprx-vision' // Параметр flow не нужен в URL, клиент определит сам
    // encryption: 'none' // 'none' является значением по умолчанию для VLESS
  });

  // Формируем базовую часть URL
  const baseUrl = `vless://${uuid}@${address}:${port}`;

  // Собираем полный URL
  const fullUrl = `${baseUrl}?${queryParams.toString()}#${encodeURIComponent(serverDescription)}`;

  return fullUrl;
}

/**
 * Пример использования для получения конфигурации пользователя.
 * Эта функция должна быть размещена в соответствующем сервисе или контроллере.
 * 
 * import { prisma } from '../services/database'; // Путь к вашему Prisma клиенту
 * import { generateVlessUrl } from './generateVlessUrl';
 * 
 * async function getUserVlessConfig(userId: number): Promise<string | null> {
 *   const subscription = await prisma.subscription.findFirst({
 *     where: { userId: userId, isActive: true }, // Находим активную подписку пользователя
 *     include: { server: true }, // Включаем данные связанного сервера
 *   });
 * 
 *   if (!subscription || !subscription.server) {
 *     console.error(`Активная подписка или сервер не найдены для пользователя ${userId}`);
 *     return null; // Или выбросить ошибку
 *   }
 * 
 *   const server = subscription.server;
 * 
 *   // Проверяем, есть ли все необходимые данные на сервере
 *   if (!server.initialUserId || !server.realityPublicKey || !server.realityShortId) {
 *     console.error(`Неполные данные Reality на сервере ${server.id}`);
 *     return null; // Сервер еще не полностью настроен
 *   }
 * 
 *   try {
 *     const vlessUrl = generateVlessUrl({
 *       uuid: server.initialUserId, // Используем initialUserId сервера
 *       address: server.host,
 *       port: server.port, // Порт Xray (443)
 *       publicKey: server.realityPublicKey,
 *       shortId: server.realityShortId,
 *       serverName: 'www.google.com', // SNI, можно сделать настраиваемым
 *       fingerprint: 'chrome', // Отпечаток, можно сделать выбираемым
 *       serverDescription: server.name, // Имя сервера для отображения
 *     });
 *     return vlessUrl;
 *   } catch (error: any) {
 *     console.error(`Ошибка генерации VLESS URL для пользователя ${userId}: ${error.message}`);
 *     return null;
 *   }
 * }
 */ 