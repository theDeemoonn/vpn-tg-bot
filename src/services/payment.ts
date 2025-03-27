import YooKassa from 'yookassa';
import { Payment, PaymentStatus, User } from '@prisma/client';
import { prisma } from './database';
import config from '../config';
import logger from '../utils/logger';

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

// Функция получения описания подписки
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

// Создание ссылки на оплату
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
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // Платеж активен 24 часа
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

// Обработка webhook от ЮKassa

// Вспомогательная функция для создания новой подписки из webhook
async function handleNewSubscriptionFromWebhook(userId: number, periodString: string): Promise<number | null> {
  try {
    // Преобразуем строку периода в enum
    let period: SubscriptionPeriod;
    switch (periodString.toLowerCase()) {
      case 'monthly':
        period = SubscriptionPeriod.MONTHLY;
        break;
      case 'quarterly':
        period = SubscriptionPeriod.QUARTERLY;
        break;
      case 'annual':
        period = SubscriptionPeriod.ANNUAL;
        break;
      default:
        period = SubscriptionPeriod.MONTHLY;
    }
    
    // Находим доступный VPN сервер
    const server = await prisma.vpnServer.findFirst({
      where: {
        isActive: true,
        currentClients: { lt: prisma.vpnServer.fields.maxClients }
      },
      orderBy: {
        currentClients: 'asc'
      }
    });
    
    if (!server) {
      logger.error(`Не найден доступный VPN сервер для создания подписки пользователя ${userId}`);
      return null;
    }
    
    // Создаем новую подписку
    const durationInDays = getSubscriptionDuration(period);
    const startDate = new Date();
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + durationInDays);
    
    const subscription = await prisma.subscription.create({
      data: {
        userId: userId,
        vpnServerId: server.id,
        status: 'ACTIVE',
        startDate,
        endDate,
        downloadSpeed: config.defaultDownloadSpeed,
        uploadSpeed: config.defaultUploadSpeed,
        torrentsAllowed: config.torrentAllowed
      }
    });
    
    // Увеличиваем счетчик клиентов на сервере
    await prisma.vpnServer.update({
      where: { id: server.id },
      data: {
        currentClients: { increment: 1 }
      }
    });
    
    logger.info(`Создана новая подписка для пользователя ${userId}: ${JSON.stringify(subscription)}`);
    
    // Отправляем уведомление пользователю
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (user) {
        const bot = require('../bot').default;
        await bot.sendMessage(
          user.telegramId.toString(),
          `✅ Оплата успешно получена!\n\nВаша подписка активирована до ${endDate.toLocaleDateString()}.\n\nИспользуйте команду /profile для просмотра деталей подписки.`
        );
      }
    } catch (notifyError) {
      logger.error(`Ошибка при отправке уведомления пользователю ${userId}: ${notifyError}`);
    }
    
    return subscription.id;
  } catch (error) {
    logger.error(`Ошибка при создании подписки из webhook: ${error}`);
    return null;
  }
}

