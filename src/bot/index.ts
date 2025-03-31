import TelegramBot from 'node-telegram-bot-api';
import config from '../config';
import logger from '../utils/logger';
import { registerHandlers } from './handlers';
import { connectToDatabase } from '../services/database';

// Инициализация бота
const bot = new TelegramBot(config.telegramBotToken, { 
  polling: {
    interval: 300,
    autoStart: true,
    params: {
      timeout: 10
    }
  }
});

// Экспортируем бот по умолчанию
export default bot;

// Функция для инициализации бота
export async function startBot(): Promise<TelegramBot> {
  try {
    // Подключаемся к базе данных
    await connectToDatabase();
    
    // Устанавливаем команды меню
    await bot.setMyCommands([
      { command: '/start', description: 'Запустить бота' },
      { command: '/subscription', description: 'Управление подписками' },
      { command: '/buy', description: 'Приобрести подписку' },
      { command: '/profile', description: 'Информация о профиле' },
      { command: '/referral', description: 'Реферальная программа' },
      { command: '/faq', description: 'Часто задаваемые вопросы' },
      { command: '/help', description: 'Помощь и поддержка' }
    ]);
    
    // Регистрируем обработчики команд и сообщений
    registerHandlers(bot);
    
    logger.info('Бот успешно запущен');
    
    // Отправляем уведомление админу о запуске бота, если указан adminChatId
    if (config.adminChatId) {
      bot.sendMessage(
        config.adminChatId,
        '🚀 Бот запущен и готов к работе!'
      ).catch(error => {
        logger.error(`Не удалось отправить сообщение администратору: ${error}`);
      });
    }
    
    // Обработчик ошибок в работе бота
    bot.on('polling_error', (error) => {
      logger.error(`Ошибка опроса Telegram API: ${error}`);
    });
    
    return bot;
  } catch (error) {
    logger.error(`Ошибка при запуске бота: ${error}`);
    throw error;
  }
} 