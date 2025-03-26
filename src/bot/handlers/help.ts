import TelegramBot, { Message } from 'node-telegram-bot-api';
import logger from '../../utils/logger';
import { MessageHandler } from './types';

/**
 * Обработчик команды /help
 * @param bot - экземпляр Telegram бота
 */
export const handleHelp: MessageHandler = (bot: TelegramBot) => async (message: Message): Promise<void> => {
  try {
    const chatId = message.chat.id;
    
    const helpMessage = `
❓ *Помощь и поддержка*

📝 *Основные команды:*
/start — Начать работу с ботом
/subscription — Управление подписками
/buy — Приобрести подписку
/profile — Информация о вашем профиле
/help — Отобразить это сообщение

📚 *Инструкции по использованию VPN:*
1. Купите подписку через бот
2. Получите файл конфигурации
3. Установите клиент Xray для вашего устройства
4. Импортируйте файл конфигурации в клиент
5. Подключитесь к VPN

📱 *Клиенты для разных устройств:*
• Windows: V2rayN, Qv2ray
• macOS: V2rayU, ClashX
• Android: V2rayNG, Clash
• iOS: Shadowrocket, FairVPN

🆘 *Нужна помощь?*
Если у вас возникли проблемы, напишите команду /support и наш оператор свяжется с вами.
    `;
    
    // Клавиатура с кнопками для инструкций по установке
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Windows', callback_data: 'help_windows' },
            { text: 'macOS', callback_data: 'help_macos' }
          ],
          [
            { text: 'Android', callback_data: 'help_android' },
            { text: 'iOS', callback_data: 'help_ios' }
          ],
          [
            { text: '📋 Все команды', callback_data: 'help_commands' },
            { text: '🔙 Назад', callback_data: 'main_menu' }
          ]
        ]
      },
      parse_mode: 'Markdown' as TelegramBot.ParseMode
    };
    
    await bot.sendMessage(chatId, helpMessage, keyboard);
  } catch (error) {
    logger.error(`Ошибка при обработке команды /help: ${error}`);
    bot.sendMessage(message.chat.id, '😞 Произошла ошибка. Пожалуйста, попробуйте позже.');
  }
}; 