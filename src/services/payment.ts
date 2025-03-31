import YooKassa from 'yookassa';
import { Payment, PaymentStatus, User } from '@prisma/client';
import { prisma } from './database';
import config from '../config';
import logger from '../utils/logger';
import { checkYookassaPaymentStatus } from "./yookassaTelegramPayments";

// Инициализация ЮKassa с данными магазина
const yooKassa = new YooKassa({
  shopId: config.yookassaShopId,
  secretKey: config.yookassaSecretKey
});

// Периоды подписки
export enum SubscriptionPeriod {
  MONTHLY = 'monthly',
  QUARTERLY = 'quarterly',
  ANNUAL = 'annual'
}

// Функция получения названия периода подписки
export function getPeriodName(period: SubscriptionPeriod): string {
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

// Функция получения описания подписки
export function getSubscriptionDescription(period: SubscriptionPeriod): string {
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

// Получение суммы платежа в зависимости от выбранного периода
export function getPaymentAmount(period: SubscriptionPeriod): number {
  switch (period) {
    case SubscriptionPeriod.MONTHLY:
      return config.monthlySubscriptionPrice;
    case SubscriptionPeriod.QUARTERLY:
      return config.quarterlySubscriptionPrice;
    case SubscriptionPeriod.ANNUAL:
      return config.annualSubscriptionPrice;
    default:
      return config.monthlySubscriptionPrice;
  }
}

// Получение продолжительности подписки в днях
export function getSubscriptionDuration(period: SubscriptionPeriod): number {
  switch (period) {
    case SubscriptionPeriod.MONTHLY:
      return 30; // 30 дней
    case SubscriptionPeriod.QUARTERLY:
      return 90; // 90 дней
    case SubscriptionPeriod.ANNUAL:
      return 365; // 365 дней
    default:
      return 30;
  }
}

// Создание ссылки на оплату через ЮKassa (для веб-формы)
export async function createPayment(
  user: User,
  period: SubscriptionPeriod,
  returnUrl: string,
  subscriptionId?: number,
  options?: {
    isGift?: boolean;
    recipientId?: number;
    giftSubscriptionId?: number;
  }
): Promise<string> {
  try {
    const amount = getPaymentAmount(period);
    const description = options?.isGift
      ? `Подарочная ${getSubscriptionDescription(period).toLowerCase()}`
      : getSubscriptionDescription(period);

    // Создаем метаданные платежа
    const metadata: any = {
      userId: user.id.toString(),
      subscriptionPeriod: period,
    };

    // Добавляем ID подписки, если указан
    if (subscriptionId) {
      metadata.subscriptionId = subscriptionId.toString();
    }

    // Добавляем информацию о подарке, если это подарочная подписка
    if (options?.isGift) {
      metadata.isGift = 'true';
      if (options.recipientId) {
        metadata.recipientId = options.recipientId.toString();
      }
      if (options.giftSubscriptionId) {
        metadata.giftSubscriptionId = options.giftSubscriptionId.toString();
      }
    }

    // Проверяем returnUrl - если это просто ссылка на бот, заменяем на системный обработчик return
    let finalReturnUrl = returnUrl;
    if (returnUrl.startsWith('https://t.me/') || returnUrl.includes('telegram.me')) {
      // Заменяем прямую ссылку на бот на правильный обработчик возврата платежа
      finalReturnUrl = config.paymentReturnUrl;
      logger.info(`Заменена прямая ссылка на бот "${returnUrl}" на обработчик возврата платежа: ${finalReturnUrl}`);
    }

    // Создаем платеж в ЮKassa
    const payment = await yooKassa.createPayment({
      amount: {
        value: amount.toFixed(2),
        currency: 'RUB'
      },
      capture: true,
      confirmation: {
        type: 'redirect',
        return_url: finalReturnUrl
      },
      description: description,
      metadata: metadata
    });

    // Записываем платеж в нашу базу данных
    await prisma.payment.create({
      data: {
        id: payment.id,
        userId: user.id,
        subscriptionId: subscriptionId,
        amount: amount,
        currency: 'RUB',
        status: 'PENDING',
        description: description,
        paymentMethod: 'YOOKASSA_WEB',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // Платеж активен 24 часа
        json_data: metadata
      }
    });

    // Если это подарочная подписка, обновляем запись о подарке
    if (options?.isGift && options.giftSubscriptionId) {
      await prisma.giftSubscription.update({
        where: { id: options.giftSubscriptionId },
        data: {
          paymentId: payment.id
        }
      });
    }

    logger.info(`Создан платеж ЮKassa: ${payment.id} для пользователя ${user.id}, URL для возврата: ${finalReturnUrl}`);

    // Возвращаем URL для оплаты
    if (payment.confirmation && payment.confirmation.confirmation_url) {
      return payment.confirmation.confirmation_url;
    } else {
      throw new Error('Не удалось получить URL для оплаты');
    }
  } catch (error) {
    logger.error(`Ошибка при создании платежа: ${error}`);
    throw new Error(`Не удалось создать платеж: ${error}`);
  }
}

// Проверка статуса платежа

// Обработка успешного платежа
async function handleSuccessfulPayment(payment: Payment & { user: User }): Promise<void> {
  try {
    if (!payment.user) {
      logger.error(`Пользователь не найден для платежа ${payment.id}`);
      return;
    }

    logger.info(`Обработка успешного платежа ${payment.id} от пользователя ${payment.userId}`);

    // Получаем метаданные платежа
    let metadata: any = {};

    if (payment.json_data) {
      try {
        metadata = typeof payment.json_data === 'string'
          ? JSON.parse(payment.json_data)
          : payment.json_data;
      } catch (e) {
        logger.error(`Ошибка при разборе метаданных платежа ${payment.id}: ${e}`);
      }
    }

    // Определяем тип платежа
    const isGift = metadata.isGift === 'true';
    const subscriptionId = payment.subscriptionId || (metadata.subscriptionId ? parseInt(metadata.subscriptionId) : undefined);
    const giftSubscriptionId = metadata.giftSubscriptionId ? parseInt(metadata.giftSubscriptionId) : undefined;
    const recipientId = metadata.recipientId ? parseInt(metadata.recipientId) : 0;
    const period = metadata.subscriptionPeriod as SubscriptionPeriod || SubscriptionPeriod.MONTHLY;

    // Обрабатываем платеж в зависимости от его типа
    if (isGift && giftSubscriptionId) {
      // Обработка подарочной подписки
      const yookassaTelegram = await import('./yookassaTelegramPayments');
      await yookassaTelegram.handleGiftPayment(payment.userId, giftSubscriptionId, recipientId, period);
    } else if (subscriptionId) {
      // Продление существующей подписки
      const yookassaTelegram = await import('./yookassaTelegramPayments');
      await yookassaTelegram.handleSubscriptionRenewal(payment.userId, subscriptionId, period);
    } else {
      // Создание новой подписки
      const yookassaTelegram = await import('./yookassaTelegramPayments');
      await yookassaTelegram.handleNewSubscription(payment.userId, period);
    }

    logger.info(`Платеж ${payment.id} успешно обработан`);
  } catch (error) {
    logger.error(`Ошибка при обработке успешного платежа ${payment.id}: ${error}`);
    throw error;
  }
}

// Обработка webhook от ЮKassa
export async function handlePaymentWebhook(event: any): Promise<void> {
  try {
    logger.info(`Получен webhook от ЮKassa: ${event.event}`);

    // Проверяем событие
    if (event.event !== 'payment.succeeded' && event.event !== 'payment.canceled') {
      logger.info(`Пропуск обработки webhook события: ${event.event}`);
      return;
    }

    const paymentObject = event.object;
    const paymentId = paymentObject.id;

    logger.info(`Обработка webhook для платежа ${paymentId}`);

    // Находим платеж в нашей БД
    const payment = await prisma.payment.findFirst({
      where: {
        OR: [
          { id: paymentId },
          { json_data: { path: ['yookassa_payment_id'], equals: paymentId } }
        ]
      },
      include: { user: true }
    });

    if (!payment) {
      logger.warn(`Платеж ${paymentId} не найден в БД при обработке webhook`);
      return;
    }

    // Определяем новый статус
    let newStatus: PaymentStatus;
    if (event.event === 'payment.succeeded') {
      newStatus = PaymentStatus.SUCCEEDED;
    } else if (event.event === 'payment.canceled') {
      newStatus = PaymentStatus.CANCELED;
    } else {
      newStatus = PaymentStatus.PENDING;
    }

    // Обновляем статус в БД
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: newStatus,
        confirmedAt: newStatus === PaymentStatus.SUCCEEDED ? new Date() : undefined
      }
    });

    // Если платеж успешный и ранее не был обработан, обрабатываем его
    if (newStatus === PaymentStatus.SUCCEEDED && payment.status !== PaymentStatus.SUCCEEDED) {
      await handleSuccessfulPayment(payment);
    }

    logger.info(`Webhook обработан: ${event.event} для платежа ${paymentId}`);
  } catch (error) {
    logger.error(`Ошибка при обработке webhook от ЮKassa: ${error}`);
    throw error;
  }
}

