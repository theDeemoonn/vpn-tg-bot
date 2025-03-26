import TelegramBot from 'node-telegram-bot-api';
import { PrismaClient, User, PaymentStatus } from '@prisma/client';
import { logger } from '../utils/logger';
import config from '../config';
import { prisma } from './database';
import { SubscriptionPeriod, getPaymentAmount, getSubscriptionDuration } from './payment';
import axios from 'axios';

/**
 * Сервис для работы с платежами через Telegram Payments
 */

/**
 * Создает платежный счет в Telegram Payments
 * @param bot Экземпляр Telegram бота
 * @param chatId ID чата для отправки инвойса
 * @param user Пользователь
 * @param period Период подписки
 * @param options Дополнительные опции (для подарка или продления)
 * @returns Объект с результатом операции
 */
export async function createTelegramInvoice(
  bot: TelegramBot,
  chatId: number,
  user: User,
  period: SubscriptionPeriod,
  options?: {
    subscriptionId?: number;
    isGift?: boolean;
    giftSubscriptionId?: number;
    recipientId?: number;
  }
): Promise<{ success: boolean; error?: string }> {
  try {
    // Проверяем наличие токена для Telegram Payments
    logger.info(`Создаю инвойс для пользователя: ${user.id}, telegramId: ${user.telegramId}, период: ${period}`);
    logger.info(`Конфигурация Telegram Payments: Включены: ${config.enableTelegramPayments}, Токен установлен: ${!!config.telegramPaymentToken}`);
    
    if (!config.enableTelegramPayments) {
      throw new Error('Telegram Payments отключены в настройках');
    }
    
    if (!config.telegramPaymentToken || config.telegramPaymentToken.trim() === '') {
      throw new Error('Отсутствует токен для Telegram Payments');
    }
    
    // Проверяем формат токена (должен быть в формате 123456789:TEST:123456789)
    const tokenParts = config.telegramPaymentToken.split(':');
    if (tokenParts.length < 2) {
      throw new Error('Неверный формат токена Telegram Payments');
    }
    
    // Получаем сумму и описание подписки
    const amount = getPaymentAmount(period);
    const isGift = options?.isGift || false;
    const title = isGift 
      ? `Подарочная VPN подписка - ${getPeriodName(period)}` 
      : `VPN подписка - ${getPeriodName(period)}`;
    
    let description = getSubscriptionDescription(period);
    if (isGift) {
      description = `Подарочная ${description.toLowerCase()}`;
    }
    
    // Генерируем уникальный payload для платежа
    const payload = JSON.stringify({
      userId: user.id,
      period,
      subscriptionId: options?.subscriptionId,
      isGift,
      giftSubscriptionId: options?.giftSubscriptionId,
      recipientId: options?.recipientId,
      timestamp: Date.now()
    });
    
    // Создаем запись о платеже в БД
    const paymentId = `tg_${Date.now()}_${user.id}`;
    await prisma.payment.create({
      data: {
        id: paymentId,
        userId: user.id,
        subscriptionId: options?.subscriptionId,
        amount,
        currency: 'RUB',
        status: PaymentStatus.PENDING,
        description,
        paymentMethod: 'TELEGRAM',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // Платеж активен 24 часа
      }
    });
    
    // Если это подарочная подписка, обновляем запись о ней
    if (isGift && options?.giftSubscriptionId) {
      await prisma.giftSubscription.update({
        where: { id: options.giftSubscriptionId },
        data: {
          paymentId
        }
      });
    }
    
    // Формируем массив цен с правильными типами данных
    const prices = [
      {
        label: title,
        amount: Math.round(amount * 100)
      }
    ];
    
    // Проверяем и приводим к правильному формату цены
    const formattedPrices = prices.map(price => ({
      label: String(price.label),
      amount: Number(price.amount)
    }));
    
    logger.info(`Отправляем инвойс пользователю ${user.id} на сумму ${amount} руб.`);
    logger.debug(`Параметры инвойса: title=${title}, description=${description}, token=${config.telegramPaymentToken.substring(0, 10)}..., currency=RUB`);
    logger.debug(`Параметр prices: ${JSON.stringify(formattedPrices)}`);
    
    // Добавляем дополнительные параметры для отправки инвойса
    const invoiceOptions: TelegramBot.SendInvoiceOptions = {
      photo_url: 'https://i.imgur.com/SrUCGfw.jpg', // URL изображения для счета (опционально)
      need_name: false,
      need_phone_number: false,
      need_email: false,
      need_shipping_address: false,
      is_flexible: false,
      disable_notification: false,
      protect_content: false,
      max_tip_amount: 0,
      suggested_tip_amounts: [],
      start_parameter: `vpn_payment_${period}`
    };
    
    // Пробуем отправить инвойс пользователю
    try {
      logger.debug(`Отправка инвойса с параметрами: chatId=${chatId}, title=${title}, payload=${payload.substring(0, 30)}..., currency=RUB`);
      
      try {
        // Сначала пробуем стандартный метод
        await bot.sendInvoice(
          chatId,
          title,
          description,
          payload,
          config.telegramPaymentToken,
          'pay',
          'RUB',
          formattedPrices,
          invoiceOptions
        );
      } catch (standardMethodError: any) {
        logger.warn(`Ошибка при использовании стандартного метода sendInvoice: ${standardMethodError.message}. Пробуем прямой API запрос.`);
        
        // Если стандартный метод не сработал, пробуем прямой API запрос
        await sendInvoiceDirectAPI(
          chatId,
          title,
          description,
          payload,
          config.telegramPaymentToken,
          'RUB',
          formattedPrices,
          {
            ...invoiceOptions,
            start_parameter: `vpn_payment_${period}`
          }
        );
      }
      
      logger.info(`Инвойс успешно отправлен пользователю ${user.id}`);
      return { success: true };
    } catch (invoiceError: any) {
      // Если произошла ошибка при отправке инвойса, логируем ее и возвращаем клиенту
      logger.error(`Ошибка при отправке инвойса через Telegram API: ${invoiceError.message}`, { 
        error: invoiceError, 
        token_prefix: config.telegramPaymentToken.substring(0, 5),
        currency: 'RUB'
      });
      
      // Удаляем созданный платеж из БД, так как отправка инвойса не удалась
      await prisma.payment.delete({ where: { id: paymentId } }).catch(e => {
        logger.error(`Не удалось удалить платеж ${paymentId} после ошибки отправки инвойса: ${e}`);
      });
      
      throw new Error(`Ошибка при отправке инвойса: ${invoiceError.message}`);
    }
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.error(`Ошибка при создании инвойса Telegram: ${errorMessage}`, { error: errorStack });
    return { success: false, error: errorMessage };
  }
}