// Обработка успешного платежа
async function handleSuccessfulPayment(payment: Payment & { user: User }): Promise<void> {
  try {
    // Получаем метаданные платежа из БД
    let isGift = false;
    let giftSubscriptionId: number | undefined;
    let recipientId: number | undefined;
    
    // Проверяем наличие записи о подарочной подписке
    const giftSubscription = await prisma.giftSubscription.findFirst({
      where: { paymentId: payment.id }
    });
    
    if (giftSubscription) {
      // Это подарочная подписка
      isGift = true;
      giftSubscriptionId = giftSubscription.id;
      recipientId = giftSubscription.recipientId;
    }
    
    if (isGift && giftSubscriptionId && recipientId) {
      // Создаем метаданные для подарочной подписки
      const metadata = {
        isGift: 'true',
        giftSubscriptionId: giftSubscriptionId.toString(),
        recipientId: recipientId.toString()
      };
      
      // Обрабатываем подарочную подписку
      await handleSuccessfulGiftPayment(payment, metadata);
      logger.info(`Успешно обработан подарочный платеж #${payment.id}`);
    } else if (payment.subscriptionId) {
      // Продлеваем существующую подписку
      await handleSubscriptionRenewal(payment);
      logger.info(`Успешно обработано продление подписки #${payment.subscriptionId}`);
    } else {
      // Создаем новую подписку
      const subscriptionId = await handleNewSubscription(payment);
      logger.info(`Создана новая подписка #${subscriptionId} для платежа #${payment.id}`);
    }
    
    // Отправляем уведомление пользователю в Telegram о успешном платеже
    try {
      if (payment.user && payment.user.telegramId) {
        const bot = require('../bot').default;
        
        if (bot) {
          await bot.sendMessage(
            payment.user.telegramId.toString(),
            `✅ *Оплата успешно получена!*\n\nВаша подписка VPN активирована.\n\nИспользуйте команду /subscription для просмотра деталей и получения конфигурации.`,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '📋 Моя подписка', callback_data: 'my_subscription' }]
                ]
              }
            }
          );
          logger.info(`Уведомление об успешной оплате отправлено пользователю ${payment.user.telegramId}`);
        }
      }
    } catch (notifyError) {
      logger.error(`Ошибка при отправке уведомления пользователю: ${notifyError}`);
    }
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.error(`Ошибка при обработке успешного платежа: ${errorMessage}`, { error: errorStack });
    throw error;
  }
}

