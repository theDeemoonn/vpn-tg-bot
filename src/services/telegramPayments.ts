import TelegramBot from 'node-telegram-bot-api';
import { PrismaClient, User, PaymentStatus, Payment } from '@prisma/client';
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
    if (tokenParts.length !== 3) { // Исправлено с < 2 на !== 3
      logger.error(`Неверный формат токена: ${config.telegramPaymentToken}`);
      throw new Error('Неверный формат токена Telegram Payments. Ожидается формат вида 123456789:TEST:123456789');
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
        amount: Math.round(amount * 100) // В копейках
      }
    ];

    // Подготавливаем дополнительные параметры для отправки инвойса
    const invoiceOptions: TelegramBot.SendInvoiceOptions = {
      photo_url: 'https://i.imgur.com/SrUCGfw.jpg', // URL изображения для счета (опционально)
      need_name: false,
      need_phone_number: false,
      need_email: false,
      need_shipping_address: false,
      is_flexible: false,
      disable_notification: false,
      protect_content: false,
      start_parameter: `vpn_payment_${period}`
    };

    // Пробуем отправить инвойс пользователю
    logger.debug(`Отправка инвойса с параметрами: chatId=${chatId}, title=${title}, payload=${payload.substring(0, 30)}..., currency=RUB`);

    // Для уменьшения вложенности обработки ошибок
    await sendTelegramInvoice(
        bot,
        chatId,
        title,
        description,
        payload,
        config.telegramPaymentToken,
        'RUB',
        prices,
        invoiceOptions,
        paymentId
    );

    logger.info(`Инвойс успешно отправлен пользователю ${user.id}`);
    return { success: true };
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.error(`Ошибка при создании инвойса Telegram: ${errorMessage}`, { error: errorStack });
    return { success: false, error: errorMessage };
  }
}

/**
 * Выделенная логика отправки инвойса для улучшения обработки ошибок
 */
async function sendTelegramInvoice(
    bot: TelegramBot,
    chatId: number,
    title: string,
    description: string,
    payload: string,
    providerToken: string,
    currency: string,
    prices: Array<{ label: string; amount: number }>,
    options: TelegramBot.SendInvoiceOptions,
    paymentId: string
): Promise<void> {
  try {
    // Проверяем и приводим к правильному формату цены
    const formattedPrices = prices.map(price => ({
      label: String(price.label),
      amount: Number(price.amount)
    }));

    logger.debug(`Форматированные цены: ${JSON.stringify(formattedPrices)}`);

    try {
      // Сначала пробуем стандартный метод
      await bot.sendInvoice(
          chatId,
          title,
          description,
          payload,
          providerToken,
          currency,
          formattedPrices,
          options
      );

      logger.info(`Инвойс успешно отправлен методом sendInvoice`);
    } catch (standardMethodError: any) {
      logger.warn(`Ошибка при использовании стандартного метода sendInvoice: ${standardMethodError.message}. Пробуем прямой API запрос.`);

      try {
        // Если стандартный метод не сработал, пробуем прямой API запрос
        await sendInvoiceDirectAPI(
            chatId,
            title,
            description,
            payload,
            providerToken,
            currency,
            formattedPrices,
            {
              ...options,
              start_parameter: options.start_parameter || 'payment'
            }
        );

        logger.info(`Инвойс успешно отправлен методом прямого API запроса`);
      } catch (directApiError: any) {
        logger.error(`Ошибка при отправке прямого API запроса: ${directApiError.message}`, {
          error: directApiError.response?.data || directApiError.message
        });

        // Удаляем платеж из БД, так как отправка инвойса не удалась
        await prisma.payment.delete({ where: { id: paymentId } }).catch(e => {
          logger.error(`Не удалось удалить платеж ${paymentId} после ошибки отправки инвойса: ${e}`);
        });

        throw new Error(`Не удалось отправить инвойс ни одним из способов: ${directApiError.message}`);
      }
    }
  } catch (error: any) {
    logger.error(`Ошибка при отправке инвойса: ${error.message}`, {
      error: error
    });
    throw error;
  }
}

