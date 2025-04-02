import { prisma } from './database';
import logger from '../utils/logger';
import axios, { AxiosError } from 'axios';

interface XrayUser {
  // id: string; // Возможно, у пользователя Xray есть свой ID, но для синхронизации используем telegramId
  identifier: string; // Ожидаем, что API будет использовать это поле для telegramId (как строки)
}

/**
 * Получает список пользователей с удаленного API VPN-сервера.
 */
async function getXrayUsersFromServer(host: string, apiToken: string): Promise<XrayUser[]> {
  // ВАЖНО: Используйте HTTPS, если настроили его на удаленном API
  const apiUrl = `http://${host}:3000/api/clients`;
  try {
    // Ожидаем ответ вида { success: boolean, clients: [{ identifier: "12345" }, ...] }
    const response = await axios.get<{ success: boolean; clients: XrayUser[] }>(apiUrl, {
      headers: { 'Authorization': `Bearer ${apiToken}`, 'Accept': 'application/json' },
      timeout: 15000,
    });
    // Проверяем наличие поля identifier у каждого клиента
    if (response.data.success && Array.isArray(response.data.clients) && response.data.clients.every(c => typeof c.identifier === 'string')) {
      return response.data.clients;
    } else {
      logger.warn(`[AccessControl] Не удалось получить корректный список пользователей (с полем 'identifier') с ${host}. Ответ: ${JSON.stringify(response.data)}`);
      return [];
    }
  } catch (error: any) {
     if (axios.isAxiosError(error)) {
          const axiosError = error as AxiosError;
           if (axiosError.code === 'ECONNREFUSED' || axiosError.code === 'ETIMEDOUT') {
             logger.error(`[AccessControl] Не удалось подключиться или таймаут для ${host} (${apiUrl}): ${axiosError.code}`);
          } else {
             logger.error(`[AccessControl] Ошибка API (${axiosError.response?.status}) при получении пользователей с ${host}: ${axiosError.message}`);
          }
     } else {
        logger.error(`[AccessControl] Неизвестная ошибка получения пользователей с ${host}: ${error.message}`);
     }
    return [];
  }
}

/**
 * Добавляет пользователя на удаленный API VPN-сервера.
 * @param identifier - Telegram ID пользователя в виде строки.
 */
async function addXrayUserToServer(host: string, apiToken: string, identifier: string): Promise<boolean> {
  // ВАЖНО: Используйте HTTPS, если настроили его на удаленном API
  const apiUrl = `http://${host}:3000/api/clients`;
  try {
    logger.info(`[AccessControl] Добавление пользователя (ID: ${identifier}) на ${host}...`);
    // Отправляем { "identifier": "12345" }
    const response = await axios.post(apiUrl, { identifier }, {
      headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      timeout: 20000,
    });
    if (response.status === 201 && response.data.success) {
       logger.info(`[AccessControl] Пользователь (ID: ${identifier}) успешно добавлен на ${host}.`);
      return true;
    } else {
      logger.warn(`[AccessControl] Неожиданный ответ при добавлении (ID: ${identifier}) на ${host}. Статус: ${response.status}, Ответ: ${JSON.stringify(response.data)}`);
      return response.data.success;
    }
  } catch (error: any) {
     if (axios.isAxiosError(error)) {
          const axiosError = error as AxiosError;
           if (axiosError.response?.status === 409) {
               logger.warn(`[AccessControl] Пользователь (ID: ${identifier}) уже существует на ${host}.`);
               return true;
           } else if (axiosError.code === 'ECONNREFUSED' || axiosError.code === 'ETIMEDOUT') {
             logger.error(`[AccessControl] Не удалось подключиться или таймаут при добавлении (ID: ${identifier}) на ${host} (${apiUrl}): ${axiosError.code}`);
          } else {
               logger.error(`[AccessControl] Ошибка API (${axiosError.response?.status}) при добавлении (ID: ${identifier}) на ${host}: ${axiosError.message}`);
          }
     } else {
         logger.error(`[AccessControl] Неизвестная ошибка добавления (ID: ${identifier}) на ${host}: ${error.message}`);
     }
    return false;
  }
}

/**
 * Удаляет пользователя с удаленного API VPN-сервера.
 * @param identifier - Telegram ID пользователя в виде строки.
 */
async function deleteXrayUserFromServer(host: string, apiToken: string, identifier: string): Promise<boolean> {
  // Кодируем идентификатор для URL
  const encodedIdentifier = encodeURIComponent(identifier);
  // ВАЖНО: Используйте HTTPS, если настроили его на удаленном API
  const apiUrl = `http://${host}:3000/api/clients/${encodedIdentifier}`; // Путь вида /api/clients/12345
  try {
    logger.info(`[AccessControl] Удаление пользователя (ID: ${identifier}) с ${host}...`);
    const response = await axios.delete(apiUrl, {
      headers: { 'Authorization': `Bearer ${apiToken}`, 'Accept': 'application/json' },
      timeout: 20000,
    });
     if (response.status === 200 && response.data.success) {
      logger.info(`[AccessControl] Пользователь (ID: ${identifier}) успешно удален с ${host}.`);
      return true;
    } else {
       logger.warn(`[AccessControl] Неожиданный ответ при удалении (ID: ${identifier}) с ${host}. Статус: ${response.status}, Ответ: ${JSON.stringify(response.data)}`);
       return response.data.success;
    }
  } catch (error: any) {
     if (axios.isAxiosError(error)) {
          const axiosError = error as AxiosError;
          if (axiosError.response?.status === 404) {
            logger.warn(`[AccessControl] Пользователь (ID: ${identifier}) не найден на ${host} для удаления.`);
            return true;
          } else if (axiosError.code === 'ECONNREFUSED' || axiosError.code === 'ETIMEDOUT') {
             logger.error(`[AccessControl] Не удалось подключиться или таймаут при удалении (ID: ${identifier}) с ${host} (${apiUrl}): ${axiosError.code}`);
          } else {
             logger.error(`[AccessControl] Ошибка API (${axiosError.response?.status}) при удалении (ID: ${identifier}) с ${host}: ${axiosError.message}`);
          }
     } else {
         logger.error(`[AccessControl] Неизвестная ошибка удаления (ID: ${identifier}) с ${host}: ${error.message}`);
     }
    return false;
  }
}

