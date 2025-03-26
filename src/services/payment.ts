import YooKassa from 'yookassa';
import { Payment, PaymentStatus, User } from '@prisma/client';
import { prisma } from './database';
import config from '../config';
import logger from '../utils/logger';

// Инициализация ЮKassa с вашими данными
const yooKassa = new YooKassa({
  shopId: config.yookassaShopId,
  secretKey: config.yookassaSecretKey
});

// Перечисление доступных подписок
export enum SubscriptionPeriod {
  MONTHLY = 'monthly',
  QUARTERLY = 'quarterly',
  ANNUAL = 'annual'
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

// Получение описания подписки
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

    // Создаем платеж в ЮKassa
    const payment = await yooKassa.createPayment({
      amount: {
        value: amount.toFixed(2),
        currency: 'RUB'
      },
      capture: true,
      confirmation: {
        type: 'redirect',
        return_url: returnUrl
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
export async function handlePaymentWebhook(event: any): Promise<void> {
  try {
    logger.info(`Получен webhook от ЮKassa: ${JSON.stringify(event)}`);
    
    // Проверка структуры данных
    if (!event || (!event.object && !event.payment)) {
      logger.error(`Неверный формат данных webhook: ${JSON.stringify(event)}`);
      throw new Error('Неверный формат данных webhook');
    }
    
    // Получаем объект платежа (ЮKassa может отправлять данные в разных форматах)
    const paymentObject = event.object || event.payment;
    if (!paymentObject) {
      logger.error(`Не найден объект платежа в данных webhook: ${JSON.stringify(event)}`);
      throw new Error('Не найден объект платежа в данных webhook');
    }
    
    const paymentId = paymentObject.id;
    logger.info(`Получен webhook для платежа: ${paymentId}`);
    
    // Проверяем, что платеж существует в нашей базе данных
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { user: true }
    });

    if (!payment) {
      logger.warn(`Получен webhook для неизвестного платежа: ${paymentId}. Дополнительная информация: ${JSON.stringify(paymentObject)}`);
      
      // Проверим, есть ли метаданные для создания платежа
      if (paymentObject.metadata && paymentObject.metadata.userId) {
        logger.info(`Пробуем создать платеж на основе метаданных: ${JSON.stringify(paymentObject.metadata)}`);
        
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
          
          return;
        } catch (createError) {
          logger.error(`Ошибка при создании платежа из webhook: ${createError}`);
          return;
        }
      }
      
      return;
    }

    // Обновляем статус платежа в нашей базе данных
    let paymentStatus: PaymentStatus;
    let confirmedAt: Date | null = null;

    switch (paymentObject.status) {
      case 'waiting_for_capture':
        paymentStatus = 'WAITING_FOR_CAPTURE';
        break;
      case 'succeeded':
        paymentStatus = 'SUCCEEDED';
        confirmedAt = new Date();
        break;
      case 'canceled':
        paymentStatus = 'CANCELED';
        break;
      default:
        paymentStatus = 'FAILED';
    }

    logger.info(`Обновляем статус платежа ${paymentId} на ${paymentStatus}`);
    await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: paymentStatus,
        confirmedAt
      }
    });

    // Если платеж успешен, обновляем подписку или обрабатываем подарок
    if (paymentStatus === 'SUCCEEDED') {
      // Проверяем, является ли это оплатой подарочной подписки
      const isGift = paymentObject.metadata && paymentObject.metadata.isGift === 'true';
      
      if (isGift) {
        // Обрабатываем успешную оплату подарка
        await handleSuccessfulGiftPayment(payment, paymentObject.metadata);
        logger.info(`Успешно обработан подарочный платеж #${paymentId}`);
      } else if (payment.subscriptionId) {
        // Обрабатываем продление подписки
        await handleSubscriptionRenewal(payment);
        logger.info(`Успешно обработано продление подписки #${payment.subscriptionId}`);
      } else {
        // Обрабатываем обычный платеж для новой подписки
        const subscriptionId = await handleNewSubscription(payment);
        logger.info(`Создана новая подписка #${subscriptionId} для платежа #${paymentId}`);
      }
    }
  } catch (error) {
    logger.error(`Ошибка при обработке webhook: ${error}`, { 
      stack: error instanceof Error ? error.stack : undefined 
    });
    throw error;
  }
}

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
    // Если у платежа есть связанная подписка, продлеваем её
    if (payment.subscriptionId) {
      await handleSubscriptionRenewal(payment);
    } else {
      // Создаем новую подписку
      await handleNewSubscription(payment);
    }
  } catch (error) {
    logger.error(`Ошибка при обработке успешного платежа: ${error}`);
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
    // Получаем информацию о платеже, совместимую с используемой версией API YooKassa
    const paymentInfo = await yooKassa.getPaymentInfo(paymentId);
    
    if (!paymentInfo) {
      logger.error(`Не удалось получить информацию о платеже ${paymentId}`);
      throw new Error(`Не удалось получить информацию о платеже ${paymentId}`);
    }
    
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

    // Обновляем статус в нашей БД
    await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: paymentStatus,
        confirmedAt: paymentStatus === PaymentStatus.SUCCEEDED ? new Date() : null
      }
    });

    logger.info(`Статус платежа ${paymentId} обновлен на ${paymentStatus}`);
    return paymentStatus;
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Ошибка при проверке статуса платежа ${paymentId}: ${errorMessage}`, { error });
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
async function handleNewSubscription(payment: Payment & { user?: User }): Promise<number> {
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
      }
    } catch (notifyError) {
      logger.error(`Ошибка при отправке уведомления пользователю о создании подписки: ${notifyError}`);
    }
    
    return subscription.id;
  } catch (error) {
    logger.error(`Ошибка при создании новой подписки: ${error}`);
    throw error;
  }
} 