/**
 * Обрабатывает успешный платеж в Telegram Payments
 * @param payloadData Распарсенные данные платежа
 * @param amount Сумма платежа в рублях
 * @param telegramPaymentChargeId Идентификатор платежа от провайдера
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

    // Проверяем соответствующий платеж в системе
    // Сначала попытаемся найти платеж по ID если он есть в метаданных
    let payment: Payment | null = null;

    // Ищем соответствующий платеж в системе
    if (!payment) {
      payment = await prisma.payment.findFirst({
        where: {
          userId,
          subscriptionId: subscriptionId || null,
          status: PaymentStatus.PENDING,
          paymentMethod: 'TELEGRAM'
        },
        orderBy: {
          createdAt: 'desc'
        }
      });
    }

    // Если платеж не найден, создаем новый
    if (!payment) {
      logger.warn(`Платеж не найден для пользователя ${userId}, период ${period}. Создаем новую запись.`);

      // Создаем новую запись о платеже
      const paymentId = `tg_${Date.now()}_${userId}`;
      payment = await prisma.payment.create({
        data: {
          id: paymentId,
          userId,
          subscriptionId: subscriptionId || null,
          amount,
          currency: 'RUB',
          status: PaymentStatus.SUCCEEDED,
          description: `Оплата через Telegram (${period})`,
          paymentMethod: telegramPaymentChargeId ? `TELEGRAM:${telegramPaymentChargeId}` : 'TELEGRAM',
          confirmedAt: new Date()
        }
      });

      logger.info(`Создан новый платеж ${payment.id} на основе успешного платежа Telegram`);
    } else {
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
    }

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
      const errorMessage = processingError instanceof Error ? processingError.message : String(processingError);
      const errorStack = processingError instanceof Error ? processingError.stack : undefined;

      logger.error(`Ошибка при обработке подписки: ${errorMessage}`, { error: errorStack });
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
      throw new Error('Не найден отправитель или получатель для подарочной подписки');
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
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Ошибка при отправке уведомлений о подарке: ${errorMessage}`);
      // Продолжаем выполнение, несмотря на ошибку отправки уведомлений
    }

    logger.info(`Успешно обработана подарочная подписка #${giftSubscriptionId}`);
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Ошибка при обработке подарочной подписки: ${errorMessage}`);
    throw error;
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
      throw new Error(`Подписка не найдена: ${subscriptionId}`);
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
        endDate: newEndDate,
        // Сбрасываем флаги напоминаний, так как подписка продлена
        reminderStatus: 'NONE',
        lastReminderSent: null,
        autoRenewalFailed: false
      }
    });

    logger.info(`Подписка ${subscriptionId} продлена до ${newEndDate.toISOString()}`);

    // Отправляем уведомление пользователю
    try {
      const bot = require('../bot').default;
      const user = await prisma.user.findUnique({ where: { id: userId } });

      if (bot && user) {
        await bot.sendMessage(
            user.telegramId.toString(),
            `✅ Ваша подписка успешно продлена до ${newEndDate.toLocaleDateString()}.\n\nИспользуйте команду /subscription для просмотра деталей.`
        );
      }
    } catch (notifyError: any) {
      const errorMessage = notifyError instanceof Error ? notifyError.message : String(notifyError);
      logger.error(`Ошибка при отправке уведомления о продлении подписки: ${errorMessage}`);
      // Продолжаем выполнение, несмотря на ошибку отправки уведомления
    }
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Ошибка при продлении подписки: ${errorMessage}`);
    throw error;
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
    // Импортируем необходимый сервис для создания подписки
    const vpnService = require('../services/vpn');

    // Выбираем оптимальный сервер для пользователя
    const server = await vpnService.selectOptimalServer();

    // Создаем новую подписку с правильной длительностью
    const durationInDays = getSubscriptionDuration(period);
    const startDate = new Date();
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + durationInDays);

    // Создаем подписку
    const subscription = await prisma.subscription.create({
      data: {
        userId,
        vpnServerId: server.id,
        status: 'ACTIVE',
        startDate,
        endDate,
        autoRenewal: false, // По умолчанию автопродление выключено
        downloadSpeed: config.defaultDownloadSpeed,
        uploadSpeed: config.defaultUploadSpeed,
        torrentsAllowed: config.torrentAllowed
      }
    });

    logger.info(`Создана новая подписка ${subscription.id} для пользователя ${userId}`);

    // Генерируем VPN конфигурацию для пользователя
    await vpnService.generateClientConfig(subscription);

    // Увеличиваем счетчик клиентов на сервере
    await prisma.vpnServer.update({
      where: { id: server.id },
      data: {
        currentClients: {
          increment: 1
        }
      }
    });

    // Отправляем уведомление пользователю
    try {
      const bot = require('../bot').default;
      const user = await prisma.user.findUnique({ where: { id: userId } });

      if (bot && user) {
        await bot.sendMessage(
            user.telegramId.toString(),
            `✅ Ваша подписка успешно активирована до ${endDate.toLocaleDateString()}.\n\nИспользуйте команду /subscription для просмотра деталей и получения конфигурации VPN.`
        );
      }
    } catch (notifyError: any) {
      const errorMessage = notifyError instanceof Error ? notifyError.message : String(notifyError);
      logger.error(`Ошибка при отправке уведомления о новой подписке: ${errorMessage}`);
      // Продолжаем выполнение, несмотря на ошибку отправки уведомления
    }
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Ошибка при создании новой подписки: ${errorMessage}`);
    throw error;
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

    // Не логируем полный токен в целях безопасности
    const safeData = {
      ...data,
      provider_token: data.provider_token.substring(0, 10) + '...',
    };
    logger.debug(`Отправка прямого API запроса к Telegram: ${JSON.stringify(safeData)}`);

    const response = await axios.post(apiUrl, data);

    logger.debug(`Ответ API Telegram: ${JSON.stringify(response.data)}`);

    return response.data;
  } catch (error: any) {
    const errorResponse = error.response?.data || 'Нет данных ответа';

    logger.error(`Ошибка при отправке прямого API запроса к Telegram: ${error.message}`, {
      error: errorResponse
    });

    throw error;
  }
}