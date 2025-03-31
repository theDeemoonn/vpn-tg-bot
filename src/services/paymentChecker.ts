import { prisma } from './database';
import config from '../config';
import logger from '../utils/logger';
import { checkYookassaPaymentStatus } from "./yookassaTelegramPayments";

/**
 * Сервис для периодической проверки статусов платежей в ЮKassa
 * Это резервный механизм на случай, если вебхуки не доходят
 */
export async function startPaymentChecker() {
  logger.info('Запуск сервиса проверки платежей');
  
  // Настраиваем периодическую проверку
  setInterval(async () => {
    try {
      await checkPendingPayments();
    } catch (error) {
      logger.error(`Ошибка при проверке платежей: ${error}`);
    }
  }, 60 * 1000); // Проверяем каждую минуту
  
  // Также запускаем проверку сразу при старте сервиса
  try {
    await checkPendingPayments();
  } catch (error) {
    logger.error(`Ошибка при проверке платежей при старте: ${error}`);
  }
}

/**
 * Проверка платежей со статусом PENDING
 */
async function checkPendingPayments() {
  logger.info('Проверка статусов ожидающих платежей');
  
  // Находим все платежи со статусом PENDING
  const pendingPayments = await prisma.payment.findMany({
    where: {
      status: 'PENDING',
      expiresAt: {
        gt: new Date() // Только не истекшие платежи
      }
    }
  });
  
  logger.info(`Найдено ${pendingPayments.length} платежей со статусом PENDING`);
  
  if (pendingPayments.length === 0) {
    return;
  }
  
  // Группируем платежи по типу
  const telegramPayments = pendingPayments.filter(payment => 
    payment.id.startsWith('tg_') || 
    payment.paymentMethod === 'TELEGRAM'
  );
  
  const yookassaTelegramPayments = pendingPayments.filter(payment => 
    payment.paymentMethod === 'YOOKASSA_TELEGRAM'
  );
  
  const yookassaPayments = pendingPayments.filter(payment => 
    !payment.id.startsWith('tg_') && 
    payment.paymentMethod !== 'TELEGRAM' &&
    payment.paymentMethod !== 'YOOKASSA_TELEGRAM'
  );
  
  // Обрабатываем платежи Telegram (если есть)
  if (telegramPayments.length > 0) {
    logger.info(`Обработка ${telegramPayments.length} платежей Telegram`);
    
    for (const payment of telegramPayments) {
      try {
        // Проверяем, не истек ли платеж по времени
        if (payment.expiresAt && new Date(payment.expiresAt) < new Date()) {
          // Если платеж истек, отмечаем его как отмененный
          await prisma.payment.update({
            where: { id: payment.id },
            data: {
              status: 'CANCELED',
              confirmedAt: new Date()
            }
          });
          logger.info(`Платеж Telegram ${payment.id} отмечен как CANCELED (истек срок ожидания)`);
        } else {
          // Мы не можем проверить статус платежа Telegram через API, поэтому оставляем его в текущем состоянии
          logger.info(`Платеж Telegram ${payment.id} оставлен в статусе ${payment.status}`);
        }
      } catch (error) {
        logger.error(`Ошибка при обработке платежа Telegram ${payment.id}: ${error}`);
      }
    }
  }
  
  // Обрабатываем платежи ЮKassa через Telegram (если есть)
  if (yookassaTelegramPayments.length > 0) {
    logger.info(`Обработка ${yookassaTelegramPayments.length} платежей ЮKassa через Telegram`);
    
    for (const payment of yookassaTelegramPayments) {
      try {
        // Проверяем, не истек ли платеж по времени
        if (payment.expiresAt && new Date(payment.expiresAt) < new Date()) {
          // Если платеж истек, отмечаем его как отмененный
          await prisma.payment.update({
            where: { id: payment.id },
            data: {
              status: 'CANCELED',
              confirmedAt: new Date()
            }
          });
          logger.info(`Платеж ЮKassa через Telegram ${payment.id} отмечен как CANCELED (истек срок ожидания)`);
        } else {
          // Платежи ЮKassa через Telegram API не можем проверить напрямую
          logger.info(`Платеж ЮKassa через Telegram ${payment.id} оставлен в статусе ${payment.status}`);
        }
      } catch (error) {
        logger.error(`Ошибка при обработке платежа ЮKassa через Telegram ${payment.id}: ${error}`);
      }
    }
  }
  
  // Обрабатываем платежи ЮKassa (если есть)
  if (yookassaPayments.length > 0) {
    logger.info(`Проверка ${yookassaPayments.length} платежей ЮKassa`);
    
    for (const payment of yookassaPayments) {
      try {
        logger.info(`Проверка статуса платежа ЮKassa: ${payment.id}`);
        const status = await checkYookassaPaymentStatus(payment.id);
        logger.info(`Обновлен статус платежа ${payment.id}: ${status}`);
      } catch (error) {
        logger.error(`Ошибка при проверке статуса платежа ${payment.id}: ${error}`);
        
        // Если ошибка связана с отсутствием платежа (404), отмечаем его как FAILED
        if (typeof error === 'object' && error !== null && 'toString' in error &&
            (error.toString().includes('404') || error.toString().includes('Not Found'))) {
          try {
            await prisma.payment.update({
              where: { id: payment.id },
              data: {
                status: 'FAILED',
                confirmedAt: new Date()
              }
            });
            logger.info(`Платеж ${payment.id} отмечен как FAILED (не найден в ЮKassa)`);
          } catch (updateError) {
            logger.error(`Ошибка при обновлении статуса платежа ${payment.id}: ${updateError}`);
          }
        }
      }
      
      // Небольшая пауза между запросами, чтобы не перегружать API ЮKassa
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
} 