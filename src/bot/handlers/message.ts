import TelegramBot, { Message } from 'node-telegram-bot-api';
import logger from '../../utils/logger';
import { MessageHandler } from './types';
import { handleSelectGiftPaymentMethod } from './buy';
import { SubscriptionPeriod } from '../../services/payment';

/**
 * Обработчик обычных текстовых сообщений
 * @param bot - экземпляр Telegram бота
 */
export const handleMessage = (bot: TelegramBot) => async (
  message: Message, 
  metadata?: any
): Promise<void> => {
  // Обрабатываем только текстовые сообщения, которые не являются командами
  if (!message.text || message.text.startsWith('/')) {
    return;
  }
  
  try {
    const chatId = message.chat.id;
    
    // Проверяем, ожидает ли пользователь указания получателя подарка
    const userState = global.userStates && global.userStates[chatId];
    
    if (userState && userState.state === 'WAITING_FOR_GIFT_RECIPIENT') {
      // Получаем период подписки из состояния
      const period = userState.data.period as SubscriptionPeriod;
      
      // Получаем имя получателя из сообщения
      const recipientId = message.text.trim();
      
      // Отправляем сообщение о загрузке
      const loadingMsg = await bot.sendMessage(chatId, '⏳ Проверяем получателя...');
      
      // Обрабатываем выбор получателя и метод оплаты
      await handleSelectGiftPaymentMethod(
        bot, 
        chatId, 
        loadingMsg.message_id, 
        recipientId,
        period
      );
      
      return;
    }
    
    // Здесь можно добавить логику обработки других текстовых сообщений
    // Например, ответы на вопросы пользователя, обработка платежей и т.д.
    
    // Простой ответ на неизвестное сообщение
    await bot.sendMessage(chatId, `Для взаимодействия с ботом используйте команды или кнопки в меню. Напишите /help для получения справки.`);
  } catch (error) {
    logger.error(`Ошибка при обработке текстового сообщения: ${error}`);
  }
}; 