/**
 * Обрабатывает успешный платеж в Telegram Payments
 * @param payloadData Распарсенные данные платежа
 * @param amount Сумма платежа в рублях
 */
export async function handleSuccessfulTelegramPayment(
  payloadData: {
    userId: number;
    period: SubscriptionPeriod;
    subscriptionId?: number;
    isGift?: boolean;
    giftSubscriptionId?: number;
    recipientId?: number;
    timestamp?: number;
  },
  amount: number,
  telegramPaymentChargeId?: string
): Promise<void> {
  try {
    logger.info(`Обработка успешного платежа Telegram: Пользователь ${payloadData.userId}, период ${payloadData.period}, сумма ${amount} руб.`);
    
    const { 
      userId, 
      period, 
      subscriptionId, 
      isGift,
      giftSubscriptionId,
      recipientId 
    } = payloadData;
    
    // Проверяем, существует ли пользователь
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    
    if (!user) {
      logger.error(`Пользователь не найден при обработке платежа Telegram: ${userId}`);
      throw new Error(`Пользователь не найден: ${userId}`);
    }
    
    // Ищем соответствующий платеж в системе
    const payment = await prisma.payment.findFirst({
      where: {
        userId,
        subscriptionId: subscriptionId || null,
        status: PaymentStatus.PENDING
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
    
    if (!payment) {
      logger.error(`Платеж не найден для пользователя ${userId}, период ${period}`);
      throw new Error(`Платеж не найден для пользователя ${userId}`);
    }
    
    // Обновляем статус платежа
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.SUCCEEDED,
        confirmedAt: new Date(),
        paymentMethod: telegramPaymentChargeId ? `TELEGRAM:${telegramPaymentChargeId}` : 'TELEGRAM'
      }
    });
    
    logger.info(`Платеж ${payment.id} успешно обновлен до статуса SUCCEEDED`);
    
    // Обрабатываем платеж в зависимости от типа
    try {
      if (isGift && giftSubscriptionId && recipientId) {
        // Обработка подарочной подписки
        await handleGiftPayment(userId, giftSubscriptionId, recipientId, period);
      } else if (subscriptionId) {
        // Продление подписки
        await handleSubscriptionRenewal(userId, subscriptionId, period);
      } else {
        // Создание новой подписки
        await handleNewSubscription(userId, period);
      }
      
      logger.info(`Успешно обработан платеж Telegram для пользователя ${userId}`);
    } catch (processingError: any) {
      logger.error(`Ошибка при обработке подписки: ${processingError.message}`, { error: processingError });
      throw processingError;
    }
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.error(`Ошибка при обработке платежа Telegram: ${errorMessage}`, { error: errorStack });
    throw error; // Пробрасываем ошибку дальше для корректной обработки вызывающей стороной
  }
}

