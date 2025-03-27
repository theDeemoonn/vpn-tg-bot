import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import config from '../config';
import logger from '../utils/logger';

/**
 * Middleware для проверки подлинности вебхуков от ЮKassa
 *
 * ЮKassa подписывает все вебхуки, добавляя заголовок Signature
 * Подробнее: https://yookassa.ru/developers/using-api/webhooks
 */
export function validateYookassaWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    // В тестовом режиме пропускаем проверку только если явно указано
    if (process.env.SKIP_WEBHOOK_VALIDATION === 'true') {
      logger.warn('Пропускаем проверку подписи вебхука по настройке SKIP_WEBHOOK_VALIDATION');
      return next();
    }

    const signature = req.headers['signature'] as string;
    // Проверяем наличие сигнатуры в заголовке
    if (!signature) {
      logger.error('Отсутствует заголовок Signature в запросе вебхука');
      return res.status(401).json({ error: 'Отсутствует подпись' });
    }

    // Получаем тело запроса как строку без форматирования
    const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    // Вычисляем подпись с использованием секретного ключа ЮKassa
    const calculatedSignature = crypto
        .createHmac('sha1', config.yookassaSecretKey)
        .update(bodyStr)
        .digest('hex');

    logger.debug(`Полученная подпись: ${signature}`);
    logger.debug(`Вычисленная подпись: ${calculatedSignature}`);

    // Сравниваем подписи
    if (signature !== calculatedSignature) {
      logger.error(`Неверная подпись вебхука: ${signature} != ${calculatedSignature}`);
      // Для отладки логируем тело запроса
      logger.debug(`Тело запроса: ${bodyStr}`);
      return res.status(401).json({ error: 'Неверная подпись' });
    }

    logger.debug('Подпись вебхука успешно проверена');
    next();
  } catch (error) {
    logger.error(`Ошибка при проверке подписи вебхука: ${error}`);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
}