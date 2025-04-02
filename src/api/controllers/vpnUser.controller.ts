import { Request, Response } from 'express';
import axios, { AxiosError } from 'axios';
import { prisma } from '../../services/database';
import logger from '../../utils/logger';

// Вспомогательная функция для получения данных сервера и проверки токена
async function getServerAndToken(serverId: number) {
  const server = await prisma.vpnServer.findUnique({
    where: { id: serverId },
  });

  if (!server) {
    throw new Error('VPN сервер не найден.');
  }
  if (!server.host) {
    throw new Error('Хост VPN сервера не указан.');
  }
  if (!server.apiToken) {
    throw new Error('API токен для VPN сервера не найден. Возможно, сервер еще не полностью развернут или произошла ошибка при получении токена.');
  }

  // Адрес API на удаленном сервере (порт 3000 захардкожен в скрипте установки)
  // ВАЖНО: Используйте HTTPS, если настроили его на удаленном API
  const apiUrl = `http://${server.host}:3000/api`;

  return { server, apiUrl, apiToken: server.apiToken };
}

/**
 * Получение списка пользователей с VPN сервера
 */
export const getVpnUsers = async (req: Request, res: Response) => {
  const serverId = parseInt(req.params.serverId, 10);
  if (isNaN(serverId)) {
    return res.status(400).json({ error: true, message: 'Некорректный ID сервера.' });
  }

  try {
    const { apiUrl, apiToken } = await getServerAndToken(serverId);

    logger.info(`[VPNUser API] Запрос списка пользователей с сервера ID ${serverId} (${apiUrl}/clients)`);

    const response = await axios.get(`${apiUrl}/clients`, {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Accept': 'application/json',
      },
      timeout: 10000, // Таймаут 10 секунд
    });

    res.json(response.data); // Ожидаем { success: true, clients: [...] }

  } catch (error: any) {
    logger.error(`[VPNUser API] Ошибка получения списка пользователей с сервера ID ${serverId}: ${error.message}`);
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status || 500;
      const message = (axiosError.response?.data as any)?.message || axiosError.message;
      // Добавляем обработку ошибки подключения
      if (axiosError.code === 'ECONNREFUSED') {
         return res.status(503).json({ error: true, message: `Не удалось подключиться к API VPN сервера (${axiosError.config?.url}). Убедитесь, что он запущен и доступен.` });
      }
       if (axiosError.code === 'ETIMEDOUT') {
         return res.status(504).json({ error: true, message: `Превышено время ожидания ответа от API VPN сервера (${axiosError.config?.url}).` });
      }
      return res.status(status).json({ error: true, message: `Ошибка API VPN сервера: ${message}` });
    }
    res.status(400).json({ error: true, message: error.message });
  }
};

/**
 * Добавление пользователя на VPN сервер
 */
export const addVpnUser = async (req: Request, res: Response) => {
  const serverId = parseInt(req.params.serverId, 10);
  const { email } = req.body;

  if (isNaN(serverId)) {
    return res.status(400).json({ error: true, message: 'Некорректный ID сервера.' });
  }
  // Простая проверка email
  if (!email || typeof email !== 'string' || !/\S+@\S+\.\S+/.test(email)) {
    return res.status(400).json({ error: true, message: 'Необходимо указать корректный email нового пользователя.' });
  }

  try {
    const { apiUrl, apiToken } = await getServerAndToken(serverId);

    logger.info(`[VPNUser API] Запрос добавления пользователя '${email}' на сервер ID ${serverId} (${apiUrl}/clients)`);

    const response = await axios.post(`${apiUrl}/clients`,
      { email }, // Тело запроса
      {
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        timeout: 20000, // Увеличил таймаут для добавления
      }
    );

    res.status(response.status).json(response.data); // Ожидаем 201 { success: true, message: ..., client: ... }

  } catch (error: any) {
    logger.error(`[VPNUser API] Ошибка добавления пользователя '${email}' на сервер ID ${serverId}: ${error.message}`);
     if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status || 500;
      const message = (axiosError.response?.data as any)?.message || axiosError.message;
       if (axiosError.code === 'ECONNREFUSED') {
         return res.status(503).json({ error: true, message: `Не удалось подключиться к API VPN сервера (${axiosError.config?.url}). Убедитесь, что он запущен и доступен.` });
      }
      if (axiosError.code === 'ETIMEDOUT') {
         return res.status(504).json({ error: true, message: `Превышено время ожидания ответа от API VPN сервера (${axiosError.config?.url}).` });
      }
      // Особая обработка конфликта (409)
      if (status === 409) {
         return res.status(status).json({ error: true, message: `Пользователь с email '${email}' уже существует на этом сервере.` });
      }
      return res.status(status).json({ error: true, message: `Ошибка API VPN сервера: ${message}` });
    }
    res.status(400).json({ error: true, message: error.message });
  }
};

/**
 * Удаление пользователя с VPN сервера
 */
export const deleteVpnUser = async (req: Request, res: Response) => {
  const serverId = parseInt(req.params.serverId, 10);
  const userEmail = req.params.userEmail;

  if (isNaN(serverId)) {
    return res.status(400).json({ error: true, message: 'Некорректный ID сервера.' });
  }
  if (!userEmail) {
    return res.status(400).json({ error: true, message: 'Необходимо указать email пользователя для удаления.' });
  }

  try {
    const { apiUrl, apiToken } = await getServerAndToken(serverId);

    // Кодируем email на случай, если в нем есть спецсимволы (хотя обычно нет)
    const encodedEmail = encodeURIComponent(userEmail);

    logger.info(`[VPNUser API] Запрос удаления пользователя '${userEmail}' с сервера ID ${serverId} (${apiUrl}/clients/${encodedEmail})`);

    const response = await axios.delete(`${apiUrl}/clients/${encodedEmail}`, {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Accept': 'application/json',
      },
      timeout: 20000, // Увеличил таймаут для удаления
    });

    res.status(response.status).json(response.data); // Ожидаем 200 { success: true, message: ... }

  } catch (error: any) {
    logger.error(`[VPNUser API] Ошибка удаления пользователя '${userEmail}' с сервера ID ${serverId}: ${error.message}`);
     if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status || 500;
      const message = (axiosError.response?.data as any)?.message || axiosError.message;
      if (axiosError.code === 'ECONNREFUSED') {
         return res.status(503).json({ error: true, message: `Не удалось подключиться к API VPN сервера (${axiosError.config?.url}). Убедитесь, что он запущен и доступен.` });
      }
       if (axiosError.code === 'ETIMEDOUT') {
         return res.status(504).json({ error: true, message: `Превышено время ожидания ответа от API VPN сервера (${axiosError.config?.url}).` });
      }
       // Особая обработка 404 (Not Found)
      if (status === 404) {
         return res.status(status).json({ error: true, message: `Пользователь с email '${userEmail}' не найден на этом сервере.` });
      }
      return res.status(status).json({ error: true, message: `Ошибка API VPN сервера: ${message}` });
    }
    res.status(400).json({ error: true, message: error.message });
  }
};