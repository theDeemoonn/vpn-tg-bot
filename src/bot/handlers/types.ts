import TelegramBot, { Message, CallbackQuery } from 'node-telegram-bot-api';

/**
 * Тип для функции обработчика сообщений
 */
export type MessageHandler = (bot: TelegramBot) => (message: Message, match?: RegExpMatchArray | null) => Promise<void>;

/**
 * Тип для функции обработчика callback-запросов
 */
export type CallbackQueryHandler = (bot: TelegramBot) => (query: CallbackQuery) => Promise<void>; 