/**
 * Синхронизирует доступ пользователей на ОДНОМ VPN-сервере.
 */
export async function syncServerAccess(serverId: number): Promise<void> {
  logger.info(`[AccessControl] Начало синхронизации доступа для сервера ID: ${serverId}`);
  const server = await prisma.vpnServer.findUnique({ where: { id: serverId } });

  if (!server || !server.isActive) {
    logger.warn(`[AccessControl] Сервер ID: ${serverId} не найден или неактивен. Пропуск синхронизации.`);
    return;
  }
  if (!server.host || !server.apiToken) {
    logger.warn(`[AccessControl] Сервер ID: ${serverId} (${server?.name}) не имеет хоста или API токена. Пропуск синхронизации.`);
    return;
  }

  try {
    // 1. Получаем активных подписчиков этого сервера из БД, включая telegramId пользователя
    const activeSubscriptions = await prisma.subscription.findMany({
      where: {
        vpnServerId: serverId,
        status: 'ACTIVE',
        endDate: {
             gt: new Date()
         }
      },
      include: {
        user: { // Включаем данные пользователя
          select: { telegramId: true } // Выбираем telegramId
        },
      },
    });

    // Получаем telegramId ИЗ ПОЛЬЗОВАТЕЛЯ, преобразуем в строку
    const subscribedIdentifiers = new Set(
        activeSubscriptions
            .map(sub => sub.user?.telegramId?.toString()) // Берем telegramId, конвертируем в строку
            .filter((id): id is string => !!id) // Отфильтровываем null/undefined и сужаем тип
    );

    if (activeSubscriptions.length > 0 && subscribedIdentifiers.size === 0) {
         logger.warn(`[AccessControl] Сервер ID: ${serverId}. Найдены активные подписки (${activeSubscriptions.length}), но не удалось получить telegramId пользователей.`);
    } else {
       logger.info(`[AccessControl] Сервер ID: ${serverId}. Найдено активных подписчиков с telegramId: ${subscribedIdentifiers.size}`);
    }


    // 2. Получаем текущих пользователей (их идентификаторы) с Xray API
    const xrayUsers = await getXrayUsersFromServer(server.host, server.apiToken);
    const xrayIdentifiers = new Set(xrayUsers.map(user => user.identifier)); // Извлекаем поле identifier
    logger.info(`[AccessControl] Сервер ID: ${serverId}. Найдено пользователей в Xray: ${xrayIdentifiers.size}`);

    // 3. Определяем, кого удалить из Xray (есть в Xray, но нет активной подписки)
    const identifiersToDelete = [...xrayIdentifiers].filter(id => !subscribedIdentifiers.has(id));
    if (identifiersToDelete.length > 0) {
       logger.info(`[AccessControl] Сервер ID: ${serverId}. Идентификаторы к удалению из Xray: ${identifiersToDelete.join(', ')}`);
    }

    // 4. Определяем, кого добавить в Xray (есть активная подписка, но нет в Xray)
    const identifiersToAdd = [...subscribedIdentifiers].filter(id => !xrayIdentifiers.has(id));
     if (identifiersToAdd.length > 0) {
      logger.info(`[AccessControl] Сервер ID: ${serverId}. Идентификаторы к добавлению в Xray: ${identifiersToAdd.join(', ')}`);
    }

     // Если нет изменений, выходим
    if (identifiersToAdd.length === 0 && identifiersToDelete.length === 0) {
        logger.info(`[AccessControl] Сервер ID: ${serverId}. Синхронизация не требуется.`);
        return;
    }


    // 5. Выполняем удаление
    for (const identifier of identifiersToDelete) {
      await deleteXrayUserFromServer(server.host, server.apiToken, identifier); // Передаем identifier
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    // 6. Выполняем добавление
    for (const identifier of identifiersToAdd) {
      await addXrayUserToServer(server.host, server.apiToken, identifier); // Передаем identifier
       await new Promise(resolve => setTimeout(resolve, 300));
    }

    logger.info(`[AccessControl] Синхронизация доступа для сервера ID: ${serverId} завершена.`);

  } catch (error: any) {
    logger.error(`[AccessControl] Критическая ошибка при синхронизации сервера ID ${serverId}: ${error.message}`, error);
  }
}

/**
 * Запускает синхронизацию доступа для ВСЕХ активных VPN-серверов.
 */
export async function checkAllServerAccess(): Promise<void> {
  logger.info(`[AccessControl] Запуск плановой проверки доступа ко всем серверам...`);
  const activeServers = await prisma.vpnServer.findMany({
    where: {
        isActive: true,
        // host: { not: null }, // Не нужно, host не nullable
        apiToken: { not: null } // Проверяем, что токен есть
    },
    select: { id: true } // Выбираем только ID
  });

  logger.info(`[AccessControl] Найдено активных серверов для проверки: ${activeServers.length}`);

  for (const server of activeServers) {
    await syncServerAccess(server.id);
     await new Promise(resolve => setTimeout(resolve, 1000)); // Пауза между серверами
  }

  logger.info(`[AccessControl] Плановая проверка доступа ко всем серверам завершена.`);
}