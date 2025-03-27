import TelegramBot from 'node-telegram-bot-api';
import { prisma } from '../../services/database';
import * as faqService from '../../services/faq';
import { logger } from '../../utils/logger';

/**
 * Обработчик команды /faq
 */
export const handleFaq = (bot: TelegramBot) => async (msg: TelegramBot.Message) => {
  const chatId = msg.chat.id;
  
  try {
    // Получаем категории FAQ
    const categoriesResult = await faqService.getAllFaqCategories();
    
    if (!categoriesResult.success) {
      await bot.sendMessage(chatId, '❌ Произошла ошибка при получении данных FAQ. Попробуйте позже.');
      return;
    }
    
    if (categoriesResult.data?.length === 0) {
      await bot.sendMessage(chatId, '🔍 В настоящее время FAQ раздел пуст. Пожалуйста, обратитесь в поддержку для получения помощи.');
      return;
    }
    
    // Создаем клавиатуру с категориями
    const keyboard: TelegramBot.InlineKeyboardButton[][] = [];
    
    // Добавляем кнопку поиска
    keyboard.push([{ text: '🔍 Поиск по FAQ', callback_data: 'faq_search' }]);
    
    // Добавляем категории
    categoriesResult.data?.forEach(category => {
      keyboard.push([{ text: category, callback_data: `faq_category_${category}` }]);
    });
    
    // Добавляем кнопку "Назад в меню"
    keyboard.push([{ text: '⬅️ Назад в меню', callback_data: 'back_to_main' }]);
    
    await bot.sendMessage(
      chatId,
      '❓ *Часто задаваемые вопросы*\n\n'
      + 'Выберите категорию вопросов или воспользуйтесь поиском:',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: keyboard,
        },
      }
    );
  } catch (error: any) {
    logger.error(`Ошибка при обработке команды /faq: ${error.message}`);
    await bot.sendMessage(chatId, '❌ Произошла ошибка. Пожалуйста, попробуйте позже.');
  }
};

/**
 * Обработчик для отображения FAQ по категории
 */
export async function handleFaqCategory(
  bot: TelegramBot,
  chatId: number,
  messageId: number,
  category: string
): Promise<void> {
  try {
    const faqResult = await faqService.getFaqByCategory(category);
    
    if (!faqResult.success || faqResult?.data?.length === 0) {
      await bot.editMessageText(
        '❌ В данной категории нет доступных вопросов.',
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад к категориям', callback_data: 'faq' }],
            ],
          },
        }
      );
      return;
    }
    
    // Создаем клавиатуру с вопросами
    const keyboard: TelegramBot.InlineKeyboardButton[][] = [];
    
    faqResult.data?.forEach(item => {
      keyboard.push([{ text: item.question, callback_data: `faq_item_${item.id}` }]);
    });
    
    keyboard.push([{ text: '⬅️ Назад к категориям', callback_data: 'faq' }]);
    
    await bot.editMessageText(
      `📚 *${category}*\n\nВыберите интересующий вас вопрос:`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: keyboard,
        },
      }
    );
  } catch (error: any) {
    logger.error(`Ошибка при отображении FAQ категории: ${error.message}`);
    await bot.sendMessage(chatId, '❌ Произошла ошибка. Пожалуйста, попробуйте позже.');
  }
}

/**
 * Обработчик для отображения ответа на вопрос
 */
export async function handleFaqItem(
  bot: TelegramBot,
  chatId: number,
  messageId: number,
  itemId: number
): Promise<void> {
  try {
    const faqItem = await prisma.faqItem.findUnique({
      where: { id: itemId },
    });
    
    if (!faqItem) {
      await bot.editMessageText(
        '❌ Вопрос не найден.',
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад к категориям', callback_data: 'faq' }],
            ],
          },
        }
      );
      return;
    }
    
    await bot.editMessageText(
      `*${faqItem.question}*\n\n${faqItem.answer}`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: `⬅️ Назад к ${faqItem.category}`, callback_data: `faq_category_${faqItem.category}` }],
            [{ text: '⬅️ Назад к категориям', callback_data: 'faq' }],
          ],
        },
      }
    );
  } catch (error: any) {
    logger.error(`Ошибка при отображении ответа на вопрос: ${error.message}`);
    await bot.sendMessage(chatId, '❌ Произошла ошибка. Пожалуйста, попробуйте позже.');
  }
}

/**
 * Обработчик для активации режима поиска
 */
export async function handleFaqSearch(
  bot: TelegramBot,
  chatId: number,
  messageId: number
): Promise<void> {
  try {
    await bot.editMessageText(
      '🔍 *Поиск по FAQ*\n\nВведите текст для поиска. Начните сообщение с `/faq_search`, например:\n\n`/faq_search как настроить vpn`',
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Назад к категориям', callback_data: 'faq' }],
          ],
        },
      }
    );
  } catch (error: any) {
    logger.error(`Ошибка при активации режима поиска: ${error.message}`);
    await bot.sendMessage(chatId, '❌ Произошла ошибка. Пожалуйста, попробуйте позже.');
  }
}

/**
 * Обработчик для выполнения поиска
 */
export const handleFaqSearchQuery = (bot: TelegramBot) => async (msg: TelegramBot.Message) => {
  const chatId = msg.chat.id;
  
  try {
    // Извлекаем поисковый запрос
    const text = msg.text || '';
    const query = text.replace(/^\/faq_search\s+/i, '').trim();
    
    if (!query) {
      await bot.sendMessage(
        chatId,
        '❌ Пожалуйста, введите текст для поиска после команды `/faq_search`.',
        {
          parse_mode: 'Markdown',
        }
      );
      return;
    }
    
    // Выполняем поиск
    const searchResult = await faqService.searchFaq(query);
    
    if (!searchResult.success || searchResult.data?.length === 0) {
      await bot.sendMessage(
        chatId,
        `🔍 По запросу "${query}" ничего не найдено.\n\nПопробуйте изменить запрос или выбрать категорию:`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Вернуться к категориям', callback_data: 'faq' }],
            ],
          },
        }
      );
      return;
    }
    
    // Создаем клавиатуру с результатами поиска
    const keyboard: TelegramBot.InlineKeyboardButton[][] = [];
    
    searchResult.data?.forEach(item => {
      keyboard.push([{ text: item.question, callback_data: `faq_item_${item.id}` }]);
    });
    
    keyboard.push([{ text: '⬅️ Вернуться к категориям', callback_data: 'faq' }]);
    
    await bot.sendMessage(
      chatId,
      `🔍 Результаты поиска по запросу "${query}":\n\nВыберите вопрос:`,
      {
        reply_markup: {
          inline_keyboard: keyboard,
        },
      }
    );
  } catch (error: any) {
    logger.error(`Ошибка при выполнении поиска по FAQ: ${error.message}`);
    await bot.sendMessage(chatId, '❌ Произошла ошибка. Пожалуйста, попробуйте позже.');
  }
}; 