// Обработка успешного платежа за подарочную подписку
async function handleSuccessfulGiftPayment(
  payment: Payment & { user: User },
  metadata: any
): Promise<void> {
  try {
    const giftSubscriptionId = metadata.giftSubscriptionId ? parseInt(metadata.giftSubscriptionId, 10) : null;
    const recipientId = metadata.recipientId ? parseInt(metadata.recipientId, 10) : null;
    
    if (!giftSubscriptionId || !recipientId) {
      logger.error(`Недостаточно данных для обработки подарочной подписки: ${payment.id}`);
      return;
    }
    
    // Обновляем статус подарочной подписки
    await prisma.giftSubscription.update({
      where: { id: giftSubscriptionId },
      data: {
        status: 'PAID',
        paymentId: payment.id
      }
    });
    
    // Находим получателя и отправителя
    const giftSubscription = await prisma.giftSubscription.findUnique({
      where: { id: giftSubscriptionId }
    });
    
    if (!giftSubscription) {
      logger.error(`Не найдена запись о подарочной подписке: ${giftSubscriptionId}`);
      return;
    }
    
    const sender = await prisma.user.findUnique({
      where: { id: giftSubscription.senderId }
    });
    
    const recipient = await prisma.user.findUnique({
      where: { id: giftSubscription.recipientId }
    });
    
    if (!sender || !recipient) {
      logger.error(`Не найден отправитель или получатель для подарочной подписки: ${giftSubscriptionId}`);
      return;
    }
    
    // Отправляем уведомление отправителю
    try {
      const bot = require('../bot').default;
      
      if (bot) {
        const periodName = giftSubscription.period === SubscriptionPeriod.MONTHLY
          ? 'Месячная'
          : giftSubscription.period === SubscriptionPeriod.QUARTERLY
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
      logger.error(`Ошибка при отправке уведомлений о подарке: ${error}`);
    }
    
    logger.info(`Успешно обработана подарочная подписка #${giftSubscriptionId}`);
  } catch (error) {
    logger.error(`Ошибка при обработке успешного платежа за подарок: ${error}`);
    throw error;
  }
}

// Проверка статуса платежа
export async function checkPaymentStatus(paymentId: string): Promise<PaymentStatus> {
  try {
    // Проверяем, является ли это платежом Telegram (начинается с "tg_")
    if (paymentId.startsWith('tg_')) {
      logger.info(`Обнаружен ID платежа Telegram: ${paymentId}. Пропускаем проверку через ЮKassa.`);
      
      // Получаем текущий статус из базы данных
      const payment = await prisma.payment.findUnique({
        where: { id: paymentId }
      });
      
      if (!payment) {
        throw new Error(`Платеж не найден в базе данных: ${paymentId}`);
      }
      
      logger.info(`Возвращаем текущий статус платежа Telegram ${paymentId}: ${payment.status}`);
      return payment.status;
    }
    
    // Для платежей ЮKassa выполняем запрос к API
    logger.debug(`Запрашиваю информацию о платеже ЮKassa ${paymentId}`);
    
    // Используем axios для прямого запроса к API ЮKassa
    const axios = require('axios');
    
    // Формируем базовую авторизацию
    const auth = Buffer.from(`${config.yookassaShopId}:${config.yookassaSecretKey}`).toString('base64');
    
    // Выполняем GET-запрос к API ЮKassa с таймаутом в 5 секунд для быстрого ответа
    const response = await axios.get(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      timeout: 5000
    });
    
    // Получаем данные платежа из ответа
    const paymentInfo = response.data;
    logger.debug(`Получена информация о платеже ${paymentId}: Статус ${paymentInfo.status}`);
    
    // Маппинг статусов платежа YooKassa на наши внутренние статусы
    let paymentStatus: PaymentStatus;
    switch (paymentInfo.status) {
      case 'waiting_for_capture':
      case 'pending':
        paymentStatus = PaymentStatus.PENDING;
        break;
      case 'succeeded':
        paymentStatus = PaymentStatus.SUCCEEDED;
        break;
      case 'canceled':
        paymentStatus = PaymentStatus.CANCELED;
        break;
      default:
        paymentStatus = PaymentStatus.FAILED;
    }

    // Получаем текущий статус платежа в нашей БД
    const existingPayment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { user: true }
    });

    // Если статус изменился на SUCCEEDED, выполняем обработку успешного платежа
    if (existingPayment && paymentStatus === PaymentStatus.SUCCEEDED && existingPayment.status !== PaymentStatus.SUCCEEDED) {
      logger.info(`Обнаружено изменение статуса платежа ${paymentId} на SUCCEEDED. Обрабатываем успешный платеж.`);
      
      // Обновляем статус в БД
      await prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: paymentStatus,
          confirmedAt: new Date()
        }
      });
      
      // Обрабатываем успешный платеж
      try {
        await handleSuccessfulPayment(existingPayment);
        logger.info(`Платеж ${paymentId} успешно обработан после проверки статуса`);
      } catch (processingError) {
        logger.error(`Ошибка при обработке успешного платежа ${paymentId}: ${processingError}`);
      }
    } else {
      // Просто обновляем статус, если он изменился
      if (existingPayment && existingPayment.status !== paymentStatus) {
        await prisma.payment.update({
          where: { id: paymentId },
          data: {
            status: paymentStatus,
            confirmedAt: paymentStatus === PaymentStatus.SUCCEEDED ? new Date() : existingPayment.confirmedAt
          }
        });
        logger.info(`Статус платежа ${paymentId} обновлен на ${paymentStatus}`);
      }
    }

    return paymentStatus;
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Ошибка при проверке статуса платежа ${paymentId}: ${errorMessage}`, { error });
    
    // Проверяем, существует ли платеж в нашей БД
    const existingPayment = await prisma.payment.findUnique({
      where: { id: paymentId }
    });
    
    // Если платеж существует, возвращаем его текущий статус
    if (existingPayment) {
      return existingPayment.status;
    }
    
    throw new Error(`Не удалось проверить статус платежа: ${errorMessage}`);
  }
}

// Создание платежа для автопродления подписки
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

// Обработка продления подписки
async function handleSubscriptionRenewal(payment: Payment & { user?: User }): Promise<void> {
  try {
    if (!payment.subscriptionId) {
      logger.error(`Платеж #${payment.id} не связан с подпиской`);
      return;
    }

    const subscription = await prisma.subscription.findUnique({
      where: { id: payment.subscriptionId }
    });

    if (!subscription) {
      logger.error(`Не найдена подписка #${payment.subscriptionId} для продления`);
      return;
    }

    // Определяем период подписки из метаданных или описания
    const period = payment.description?.includes('Месячная')
      ? SubscriptionPeriod.MONTHLY
      : payment.description?.includes('Квартальная')
      ? SubscriptionPeriod.QUARTERLY
      : payment.description?.includes('Годовая')
      ? SubscriptionPeriod.ANNUAL
      : SubscriptionPeriod.MONTHLY;

    const durationInDays = getSubscriptionDuration(period);
    
    // Рассчитываем новую дату окончания
    let newEndDate: Date;
    if (subscription.status === 'EXPIRED' || new Date(subscription.endDate) < new Date()) {
      // Если подписка истекла, считаем от текущей даты
      newEndDate = new Date();
      newEndDate.setDate(newEndDate.getDate() + durationInDays);
    } else {
      // Если подписка активна, продлеваем от даты окончания
      newEndDate = new Date(subscription.endDate);
      newEndDate.setDate(newEndDate.getDate() + durationInDays);
    }

    // Обновляем подписку
    await prisma.subscription.update({
      where: { id: payment.subscriptionId },
      data: {
        status: 'ACTIVE',
        endDate: newEndDate,
        autoRenewalFailed: false, // сбрасываем флаг неудачного автопродления, если был
      }
    });

    logger.info(`Подписка #${subscription.id} продлена до ${newEndDate.toISOString()}`);

    // Отправляем уведомление пользователю, если есть информация о пользователе
    try {
      if (!payment.user) {
        const user = await prisma.user.findUnique({
          where: { id: payment.userId }
        });
        
        if (user) {
          const bot = require('../bot').default;
          await bot.sendMessage(
            user.telegramId.toString(),
            `✅ Оплата успешно получена!\n\nВаша подписка продлена до ${newEndDate.toLocaleDateString()}.`
          );
        }
      } else {
        const bot = require('../bot').default;
        await bot.sendMessage(
          payment.user.telegramId.toString(),
          `✅ Оплата успешно получена!\n\nВаша подписка продлена до ${newEndDate.toLocaleDateString()}.`
        );
      }
    } catch (notifyError) {
      logger.error(`Ошибка при отправке уведомления пользователю о продлении подписки: ${notifyError}`);
    }
  } catch (error) {
    logger.error(`Ошибка при продлении подписки: ${error}`);
    throw error;
  }
}