// Создание платежа через Telegram
export async function createTelegramDirectPayment(
  bot: any,
  chatId: number,
  user: User,
  period: SubscriptionPeriod,
  options?: {
    subscriptionId?: number;
    isGift?: boolean;
    giftSubscriptionId?: number;
    recipientId?: number;
  }
): Promise<{ success: boolean; error?: string; paymentId?: string }> {
  try {
    logger.info(`Создание платежа через Telegram для пользователя ${user.id}, период: ${period}`);

    // Используем новый унифицированный сервис для создания платежа через Telegram
    const yookassaTelegram = await import('./yookassaTelegramPayments');
    const result = await yookassaTelegram.createYookassaTelegramPayment(
      bot, chatId, user, period, options
    );

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Ошибка при создании платежа через Telegram: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

// Проверка и уведомление о статусе платежа
export async function checkAndNotifyPaymentStatus(
  paymentId: string,
  sendNotification: boolean = true
): Promise<{
  status: PaymentStatus;
  message: string;
}> {
  try {
    // Проверяем статус платежа
    const status = await checkYookassaPaymentStatus(paymentId);

    // Формируем сообщение в зависимости от статуса
    let message = '';

    switch (status) {
      case PaymentStatus.SUCCEEDED:
        message = '✅ Платеж успешно подтвержден! Ваша подписка активирована.';
        break;
      case PaymentStatus.CANCELED:
        message = '❌ Платеж был отменен. Пожалуйста, попробуйте снова или выберите другой способ оплаты.';
        break;
      case PaymentStatus.PENDING:
        message = '⏳ Платеж в обработке. Пожалуйста, подождите, это может занять несколько минут.';
        break;
      default:
        message = '⚠️ Статус платежа неизвестен. Пожалуйста, свяжитесь с поддержкой, если проблема не решится в течение 15 минут.';
    }

    if (sendNotification) {
      const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        include: { user: true }
      });

      if (payment && payment.user) {
        // Отправляем уведомление пользователю
        const bot = require('../bot').default;
        await bot.sendMessage(
          payment.user.telegramId.toString(),
          message
        );
      }
    }

    return { status, message };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Ошибка при проверке и уведомлении о статусе платежа ${paymentId}: ${errorMessage}`);
    return {
      status: PaymentStatus.PENDING,
      message: '⚠️ Произошла ошибка при проверке статуса платежа. Пожалуйста, попробуйте позже.'
    };
  }
}

/**
 * Создание платежа для автопродления подписки
 * @param userId ID пользователя
 * @param subscriptionId ID подписки для продления
 * @param amount Сумма платежа
 * @param description Описание платежа
 * @returns Объект с результатом операции
 */
export async function createAutoRenewalPayment(
    userId: number,
    subscriptionId: number,
    amount: number,
    description: string
): Promise<{ success: boolean; paymentId?: string; error?: string }> {
    try {
        const user = await prisma.user.findUnique({
            where: { id: userId },
        });

        if (!user) {
            return { success: false, error: 'Пользователь не найден' };
        }

        // Создаем платеж в ЮKassa с правильными типами
        const payment = await yooKassa.createPayment({
            amount: {
                value: amount.toFixed(2),
                currency: 'RUB'
            },
            capture: true,
            // Используем правильные опции для конкретной версии SDK
            confirmation: {
                type: 'redirect',
                return_url: config.paymentReturnUrl
            },
            description: description,
            metadata: {
                userId: user.id.toString(),
                subscriptionId: subscriptionId.toString(),
                isAutoRenewal: 'true'
            }
        });

        // Записываем платеж в нашу базу данных
        await prisma.payment.create({
            data: {
                id: payment.id,
                userId: user.id,
                subscriptionId: subscriptionId,
                amount: amount,
                currency: 'RUB',
                status: 'PENDING',
                description: description,
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // Платеж активен 24 часа
            }
        });

        return { success: true, paymentId: payment.id };
    } catch (error: any) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Ошибка при создании автоплатежа: ${errorMessage}`);
        return { success: false, error: errorMessage };
    }
}