import TelegramBot, { Message } from 'node-telegram-bot-api';
import { prisma } from '../../services/database';
import logger from '../../utils/logger';
import { MessageHandler } from './types';

/**
 * Обработчик команды /admin
 * @param bot - экземпляр Telegram бота
 */
export const handleAdmin: MessageHandler = (bot: TelegramBot) => async (message: Message): Promise<void> => {
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
    
    // Проверяем, является ли пользователь администратором
    if (!user.isAdmin) {
      bot.sendMessage(chatId, '⛔ У вас нет прав администратора.');
      return;
    }
    
    // Сообщение с административными функциями
    const adminMessage = `
👑 *Панель администратора*

Выберите действие:
    `;
    
    // Клавиатура с административными функциями
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '👥 Управление пользователями', callback_data: 'admin_users' },
            { text: '🌐 Управление серверами', callback_data: 'admin_servers' }
          ],
          [
            { text: '📊 Статистика', callback_data: 'admin_stats' },
            { text: '⚙️ Настройки системы', callback_data: 'admin_settings' }
          ],
          [{ text: '🔙 В главное меню', callback_data: 'main_menu' }]
        ]
      },
      parse_mode: 'Markdown' as TelegramBot.ParseMode
    };
    
    await bot.sendMessage(chatId, adminMessage, keyboard);
  } catch (error) {
    logger.error(`Ошибка при обработке команды /admin: ${error}`);
    bot.sendMessage(message.chat.id, '😞 Произошла ошибка. Пожалуйста, попробуйте позже.');
  }
}; 