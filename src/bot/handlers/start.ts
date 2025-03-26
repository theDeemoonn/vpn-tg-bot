import TelegramBot, { Message } from 'node-telegram-bot-api';
import { findOrCreateUser } from '../../services/user';
import { processReferralCode } from '../../services/referral';
import logger from '../../utils/logger';
import { MessageHandler } from './types';

/**
 * Обработчик команды /start
 * @param bot - экземпляр Telegram бота
 */
export const handleStart: MessageHandler = (bot: TelegramBot) => async (message: Message, match?: RegExpMatchArray | null): Promise<void> => {
  try {
    const chatId = message.chat.id;
    const { first_name, last_name, username } = message.from || {};
    
    // Создаем или находим пользователя
    const user = await findOrCreateUser(
      message.from?.id || 0,
      first_name || 'Пользователь',
      last_name,
      username
    );
    
    // Проверяем, есть ли реферальный код в команде /start
    if (match && match[1]) {
      const referralCode = match[1].trim();
      
      if (referralCode) {
        // Обрабатываем реферальный код
        await processReferralCode(message.from?.id || 0, referralCode)
          .then(success => {
            if (success) {
              bot.sendMessage(chatId, '🎁 Вы успешно использовали реферальный код! Вам и пригласившему вас пользователю будут начислены бонусы.');
            }
          })
          .catch(error => {
            logger.error(`Ошибка при обработке реферального кода: ${error}`);
            bot.sendMessage(chatId, '❌ Не удалось обработать реферальный код. Возможно, он недействителен или вы уже были приглашены.');
          });
      }
    }
    
    // Приветственное сообщение с инструкциями
    const welcomeMessage = `
🔐 *Добро пожаловать в VPN Bot!*

Наш бот поможет вам:
• Приобрести доступ к быстрому и безопасному VPN
• Управлять подписками
• Получать поддержку

📝 *Доступные команды:*
/subscription — Управление подписками
/buy — Приобрести подписку
/profile — Информация о вашем профиле
/referral — Ваша реферальная программа
/help — Помощь и поддержка

Используйте кнопки ниже для навигации 👇
    `;
    
    // Создаем клавиатуру с основными кнопками
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '💳 Купить подписку', callback_data: 'buy' },
            { text: '🔑 Мои подписки', callback_data: 'subscription' }
          ],
          [
            { text: '👤 Профиль', callback_data: 'profile' },
            { text: '👥 Реферальная программа', callback_data: 'referral' }
          ],
          [
            { text: '❓ Помощь', callback_data: 'help' }
          ]
        ]
      },
      parse_mode: 'Markdown' as TelegramBot.ParseMode
    };
    
    await bot.sendMessage(chatId, welcomeMessage, keyboard);
  } catch (error) {
    logger.error(`Ошибка при обработке команды /start: ${error}`);
    bot.sendMessage(message.chat.id, '😞 Произошла ошибка. Пожалуйста, попробуйте позже.');
  }
}; 