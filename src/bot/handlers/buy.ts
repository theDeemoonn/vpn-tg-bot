import TelegramBot, { Message } from 'node-telegram-bot-api';
import { prisma } from '../../services/database';
import {  getPaymentAmount, SubscriptionPeriod } from '../../services/payment';
import config from '../../config';
import logger from '../../utils/logger';
import { MessageHandler } from './types';

/**
 * Обработчик команды /buy
 * @param bot - экземпляр Telegram бота
 */
export const handleBuy: MessageHandler = (bot: TelegramBot) => async (message: Message): Promise<void> => {
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
    
    // Проверяем, активен ли пользователь
    if (!user.isActive) {
      bot.sendMessage(chatId, '⛔ Ваш аккаунт заблокирован. Пожалуйста, обратитесь в поддержку.');
      return;
    }
    
    // Сообщение с тарифами
    const plansMessage = `
💰 *Выберите тариф:*

1️⃣ *Месячный* - ${config.monthlySubscriptionPrice} ₽
   • 30 дней доступа
   • Безлимитный трафик
   • ${config.defaultDownloadSpeed} Mbps скорость

2️⃣ *Квартальный* - ${config.quarterlySubscriptionPrice} ₽
   • 90 дней доступа
   • Безлимитный трафик
   • ${config.defaultDownloadSpeed} Mbps скорость
   • *Выгода ${Math.round((1 - config.quarterlySubscriptionPrice / (config.monthlySubscriptionPrice * 3)) * 100)}%*

3️⃣ *Годовой* - ${config.annualSubscriptionPrice} ₽
   • 365 дней доступа
   • Безлимитный трафик
   • ${config.defaultDownloadSpeed} Mbps скорость
   • *Выгода ${Math.round((1 - config.annualSubscriptionPrice / (config.monthlySubscriptionPrice * 12)) * 100)}%*
    `;
    
    // Клавиатура с выбором тарифов
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: `1 месяц - ${config.monthlySubscriptionPrice} ₽`, callback_data: 'buy_monthly' }],
          [{ text: `3 месяца - ${config.quarterlySubscriptionPrice} ₽`, callback_data: 'buy_quarterly' }],
          [{ text: `12 месяцев - ${config.annualSubscriptionPrice} ₽`, callback_data: 'buy_annual' }],
          [{ text: '🎁 Подарить подписку', callback_data: 'gift_subscription' }],
          [{ text: '🔙 Назад', callback_data: 'main_menu' }]
        ]
      },
      parse_mode: 'Markdown' as TelegramBot.ParseMode
    };
    
    await bot.sendMessage(chatId, plansMessage, keyboard);
  } catch (error) {
    logger.error(`Ошибка при обработке команды /buy: ${error}`);
    bot.sendMessage(message.chat.id, '😞 Произошла ошибка. Пожалуйста, попробуйте позже.');
  }
};

/**
 * Обработчик для выбора метода оплаты
 */
