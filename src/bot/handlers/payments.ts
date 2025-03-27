import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../../utils/logger';
import { prisma } from '../../services/database';
import { handleSuccessfulYookassaTelegramPayment, answerPreCheckoutQuery } from '../../services/yookassaTelegramPayments';

/**
 * Обработчик пре-чекаут запросов от Telegram Payments API
 * Должен ответить в течение 10 секунд, иначе платеж будет отменен
 */
export const handlePreCheckoutQuery = (bot: TelegramBot) => async (query: TelegramBot.PreCheckoutQuery): Promise<void> => {
  try {
    logger.info(`Получен pre-checkout query от пользователя ${query.from.id}: ${query.id}`);
    logger.debug(`Данные pre-checkout query: ${JSON.stringify({
      id: query.id,
      from: query.from.id,
      currency: query.currency,
      total_amount: query.total_amount,
      invoice_payload: query.invoice_payload.substring(0, 50) + '...'
    })}`);
    
    // Парсим данные из payload
    try {
      const payloadData = JSON.parse(query.invoice_payload);
      logger.info(`Данные платежа: userId=${payloadData.userId}, telegramId=${payloadData.telegramId}, период=${payloadData.subscriptionPeriod}`);
      
      // Проверяем данные пользователя
      const user = await prisma.user.findUnique({
        where: { id: parseInt(payloadData.userId, 10) }
      });
      
      if (!user) {
        logger.error(`Пользователь не найден в базе данных: userId=${payloadData.userId}`);
        await answerPreCheckoutQuery(bot, query.id, false, 'Пользователь не найден в системе');
        return;
      }
      
      // Проверяем сумму платежа
      // Здесь можно добавить дополнительные проверки, если необходимо
      
      // Если все проверки прошли успешно, подтверждаем платеж
      logger.info(`Подтверждаем pre-checkout query ${query.id}`);
      await answerPreCheckoutQuery(bot, query.id, true);
      
      // Создаем запись о проверке в логах
      await prisma.paymentLog.create({
        data: {
          type: 'PRE_CHECKOUT',
          paymentId: `tg_${Date.now()}_${payloadData.userId}`, // временный ID, будет заменен при успешном платеже
          data: JSON.stringify({
            queryId: query.id,
            payload: payloadData,
            amount: query.total_amount / 100, // конвертируем из копеек
            currency: query.currency,
            timestamp: new Date().toISOString()
          })
        }
      }).catch(e => logger.warn(`Не удалось создать запись в логах: ${e}`));
    } catch (error) {
      logger.error(`Ошибка при обработке payload: ${error}`);
      await answerPreCheckoutQuery(bot, query.id, false, 'Ошибка при обработке данных платежа');
    }
  } catch (error) {
    logger.error(`Ошибка при обработке pre-checkout query: ${error}`);
    
    // В случае ошибки, пытаемся отклонить платеж
    try {
      await answerPreCheckoutQuery(bot, query.id, false, 'Внутренняя ошибка сервера');
    } catch (answerError) {
      logger.error(`Не удалось ответить на pre-checkout query: ${answerError}`);
    }
  }
};

/**
 * Обработчик успешных платежей от Telegram Payments API
 */
export const handleSuccessfulPayment = (bot: TelegramBot) => async (msg: TelegramBot.Message): Promise<void> => {
  try {
    if (!msg.successful_payment) {
      logger.warn('Получено сообщение без данных об успешном платеже');
      return;
    }
    
    const payment = msg.successful_payment;
    const chatId = msg.chat.id;
    
    logger.info(`Получено уведомление об успешном платеже от пользователя ${chatId}`);
    logger.debug(`Данные платежа: ${JSON.stringify({
      telegram_payment_charge_id: payment.telegram_payment_charge_id,
      provider_payment_charge_id: payment.provider_payment_charge_id,
      currency: payment.currency,
      total_amount: payment.total_amount,
      invoice_payload: payment.invoice_payload.substring(0, 50) + '...'
    })}`);
    
    // Создаем запись о платеже в логах
    await prisma.paymentLog.create({
      data: {
        type: 'SUCCESSFUL_PAYMENT',
        paymentId: payment.provider_payment_charge_id || `tg_${Date.now()}_${chatId}`,
        data: JSON.stringify({
          telegramId: chatId,
          payment: {
            telegram_payment_charge_id: payment.telegram_payment_charge_id,
            provider_payment_charge_id: payment.provider_payment_charge_id,
            currency: payment.currency,
            total_amount: payment.total_amount,
          },
          payload: payment.invoice_payload,
          timestamp: new Date().toISOString()
        })
      }
    }).catch(e => logger.warn(`Не удалось создать запись в логах: ${e}`));
    
    // Отправляем сообщение о получении платежа
    await bot.sendMessage(
      chatId,
      `✅ *Получено подтверждение платежа!*\n\nВаш платеж обрабатывается. Подписка будет активирована в течение нескольких минут.`,
      { parse_mode: 'Markdown' }
    );
    
    // Обрабатываем успешный платеж
    try {
      await handleSuccessfulYookassaTelegramPayment(payment);
      logger.info(`Успешно обработан платеж от пользователя ${chatId}`);
      
      // Отправляем сообщение об успешной активации
      setTimeout(async () => {
        try {
          await bot.sendMessage(
            chatId,
            `✅ *Платеж успешно обработан!*\n\nВаша VPN подписка активирована. Используйте команду /subscription для получения деталей и конфигурации.`,
            { 
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '📋 Моя подписка', callback_data: 'my_subscription' }]
                ]
              }
            }
          );
        } catch (error) {
          logger.error(`Ошибка при отправке сообщения об успешной активации: ${error}`);
        }
      }, 5000); // Небольшая задержка для имитации обработки
    } catch (error) {
      logger.error(`Ошибка при обработке успешного платежа: ${error}`);
      
      // Отправляем сообщение об ошибке
      try {
        await bot.sendMessage(
          chatId,
          `⚠️ *Возникла проблема при активации подписки*\n\nПожалуйста, обратитесь в поддержку, указав ID платежа: \`${payment.provider_payment_charge_id || 'Не указан'}\``,
          { parse_mode: 'Markdown' }
        );
      } catch (msgError) {
        logger.error(`Не удалось отправить сообщение об ошибке: ${msgError}`);
      }
    }
  } catch (error) {
    logger.error(`Ошибка при обработке успешного платежа: ${error}`);
  }
}; 