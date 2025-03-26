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
    // В тестовом режиме пропускаем проверку
    if (process.env.NODE_ENV === 'development' && process.env.SKIP_WEBHOOK_VALIDATION === 'true') {
      logger.warn('Пропускаем проверку подписи вебхука в режиме разработки');
      return next();
    }

    const signature = req.headers['signature'] as string;
    const body = JSON.stringify(req.body);

    if (!signature) {
      logger.error('Отсутствует заголовок Signature в запросе вебхука');
      return res.status(401).json({ error: 'Отсутствует подпись' });
    }

    // Проверяем подпись с использованием секретного ключа ЮKassa
    const calculatedSignature = crypto
      .createHmac('sha1', config.yookassaSecretKey)
      .update(body)
      .digest('hex');

    if (signature !== calculatedSignature) {
      logger.error(`Неверная подпись вебхука: ${signature} != ${calculatedSignature}`);
      return res.status(401).json({ error: 'Неверная подпись' });
    }

    logger.debug('Подпись вебхука успешно проверена');
    next();
  } catch (error) {
    logger.error(`Ошибка при проверке подписи вебхука: ${error}`);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
} 