// Создание новой подписки
async function handleNewSubscription(payment: Payment & { user: User | null }): Promise<number> {
  try {
    // Определяем период подписки из описания
    const period = payment.description?.includes('Месячная')
      ? SubscriptionPeriod.MONTHLY
      : payment.description?.includes('Квартальная')
      ? SubscriptionPeriod.QUARTERLY
      : payment.description?.includes('Годовая')
      ? SubscriptionPeriod.ANNUAL
      : SubscriptionPeriod.MONTHLY;
    
    // Находим доступный VPN сервер
    const server = await prisma.vpnServer.findFirst({
      where: {
        isActive: true,
        currentClients: { lt: prisma.vpnServer.fields.maxClients }
      },
      orderBy: {
        currentClients: 'asc'
      }
    });
    
    if (!server) {
      logger.error(`Не найден доступный VPN сервер для создания подписки пользователя ${payment.userId}`);
      throw new Error('Не найден доступный VPN сервер');
    }
    
    // Создаем новую подписку
    const durationInDays = getSubscriptionDuration(period);
    const startDate = new Date();
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + durationInDays);
    
    const subscription = await prisma.subscription.create({
      data: {
        userId: payment.userId,
        vpnServerId: server.id,
        status: 'ACTIVE',
        startDate,
        endDate,
        downloadSpeed: config.defaultDownloadSpeed,
        uploadSpeed: config.defaultUploadSpeed,
        torrentsAllowed: config.torrentAllowed
      }
    });
    
    // Обновляем платеж, связывая его с созданной подпиской
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        subscriptionId: subscription.id
      }
    });
    
    // Увеличиваем счетчик клиентов на сервере
    await prisma.vpnServer.update({
      where: { id: server.id },
      data: {
        currentClients: { increment: 1 }
      }
    });
    
    logger.info(`Создана новая подписка для пользователя ${payment.userId}: ${JSON.stringify(subscription)}`);

    // Отправляем уведомление пользователю
    try {
      let user = payment.user;
      if (!user) {
        user = await prisma.user.findUnique({
          where: { id: payment.userId }
        });
      }

      if (user) {
        const bot = require('../bot').default;
        await bot.sendMessage(
            user.telegramId.toString(),
            `✅ Оплата успешно получена!\n\nВаша подписка активирована до ${endDate.toLocaleDateString()}.\n\nИспользуйте команду /profile для просмотра деталей подписки.`
        );
      } else {
        logger.error('User not found');
      }
    } catch (error) {
      logger.error(`Ошибка при отправке уведомления: ${error}`);
    }

    return subscription.id;
  } catch (error) {
    logger.error(`Ошибка при создании новой подписки: ${error}`);
    throw error;
  }
}

