import TelegramBot, { Message } from 'node-telegram-bot-api';
import { getUserActiveSubscriptions } from '../../services/user';
import { prisma } from '../../services/database';
import logger from '../../utils/logger';
import { MessageHandler } from './types';

/**
 * Обработчик команды /profile
 * @param bot - экземпляр Telegram бота
 */
export const handleProfile: MessageHandler = (bot: TelegramBot) => async (message: Message): Promise<void> => {
  try {
    const chatId = message.chat.id;
    const telegramId = message.from?.id || 0;
    
    // Находим пользователя
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramId) }
    });
    
    if (!user) {
      bot.sendMessage(chatId, 'Пожалуйста, используйте /start для начала работы с ботом.');
      return;
    }
    
    // Получаем активные подписки пользователя
    const subscriptions = await getUserActiveSubscriptions(user.id);
    
    // Получаем историю платежей
    const payments = await prisma.payment.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 5
    });
    
    // Формируем сообщение с информацией о профиле
    let profileMessage = `
👤 *Ваш профиль*

🆔 ID: ${user.id}
👤 Имя: ${user.firstName} ${user.lastName || ''}
${user.username ? `📝 Username: @${user.username}` : ''}
📅 Регистрация: ${new Date(user.createdAt).toLocaleDateString()}
🌐 Активных подписок: ${subscriptions.length}
    `;
    
    // Добавляем информацию о последних платежах
    if (payments.length > 0) {
      profileMessage += '\n💳 *Последние платежи:*\n';
      
      for (const payment of payments) {
        const date = new Date(payment.createdAt).toLocaleDateString();
        profileMessage += `${date} - ${payment.amount} ${payment.currency} (${payment.status === 'SUCCEEDED' ? '✅' : payment.status === 'PENDING' ? '⏳' : '❌'})\n`;
      }
    }
    
    // Клавиатура с дополнительными опциями
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔑 Мои подписки', callback_data: 'subscription' },
            { text: '💳 История платежей', callback_data: 'payment_history' }
          ],
          [
            { text: '⚙️ Настройки', callback_data: 'settings' },
            { text: '🔙 Назад', callback_data: 'main_menu' }
          ]
        ]
      },
      parse_mode: 'Markdown' as TelegramBot.ParseMode
    };
    
    await bot.sendMessage(chatId, profileMessage, keyboard);
  } catch (error) {
    logger.error(`Ошибка при обработке команды /profile: ${error}`);
    bot.sendMessage(message.chat.id, '😞 Произошла ошибка. Пожалуйста, попробуйте позже.');
  }
}; 