/**
 * Обрабатывает подарочную подписку
 */
async function handleGiftPayment(
  senderId: number,
  giftSubscriptionId: number,
  recipientId: number,
  period: SubscriptionPeriod
): Promise<void> {
  try {
    // Обновляем статус подарочной подписки
    await prisma.giftSubscription.update({
      where: { id: giftSubscriptionId },
      data: {
        status: 'PAID'
      }
    });
    
    // Находим отправителя и получателя
    const sender = await prisma.user.findUnique({
      where: { id: senderId }
    });
    
    const recipient = await prisma.user.findUnique({
      where: { id: recipientId }
    });
    
    if (!sender || !recipient) {
      logger.error(`Не найден отправитель или получатель для подарочной подписки: ${giftSubscriptionId}`);
      return;
    }
    
    // Отправляем уведомления
    try {
      const bot = require('../bot').default;
      
      if (bot) {
        const periodName = period === SubscriptionPeriod.MONTHLY
          ? 'Месячная'
          : period === SubscriptionPeriod.QUARTERLY
            ? 'Квартальная'
            : 'Годовая';
        
        const recipientName = recipient.username
          ? '@' + recipient.username
          : recipient.firstName || recipient.telegramId.toString();
        
        // Уведомление отправителю
        await bot.sendMessage(
          sender.telegramId.toString(),
          `✅ Оплата подарочной подписки успешно завершена!\n\nПолучатель: ${recipientName}\nТариф: ${periodName} подписка\n\nПолучатель получит уведомление о вашем подарке.`
        );
        
        // Уведомление получателю
        const senderName = sender.username
          ? '@' + sender.username
          : sender.firstName || sender.telegramId.toString();
        
        const keyboard = {
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Активировать подарок', callback_data: `redeem_gift_${giftSubscriptionId}` }]
            ]
          }
        };
        
        await bot.sendMessage(
          recipient.telegramId.toString(),
          `🎁 *Вам подарили VPN-подписку!*\n\nОтправитель: ${senderName}\nТариф: ${periodName} подписка\n\nНажмите кнопку ниже, чтобы активировать подарок.`,
          {
            parse_mode: 'Markdown',
            ...keyboard
          }
        );
      }
    } catch (error) {
      logger.error(`Ошибка при отправке уведомлений о подарке: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    logger.info(`Успешно обработана подарочная подписка #${giftSubscriptionId}`);
  } catch (error) {
    logger.error(`Ошибка при обработке подарочной подписки: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Обрабатывает продление подписки
 */
async function handleSubscriptionRenewal(
  userId: number,
  subscriptionId: number,
  period: SubscriptionPeriod
): Promise<void> {
  try {
    // Находим подписку
    const subscription = await prisma.subscription.findFirst({
      where: {
        id: subscriptionId,
        userId
      }
    });
    
    if (!subscription) {
      logger.error(`Подписка не найдена: ${subscriptionId}`);
      return;
    }
    
    // Рассчитываем новую дату окончания
    const durationInDays = getSubscriptionDuration(period);
    const newEndDate = new Date(subscription.endDate);
    newEndDate.setDate(newEndDate.getDate() + durationInDays);
    
    // Обновляем подписку
    await prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        status: 'ACTIVE',
        endDate: newEndDate
      }
    });
    
    logger.info(`Подписка ${subscriptionId} продлена до ${newEndDate}`);
  } catch (error) {
    logger.error(`Ошибка при продлении подписки: ${error.message}`);
  }
}

/**
 * Обрабатывает создание новой подписки
 */
async function handleNewSubscription(
  userId: number,
  period: SubscriptionPeriod
): Promise<void> {
  try {
    // Логика создания новой подписки (будет реализована в сервисе подписок)
    logger.info(`Запрос на создание новой подписки для пользователя ${userId}`);
  } catch (error) {
    logger.error(`Ошибка при создании новой подписки: ${error.message}`);
  }
}

/**
 * Получает название периода подписки
 */
function getPeriodName(period: SubscriptionPeriod): string {
  switch (period) {
    case SubscriptionPeriod.MONTHLY:
      return 'Месячная';
    case SubscriptionPeriod.QUARTERLY:
      return 'Квартальная';
    case SubscriptionPeriod.ANNUAL:
      return 'Годовая';
    default:
      return 'Стандартная';
  }
}

/**
 * Получает описание подписки
 */
function getSubscriptionDescription(period: SubscriptionPeriod): string {
  switch (period) {
    case SubscriptionPeriod.MONTHLY:
      return 'Месячная подписка на VPN сервис';
    case SubscriptionPeriod.QUARTERLY:
      return 'Квартальная подписка на VPN сервис (3 месяца)';
    case SubscriptionPeriod.ANNUAL:
      return 'Годовая подписка на VPN сервис (12 месяцев)';
    default:
      return 'Подписка на VPN сервис';
  }
}

/**
 * Создает платежный счет в Telegram Payments через прямой API запрос
 * Это альтернативный метод, который можно использовать, если стандартный метод не работает
 */
async function sendInvoiceDirectAPI(
  chatId: number,
  title: string,
  description: string,
  payload: string,
  providerToken: string,
  currency: string,
  prices: Array<{ label: string; amount: number }>,
  options: any = {}
): Promise<any> {
  try {
    const apiUrl = `https://api.telegram.org/bot${config.telegramBotToken}/sendInvoice`;
    
    // Убедимся, что цены в правильном формате
    const formattedPrices = prices.map(price => ({
      label: String(price.label),
      amount: Number(price.amount)
    }));
    
    const data = {
      chat_id: chatId,
      title: String(title),
      description: String(description),
      payload: String(payload),
      provider_token: String(providerToken),
      currency: String(currency),
      prices: formattedPrices,
      start_parameter: options.start_parameter || 'payment',
      photo_url: options.photo_url,
      photo_size: options.photo_size,
      photo_width: options.photo_width,
      photo_height: options.photo_height,
      need_name: Boolean(options.need_name) || false,
      need_phone_number: Boolean(options.need_phone_number) || false,
      need_email: Boolean(options.need_email) || false,
      need_shipping_address: Boolean(options.need_shipping_address) || false,
      is_flexible: Boolean(options.is_flexible) || false,
      disable_notification: Boolean(options.disable_notification) || false,
      protect_content: Boolean(options.protect_content) || false,
    };
    
    // Удаляем undefined значения
    Object.keys(data).forEach(key => {
      if (data[key] === undefined) {
        delete data[key];
      }
    });
    
    logger.debug(`Отправка прямого API запроса к Telegram: ${JSON.stringify({
      ...data,
      provider_token: data.provider_token.substring(0, 10) + '...',
      prices: data.prices
    })}`);
    
    const response = await axios.post(apiUrl, data);
    
    logger.debug(`Ответ API Telegram: ${JSON.stringify(response.data)}`);
    
    return response.data;
  } catch (error: any) {
    logger.error(`Ошибка при отправке прямого API запроса к Telegram: ${error.message}`, {
      error: error.response?.data || error
    });
    throw error;
  }
} 