export async function handlePaymentWebhook(event: any): Promise<void> {
  try {
    logger.info(`Обработка webhook от ЮKassa`);

    // Логируем весь объект события для диагностики
    logger.debug(`Данные webhook: ${JSON.stringify(event)}`);

    // Проверяем тип события
    if (event.event !== 'payment.succeeded' && event.event !== 'payment.waiting_for_capture') {
      logger.info(`Пропускаем обработку события типа: ${event.event}`);
      return;
    }

    // Проверка структуры данных
    if (!event || !event.object) {
      logger.error(`Неверный формат данных webhook: ${JSON.stringify(event)}`);
      throw new Error('Неверный формат данных webhook: отсутствует объект платежа');
    }

    // Получаем объект платежа
    const paymentObject = event.object;
    const paymentId = paymentObject.id;

    logger.info(`Обработка платежа: ${paymentId}, статус: ${paymentObject.status}`);

    // Проверяем, что платеж существует в нашей базе данных
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { user: true }
    });

    if (!payment) {
      logger.warn(`Платеж не найден в базе: ${paymentId}. Пробуем создать новый.`);

      // Проверяем метаданные для создания платежа
      if (paymentObject.metadata && paymentObject.metadata.userId) {
        return await handleNewPaymentFromWebhook(paymentId, paymentObject);
      } else {
        logger.error(`Недостаточно данных для создания платежа: ${JSON.stringify(paymentObject.metadata)}`);
        return;
      }
    }

    // Определяем новый статус платежа
    let newStatus: PaymentStatus;
    
    switch (paymentObject.status) {
      case 'waiting_for_capture': // Платеж авторизован, требуется подтверждение
      case 'pending': // Платеж в обработке
        newStatus = PaymentStatus.PENDING;
        break;
      case 'succeeded': // Платеж успешно завершен
        newStatus = PaymentStatus.SUCCEEDED;
        break;
      case 'canceled': // Платеж отменен
        newStatus = PaymentStatus.CANCELED;
        break;
      default:
        newStatus = PaymentStatus.PENDING;
    }

    // Обновляем статус платежа в базе данных
    await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: newStatus,
        confirmedAt: newStatus === PaymentStatus.SUCCEEDED ? new Date() : payment.confirmedAt
      }
    });

    logger.info(`Статус платежа ${paymentId} обновлен на ${newStatus}`);

    // Если платеж успешный, обрабатываем в зависимости от метода платежа
    if (newStatus === PaymentStatus.SUCCEEDED) {
      // Проверяем метод платежа
      if (payment.paymentMethod === 'YOOKASSA_TELEGRAM') {
        // Импортируем обработчик YooKassa Telegram платежей
        const { handleSuccessfulYookassaTelegramPayment } = require('./yookassaTelegramPayments');
        
        // Вызываем специализированный обработчик для YooKassa в Telegram
        await handleSuccessfulYookassaTelegramPayment(paymentObject);
        logger.info(`Платеж YooKassa Telegram ${paymentId} успешно обработан`);
      } else {
        // Стандартная обработка платежа
        await handleSuccessfulPayment(payment);
        logger.info(`Платеж ${paymentId} успешно обработан`);
      }
    }
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.error(`Ошибка при обработке webhook: ${errorMessage}`, { error: errorStack });
    throw error;
  }
}

