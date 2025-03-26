import { prisma } from './database';
import { checkPaymentStatus } from './payment';
import config from '../config';
import logger from '../utils/logger';

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
  }, 5 * 60 * 1000); // Проверяем каждые 5 минут
  
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
  
  // Проверяем статус каждого платежа в ЮKassa
  for (const payment of pendingPayments) {
    try {
      logger.info(`Проверка статуса платежа: ${payment.id}`);
      const status = await checkPaymentStatus(payment.id);
      logger.info(`Обновлен статус платежа ${payment.id}: ${status}`);
    } catch (error) {
      logger.error(`Ошибка при проверке статуса платежа ${payment.id}: ${error}`);
    }
    
    // Небольшая пауза между запросами, чтобы не перегружать API ЮKassa
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
} 