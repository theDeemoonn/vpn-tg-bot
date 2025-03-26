import TelegramBot, { Message } from 'node-telegram-bot-api';
import { getUserActiveSubscriptions } from '../../services/user';
import { prisma } from '../../services/database';
import logger from '../../utils/logger';
import { MessageHandler } from './types';

/**
 * Обработчик команды /subscription
 * @param bot - экземпляр Telegram бота
 */
export const handleSubscription: MessageHandler = (bot: TelegramBot) => async (message: Message): Promise<void> => {
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
    
    // Получаем активные подписки пользователя с данными сервера VPN
    const subscriptions = await getUserActiveSubscriptions(user.id);
    
    if (subscriptions.length === 0) {
      const noSubMessage = `
😕 *У вас нет активных подписок*

Чтобы приобрести подписку, используйте команду /buy или нажмите кнопку ниже.
      `;
      
      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '💳 Купить подписку', callback_data: 'buy' }],
            [{ text: '🔙 Назад', callback_data: 'main_menu' }]
          ]
        },
        parse_mode: 'Markdown' as TelegramBot.ParseMode
      };
      
      bot.sendMessage(chatId, noSubMessage, keyboard);
      return;
    }
    
    // Формируем сообщение с информацией о подписках
    let subscriptionMessage = '🔑 *Ваши активные подписки:*\n\n';
    
    for (const sub of subscriptions) {
      const endDate = new Date(sub.endDate);
      const formattedDate = `${endDate.getDate()}.${endDate.getMonth() + 1}.${endDate.getFullYear()}`;
      
      // Получаем данные VPN сервера для подписки
      let serverName = 'Неизвестно';
      let serverLocation = 'Неизвестно';
      
      // В результате запроса с include: { vpnServer: true } получаем объект с сервером
      const server = await prisma.vpnServer.findUnique({
        where: { id: sub.vpnServerId }
      });
      
      if (server) {
        serverName = server.name;
        serverLocation = server.location;
      }
      
      subscriptionMessage += `🌐 *Подписка #${sub.id}*\n`;
      subscriptionMessage += `📍 Сервер: ${serverName} (${serverLocation})\n`;
      subscriptionMessage += `⏱ Действует до: ${formattedDate}\n`;
      subscriptionMessage += `⬇️ Скорость скачивания: ${sub.downloadSpeed} Mbps\n`;
      subscriptionMessage += `⬆️ Скорость загрузки: ${sub.uploadSpeed} Mbps\n`;
      subscriptionMessage += `🔄 Автопродление: ${sub.autoRenewal ? 'Включено' : 'Отключено'}\n`;
      subscriptionMessage += `📂 Торренты: ${sub.torrentsAllowed ? 'Разрешены' : 'Запрещены'}\n\n`;
    }
    
    // Добавляем клавиатуру с кнопками управления
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📥 Получить конфигурацию', callback_data: `get_config_${subscriptions[0].id}` },
            { text: '🔄 Управление', callback_data: `manage_sub_${subscriptions[0].id}` }
          ],
          [
            { text: '💳 Купить еще', callback_data: 'buy' },
            { text: '🔙 Назад', callback_data: 'main_menu' }
          ]
        ]
      },
      parse_mode: 'Markdown' as TelegramBot.ParseMode
    };
    
    // Если подписок больше одной, добавляем возможность переключения между ними
    if (subscriptions.length > 1) {
      const navigationButtons = subscriptions.map((sub, index) => ({
        text: `${index + 1}`,
        callback_data: `show_sub_${sub.id}`
      }));
      
      keyboard.reply_markup.inline_keyboard.splice(
        1, 0, navigationButtons
      );
    }
    
    await bot.sendMessage(chatId, subscriptionMessage, keyboard);
  } catch (error) {
    logger.error(`Ошибка при обработке команды /subscription: ${error}`);
    bot.sendMessage(message.chat.id, '😞 Произошла ошибка. Пожалуйста, попробуйте позже.');
  }
}; 