export async function handleSelectPaymentMethod(
  bot: TelegramBot,
  chatId: number,
  messageId: number,
  period: SubscriptionPeriod,
  subscriptionId?: number
): Promise<void> {
  try {
    // Находим пользователя
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(chatId) }
    });
    
    if (!user) {
      await bot.sendMessage(chatId, 'Пожалуйста, используйте /start для начала работы с ботом.');
      return;
    }
    
    // Формируем сообщение с выбором способа оплаты
    const amount = getPaymentAmount(period);
    const periodName = period === SubscriptionPeriod.MONTHLY 
      ? 'Месячный' 
      : period === SubscriptionPeriod.QUARTERLY 
        ? 'Квартальный' 
        : 'Годовой';
    
    const message = `
💳 *Выберите способ оплаты*

Тариф: ${periodName}
Сумма: ${amount} ₽
${subscriptionId ? 'Продление подписки' : 'Новая подписка'}

Выберите удобный способ оплаты:
    `;
    
    // Формируем callback data с учетом ID подписки, если есть
    const periodStr = period.toString();
    const subscriptionSuffix = subscriptionId ? `_${subscriptionId}` : '';
    
    // Упрощённая клавиатура с единой кнопкой оплаты через Telegram
    const keyboard: TelegramBot.InlineKeyboardButton[][] = [];
    
    // Проверяем наличие интеграции ЮKassa через Telegram
    if (config.yookassaTelegramEnabled) {
      keyboard.push([{ 
        text: '💳 Оплатить через Telegram', 
        callback_data: `pay_telegram_${periodStr}${subscriptionSuffix}` 
      }]);
      
      logger.info('Добавлена кнопка оплаты через ЮKassa в Telegram');
    } else if (config.telegramPaymentToken && config.telegramPaymentToken.trim() !== '') {
      // Альтернативная интеграция с Telegram Payments (если включена)
      keyboard.push([{ 
        text: '💳 Оплатить через Telegram', 
        callback_data: `pay_telegram_direct_${periodStr}${subscriptionSuffix}` 
      }]);
      
      logger.info('Добавлена кнопка прямой оплаты через Telegram');
    }
    
    // Веб-ссылка для оплаты через страницу ЮKassa (если первые два варианта недоступны)
    if (keyboard.length === 0) {
      keyboard.push([{ 
        text: '💳 Оплатить банковской картой', 
        callback_data: `pay_card_${periodStr}${subscriptionSuffix}` 
      }]);
      
      logger.info('Добавлена кнопка оплаты через веб-страницу');
    }
    
    // Добавляем кнопку "Назад"
    keyboard.push([{ text: '🔙 Назад к тарифам', callback_data: subscriptionId ? `renew_subscription_${subscriptionId}` : 'buy' }]);
    
    // Отправляем сообщение с выбором метода оплаты
    await bot.editMessageText(message, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: keyboard
      }
    });
    
    // Очищаем состояние
    if (global.userStates && global.userStates[chatId]) {
      delete global.userStates[chatId];
    }
    
  } catch (error: any) {
    logger.error(`Ошибка при выборе метода оплаты: ${error.message}`);
    await bot.sendMessage(chatId, 'Произошла ошибка. Пожалуйста, попробуйте позже.');
  }
}

/**
 * Обработчик для выбора периода подписки для подарка
 */
export async function handleGiftSubscription(
  bot: TelegramBot,
  chatId: number,
  messageId: number
): Promise<void> {
  try {
    // Находим пользователя
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(chatId) }
    });
    
    if (!user) {
      await bot.sendMessage(chatId, 'Пожалуйста, используйте /start для начала работы с ботом.');
      return;
    }
    
    // Формируем сообщение с выбором периода подписки для подарка
    const message = `
🎁 *Подарить подписку*

Выберите период подписки, который хотите подарить:
    `;
    
    // Клавиатура с выбором тарифов для подарка
    const keyboard = {
      inline_keyboard: [
        [{ text: `1 месяц - ${config.monthlySubscriptionPrice} ₽`, callback_data: 'gift_monthly' }],
        [{ text: `3 месяца - ${config.quarterlySubscriptionPrice} ₽`, callback_data: 'gift_quarterly' }],
        [{ text: `12 месяцев - ${config.annualSubscriptionPrice} ₽`, callback_data: 'gift_annual' }],
        [{ text: '⬅️ Назад', callback_data: 'buy' }]
      ]
    };
    
    // Отправляем сообщение с выбором периода
    await bot.editMessageText(message, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  } catch (error: any) {
    logger.error(`Ошибка при обработке подарка подписки: ${error.message}`);
    await bot.sendMessage(chatId, 'Произошла ошибка. Пожалуйста, попробуйте позже.');
  }
}

/**
 * Обработчик для запроса юзернейма получателя подарка
 */
