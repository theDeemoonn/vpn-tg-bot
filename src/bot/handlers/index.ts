import TelegramBot from 'node-telegram-bot-api';

// Импортируем все обработчики
import { handleStart } from './start';
import { handleHelp } from './help';
import { handleSubscription } from './subscription';
import { handleProfile } from './profile';
import { handleBuy } from './buy';
import { handleAdmin } from './admin';
import { handleReferral } from './referral';
import { handleCallbackQuery, handlePreCheckoutQuery, handleSuccessfulPayment } from './callback';
import { handleMessage } from './message';
import { handleFaq, handleFaqSearchQuery } from './faq';

/**
 * Регистрирует все обработчики для Telegram бота
 * @param bot - экземпляр Telegram бота
 */
export function registerHandlers(bot: TelegramBot): void {
  // Обработчик команды /start
  bot.onText(/\/start\s*(.*)/, handleStart(bot));
  
  // Обработчики основных команд
  bot.onText(/\/help/, handleHelp(bot));
  bot.onText(/\/subscription/, handleSubscription(bot));
  bot.onText(/\/profile/, handleProfile(bot));
  bot.onText(/\/buy/, handleBuy(bot));
  bot.onText(/\/admin/, handleAdmin(bot));
  bot.onText(/\/referral/, handleReferral(bot));
  bot.onText(/\/faq/, handleFaq(bot));
  
  // Обработчик команды поиска по FAQ
  bot.onText(/\/faq_search (.+)/, handleFaqSearchQuery(bot));
  
  // Обработчик callback запросов (для инлайн кнопок)
  bot.on('callback_query', handleCallbackQuery(bot));
  
  // Обработчики для Telegram Payments (ЮKassa)
  bot.on('pre_checkout_query', handlePreCheckoutQuery(bot));
  bot.on('successful_payment', handleSuccessfulPayment(bot));
  
  // Обработчик текстовых сообщений - используем правильный тип события
  bot.on('message', handleMessage(bot));
} 