// Вспомогательная функция для создания платежа из вебхука
async function handleNewPaymentFromWebhook(paymentId: string, paymentObject: any) {
  try {
    // Находим пользователя
    const userId = parseInt(paymentObject.metadata.userId);
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      logger.error(`Не найден пользователь для создания платежа: ${userId}`);
      return;
    }

    // Создаем платеж в нашей базе
    const newPayment = await prisma.payment.create({
      data: {
        id: paymentId,
        userId: userId,
        amount: parseFloat(paymentObject.amount.value),
        currency: paymentObject.amount.currency,
        status: 'SUCCEEDED',
        confirmedAt: new Date(),
        description: `Платеж создан по webhook (${paymentObject.metadata.subscriptionPeriod || 'unknown'})`
      }
    });

    logger.info(`Создан новый платеж на основе webhook: ${JSON.stringify(newPayment)}`);

    // Создаем подписку для пользователя, если указан период
    if (paymentObject.metadata.subscriptionPeriod) {
      await handleNewSubscriptionFromWebhook(userId, paymentObject.metadata.subscriptionPeriod);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Ошибка при создании платежа из webhook: ${errorMessage}`);
    throw error;
  }
}

/**
 * Проверка статуса платежа у ЮKassa и отправка уведомления пользователю
 * Добавлена для ручной проверки статуса платежа
 */
export async function checkAndNotifyPaymentStatus(
  paymentId: string,
  sendNotification: boolean = true
): Promise<{
  status: PaymentStatus;
  message: string;
}> {
  try {
    // Получаем текущий статус платежа
    const status = await checkPaymentStatus(paymentId);

    // Находим платеж в базе данных с пользователем
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { user: true }
    });

    if (!payment) {
      throw new Error(`Платеж ${paymentId} не найден в базе данных`);
    }

    // Подготавливаем сообщение в зависимости от статуса
    let message: string;
    let markup: any = undefined;

    switch (status) {
      case PaymentStatus.SUCCEEDED:
        message = `✅ *Платеж успешно завершен!*\n\nВаша подписка VPN активирована.\n\nИспользуйте команду /subscription для просмотра деталей и получения конфигурации.`;
        markup = {
          inline_keyboard: [
            [{ text: '📋 Моя подписка', callback_data: 'my_subscription' }]
          ]
        };
        break;
      case PaymentStatus.PENDING:
        message = `⏱ *Платеж в обработке*\n\nВаш платеж ещё обрабатывается. Это может занять несколько минут.\n\nID платежа: \`${paymentId}\``;
        markup = {
          inline_keyboard: [
            [{ text: '🔄 Проверить снова', callback_data: `check_payment_${paymentId}` }]
          ]
        };
        break;
      case PaymentStatus.CANCELED:
        message = `❌ *Платеж отменен*\n\nВаш платеж был отменен. Пожалуйста, попробуйте снова или выберите другой способ оплаты.`;
        markup = {
          inline_keyboard: [
            [{ text: '💳 Выбрать тариф', callback_data: 'buy' }]
          ]
        };
        break;
      default:
        message = `❌ *Платеж не удался*\n\nК сожалению, возникла проблема с вашим платежом. Пожалуйста, попробуйте снова или выберите другой способ оплаты.`;
        markup = {
          inline_keyboard: [
            [{ text: '💳 Выбрать тариф', callback_data: 'buy' }]
          ]
        };
    }

    // Отправляем уведомление пользователю, если нужно
    if (sendNotification && payment.user && payment.user.telegramId) {
      try {
        const bot = require('../bot').default;
        
        if (bot) {
          await bot.sendMessage(
            payment.user.telegramId.toString(),
            message,
            {
              parse_mode: 'Markdown',
              reply_markup: markup ? { inline_keyboard: markup.inline_keyboard } : undefined
            }
          );
          
          logger.info(`Отправлено уведомление о статусе платежа ${paymentId} пользователю ${payment.user.telegramId}`);
        }
      } catch (error) {
        logger.error(`Ошибка при отправке уведомления о статусе платежа: ${error}`);
      }
    }

    return { status, message };
  } catch (error) {
    logger.error(`Ошибка при проверке и уведомлении о статусе платежа ${paymentId}: ${error}`);
    throw error;
  }
}