export async function handleRequestGiftRecipient(
  bot: TelegramBot,
  chatId: number,
  messageId: number,
  period: SubscriptionPeriod
): Promise<void> {
  try {
    // Сообщение с инструкцией
    const periodText = period === SubscriptionPeriod.MONTHLY
      ? "1 месяц"
      : period === SubscriptionPeriod.QUARTERLY
        ? "3 месяца"
        : "12 месяцев";
    
    const message = `
🎁 *Подарить подписку на ${periodText}*

Введите @username или ID получателя подарка:

(Отправьте сообщение в формате @username или числовой ID)
    `;
    
    // Клавиатура с кнопкой отмены
    const keyboard = {
      inline_keyboard: [
        [{ text: '⬅️ Отмена', callback_data: 'gift_subscription' }]
      ]
    };
    
    // Отправляем сообщение с запросом получателя
    await bot.editMessageText(message, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
    
    // Сохраняем состояние в глобальном объекте
    global.userStates = global.userStates || {};
    global.userStates[chatId] = {
      state: 'waiting_for_gift_recipient',
      period: period
    };
  } catch (error: any) {
    logger.error(`Ошибка при запросе получателя подарка: ${error.message}`);
    await bot.sendMessage(chatId, 'Произошла ошибка. Пожалуйста, попробуйте позже.');
  }
}

/**
 * Обработчик для выбора метода оплаты подарочной подписки
 */
export async function handleSelectGiftPaymentMethod(
  bot: TelegramBot,
  chatId: number,
  messageId: number,
  recipientId: string,
  period: SubscriptionPeriod
): Promise<void> {
  try {
    // Находим пользователя-отправителя
    const sender = await prisma.user.findUnique({
      where: { telegramId: BigInt(chatId) }
    });
    
    if (!sender) {
      await bot.sendMessage(chatId, 'Пожалуйста, используйте /start для начала работы с ботом.');
      return;
    }

    // Находим пользователя-получателя
    const recipient = await findRecipientUser(recipientId);
    
    if (!recipient) {
      await bot.editMessageText(
        `❌ Получатель не найден. Пожалуйста, проверьте правильность введенного ID или убедитесь, что получатель уже зарегистрирован в боте.`,
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад', callback_data: `gift_${period}` }]
            ]
          }
        }
      );
      return;
    }

    // Создаем запись о подарочной подписке
    const giftSubscription = await prisma.giftSubscription.create({
      data: {
        senderId: sender.id,
        recipientId: recipient.id,
        status: 'PENDING',
        period: period
      }
    });

    // Формируем сообщение с выбором способа оплаты
    const amount = getPaymentAmount(period);
    const periodName = period === SubscriptionPeriod.MONTHLY
      ? 'месячный'
      : period === SubscriptionPeriod.QUARTERLY
        ? 'квартальный'
        : 'годовой';

    const recipientName = recipient.username
      ? '@' + recipient.username
      : recipient.firstName
        ? recipient.firstName
        : 'ID: ' + recipient.telegramId.toString();

    const message = `
🎁 *Подарочная подписка*

Получатель: ${recipientName}
Тариф: ${periodName}
Сумма: ${amount} ₽

Выберите способ оплаты:
    `;

    // Клавиатура с выбором способа оплаты
    const keyboard: TelegramBot.InlineKeyboardButton[][] = [];
    
    // Проверяем наличие интеграции ЮKassa через Telegram
    if (config.yookassaTelegramEnabled) {
      keyboard.push([{ 
        text: '💳 Оплатить через Telegram', 
        callback_data: `pay_gift_telegram_${giftSubscription.id}` 
      }]);
    } else if (config.telegramPaymentToken && config.telegramPaymentToken.trim() !== '') {
      // Альтернативная интеграция с Telegram Payments
      keyboard.push([{ 
        text: '💳 Оплатить через Telegram', 
        callback_data: `pay_gift_telegram_direct_${giftSubscription.id}` 
      }]);
    }
    
    // Веб-ссылка для оплаты через страницу ЮKassa
    if (keyboard.length === 0) {
      keyboard.push([{ 
        text: '💳 Оплатить банковской картой', 
        callback_data: `pay_gift_card_${giftSubscription.id}` 
      }]);
    }
    
    // Добавляем кнопку "Назад"
    keyboard.push([{ text: '⬅️ Назад', callback_data: 'gift_subscription' }]);
    
    // Отправляем сообщение с выбором метода оплаты
    await bot.editMessageText(message, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: keyboard
      }
    });
    
    // Сбрасываем состояние
    if (global.userStates && global.userStates[chatId]) {
      delete global.userStates[chatId];
    }
  } catch (error: any) {
    logger.error(`Ошибка при выборе метода оплаты подарочной подписки: ${error.message}`);
    await bot.sendMessage(chatId, 'Произошла ошибка. Пожалуйста, попробуйте позже.');
  }
}

/**
 * Поиск пользователя-получателя по ID или username
 */
async function findRecipientUser(recipientId: string) {
  try {
    let recipient;
    
    // Проверяем, является ли recipientId числом или строкой с @
    if (/^\d+$/.test(recipientId)) {
      // Если это число, ищем по telegramId
      recipient = await prisma.user.findUnique({
        where: { telegramId: BigInt(recipientId) }
      });
    } else if (recipientId.startsWith('@')) {
      // Если это @username, ищем по username без @
      recipient = await prisma.user.findFirst({
        where: { username: recipientId.substring(1) }
      });
    } else {
      // В других случаях пробуем искать по username как есть
      recipient = await prisma.user.findFirst({
        where: { username: recipientId }
      });
    }
    
    return recipient;
  } catch (error) {
    logger.error(`Ошибка при поиске получателя: ${error}`);
    return null;
  }
} 