/**
 * Создание прямого платежа через Telegram API
 * Используется для создания платежа через стандартный API Telegram
 */
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
    logger.info(`Создание прямого платежа через Telegram API для пользователя ${user.id} (${user.telegramId}), период: ${period}`);
    
    // Проверяем наличие токена для платежей
    if (!config.telegramPaymentToken || config.telegramPaymentToken.trim() === '') {
      throw new Error('Отсутствует токен для Telegram Payments');
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
    
    // Создаем метаданные платежа
    const metadata: any = {
      userId: user.id.toString(),
      telegramId: user.telegramId.toString(),
      subscriptionPeriod: period
    };
    
    if (options?.subscriptionId) {
      metadata.subscriptionId = options.subscriptionId.toString();
    }
    
    if (isGift) {
      metadata.isGift = 'true';
      if (options?.recipientId) {
        metadata.recipientId = options.recipientId.toString();
      }
      if (options?.giftSubscriptionId) {
        metadata.giftSubscriptionId = options.giftSubscriptionId.toString();
      }
    }
    
    // Генерируем уникальный ID платежа
    const paymentId = `tg_direct_${Date.now()}_${user.id}`;
    
    // Создаем запись о платеже в БД
    await prisma.payment.create({
      data: {
        id: paymentId,
        userId: user.id,
        subscriptionId: options?.subscriptionId,
        amount: amount,
        currency: 'RUB',
        status: PaymentStatus.PENDING,
        description: description,
        paymentMethod: 'TELEGRAM_DIRECT',
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
    
    // Формируем массив цен
    const prices = [
      {
        label: title,
        amount: Math.round(amount * 100) // В копейках для Telegram API
      }
    ];
    
    // Показываем, что бот печатает
    await bot.sendChatAction(chatId, 'typing');
    
    // Параметры для инвойса
    const invoiceOptions = {
      need_name: false,
      need_phone_number: false,
      need_email: false,
      need_shipping_address: false,
      is_flexible: false,
      disable_notification: false,
      protect_content: false,
      photo_url: 'https://i.imgur.com/YRBvM9x.png', // Изображение для инвойса
      photo_width: 600,
      photo_height: 300,
      start_parameter: `vpn_payment_${period}`
    };
    
    // Генерируем payload для платежа
    const payload = JSON.stringify(metadata);
    
    // Отправляем инвойс через API бота
    const sentInvoice = await bot.sendInvoice(
      chatId,
      title,
      description,
      payload,
      config.telegramPaymentToken,
      'RUB',
      prices,
      invoiceOptions
    );
    
    logger.info(`Отправлен инвойс для прямого платежа ${paymentId} пользователю ${user.telegramId}, message_id: ${sentInvoice.message_id}`);
    
    // Отправляем дополнительное информационное сообщение
    setTimeout(async () => {
      try {
        await bot.sendMessage(
          chatId,
          `ℹ️ *Информация об оплате*\n\nДля совершения платежа нажмите кнопку оплаты выше ⬆️\n\nПосле успешной оплаты ваша подписка будет активирована автоматически.\n\nID платежа: \`${paymentId}\``,
          { 
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 Проверить статус платежа', callback_data: `check_payment_${paymentId}` }]
              ]
            }
          }
        );
      } catch (error) {
        logger.error(`Не удалось отправить дополнительное сообщение для платежа ${paymentId}: ${error}`);
      }
    }, 1500);
    
    return { success: true, paymentId };
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Ошибка при создании прямого платежа через Telegram: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}