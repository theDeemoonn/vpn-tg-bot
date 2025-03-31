import TelegramBot from 'node-telegram-bot-api';
import YooKassa from 'yookassa';
import { User, PaymentStatus } from '@prisma/client';
import { prisma } from './database';
import config from '../config';
import { logger } from '../utils/logger';
import { SubscriptionPeriod, getPaymentAmount, getSubscriptionDuration } from './payment';
import axios from 'axios';

// Инициализация ЮKassa с данными магазина
const yooKassa = new YooKassa({
  shopId: config.yookassaShopId,
  secretKey: config.yookassaSecretKey
});

/**
 * Обрабатывает создание новой подписки
 */
export async function handleNewSubscription(
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
 * Предлагает альтернативный способ оплаты, если платеж через Telegram недоступен
 */
async function offerAlternativePayment(
    bot: TelegramBot,
    chatId: number,
    user: User,
    period: SubscriptionPeriod,
    options?: {
      subscriptionId?: number;
      isGift?: boolean;
      giftSubscriptionId?: number;
      recipientId?: number;
    },
    paymentId?: string
): Promise<void> {
  try {
    // Удаляем устаревший платеж, если он существует
    if (paymentId) {
      await prisma.payment.delete({
        where: { id: paymentId }
      }).catch(e => {
        logger.warn(`Не удалось удалить платеж ${paymentId}: ${e}`);
      });
    }

    // Создаем альтернативное сообщение для пользователя
    await bot.sendMessage(
        chatId,
        `❌ *Оплата через Telegram недоступна*\n\nК сожалению, в данный момент оплата через Telegram не работает. Пожалуйста, используйте оплату банковской картой.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '💳 Оплатить картой', callback_data: `pay_card_${period}${options?.subscriptionId ? '_' + options.subscriptionId : ''}` }],
              [{ text: '🔙 Назад к тарифам', callback_data: 'buy' }]
            ]
          }
        }
    );
  } catch (error) {
    logger.error(`Ошибка при предложении альтернативного способа оплаты: ${error}`);
  }
}

export async function createYookassaTelegramPayment(
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
    // Проверяем наличие токена для ЮKassa Payments в Telegram
    if (!config.telegramPaymentToken || config.telegramPaymentToken.trim() === '') {
      throw new Error('Отсутствует токен для ЮKassa Payments в Telegram');
    }

    // Проверка токена менее строгая - он может иметь разные форматы
    // Токен должен быть просто непустой строкой
    const token = config.telegramPaymentToken.trim();
    logger.debug(`Используемый токен для платежей: ${token.substring(0, 4)}...${token.substring(token.length - 4)}`);

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

    // Добавляем ID подписки, если указан
    if (options?.subscriptionId) {
      metadata.subscriptionId = options.subscriptionId.toString();
    }

    // Добавляем информацию о подарке, если это подарочная подписка
    if (isGift) {
      metadata.isGift = 'true';
      if (options?.recipientId) {
        metadata.recipientId = options.recipientId.toString();
      }
      if (options?.giftSubscriptionId) {
        metadata.giftSubscriptionId = options.giftSubscriptionId.toString();
      }
    }

    // Генерируем уникальный payload для платежа
    const payload = JSON.stringify(metadata);

    // Создаем запись о платеже в БД
    const paymentId = `tg_${Date.now()}_${user.id}`;
    await prisma.payment.create({
      data: {
        id: paymentId,
        userId: user.id,
        subscriptionId: options?.subscriptionId,
        amount: amount,
        currency: 'RUB',
        status: PaymentStatus.PENDING,
        description: description,
        paymentMethod: 'YOOKASSA_TELEGRAM',
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
        amount: Math.round(amount * 100) // В копейках для Telegram API
      }
    ];

    // Перед отправкой сообщения показываем, что бот печатает
    await bot.sendChatAction(chatId, 'typing');

    logger.info(`Создаю платежный счет через sendInvoice для пользователя: ${user.id}, telegramId: ${user.telegramId}, период: ${period}`);

    // Отправляем платежный инвойс через Telegram API
    // Настраиваем параметры согласно документации https://core.telegram.org/bots/api#sendinvoice
    const invoiceOptions: TelegramBot.SendInvoiceOptions = {
      need_name: false,
      need_phone_number: false,
      need_email: false,
      need_shipping_address: false,
      is_flexible: false,
      disable_notification: false,
      protect_content: false,
      start_parameter: `vpn_payment_${period}`,
      photo_url: 'https://i.imgur.com/YRBvM9x.png', // Изображение для инвойса
      photo_width: 600,
      photo_height: 300
    };

    try {
      // Используем метод отправки счета напрямую через Telegram Bot API
      const apiUrl = `https://api.telegram.org/bot${config.telegramBotToken}/sendInvoice`;

      // Формируем данные согласно документации https://core.telegram.org/bots/api#sendinvoice
      const invoiceData = {
        chat_id: chatId,
        title: title,
        description: description,
        payload: payload,
        provider_token: token,
        currency: 'RUB',
        prices: prices,
        start_parameter: invoiceOptions.start_parameter,
        photo_url: invoiceOptions.photo_url,
        photo_width: invoiceOptions.photo_width,
        photo_height: invoiceOptions.photo_height,
        need_name: invoiceOptions.need_name || false,
        need_phone_number: invoiceOptions.need_phone_number || false,
        need_email: invoiceOptions.need_email || false,
        need_shipping_address: invoiceOptions.need_shipping_address || false,
        is_flexible: invoiceOptions.is_flexible || false,
        disable_notification: invoiceOptions.disable_notification || false,
        protect_content: invoiceOptions.protect_content || false
      };

      // Детальное логирование запроса (без sensitive data)
      const debugData = {
        ...invoiceData,
        provider_token: '***HIDDEN***',
        payload: '***HIDDEN***'
      };
      logger.debug(`Отправка API запроса sendInvoice: ${JSON.stringify(debugData)}`);

      // Отправляем запрос напрямую через API
      try {
        const response = await axios.post(apiUrl, invoiceData);

        if (response.data && response.data.ok) {
          logger.info(`Платежный счет успешно отправлен через Telegram API пользователю ${user.telegramId}`);

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
              logger.error(`Не удалось отправить дополнительное сообщение: ${error}`);
            }
          }, 1500);

          return { success: true };
        } else {
          // Если API запрос вернул ошибку в ответе
          logger.error(`Ошибка в ответе API: ${JSON.stringify(response.data)}`);

          // Пробуем альтернативный метод через node-telegram-bot-api
          logger.info(`Пробуем альтернативный метод отправки инвойса через node-telegram-bot-api`);
          const sentInvoice = await bot.sendInvoice(
              chatId,
              title,
              description,
              payload,
              token,
              'RUB',
              prices,
              invoiceOptions
          );

          logger.info(`Платежный счет успешно отправлен через node-telegram-bot-api пользователю ${user.telegramId}, message_id: ${sentInvoice.message_id}`);

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
              logger.error(`Не удалось отправить дополнительное сообщение: ${error}`);
            }
          }, 1500);

          return { success: true };
        }
      } catch (apiError: any) {
        // Логируем подробности ошибки API запроса
        if (apiError.response) {
          // Сервер ответил с кодом статуса вне диапазона 2xx
          logger.error(`Ошибка API запроса (${apiError.response.status}): ${JSON.stringify(apiError.response.data)}`);

          // Если ошибка связана с невалидным провайдером платежей, предлагаем альтернативу
          if (apiError.response.data &&
              apiError.response.data.description &&
              (apiError.response.data.description.includes('PAYMENT_PROVIDER_INVALID') ||
                  apiError.response.data.description.includes('provider_token'))) {

            logger.error('Обнаружена ошибка с провайдером платежей. Предлагаем альтернативный метод оплаты.');

            // Предлагаем альтернативный способ оплаты
            await offerAlternativePayment(bot, chatId, user, period, options, paymentId);
            return { success: false, error: 'Платеж через Telegram недоступен. Предложена альтернатива.' };
          }
        } else if (apiError.request) {
          // Запрос был сделан, но не получен ответ
          logger.error('Нет ответа от Telegram API:', apiError.request);
        } else {
          // Ошибка при настройке запроса
          logger.error('Ошибка настройки запроса:', apiError.message);
        }

        // Пробуем использовать стандартный метод node-telegram-bot-api
        throw apiError;
      }
    } catch (invoiceError: any) {
      logger.error(`Ошибка при отправке invoice: ${invoiceError}`);

      // Если ошибка связана с провайдером платежей, предлагаем альтернативный метод
      if (invoiceError.toString().includes('PAYMENT_PROVIDER_INVALID') ||
          invoiceError.toString().includes('provider_token')) {

        await offerAlternativePayment(bot, chatId, user, period, options, paymentId);
        return { success: false, error: 'Платеж через Telegram недоступен. Предложена альтернатива.' };
      }

      // Для других ошибок предлагаем стандартный способ оплаты через ЮKassa напрямую
      await offerAlternativePayment(bot, chatId, user, period, options, paymentId);
      return { success: false, error: 'Ошибка при отправке платежа через Telegram. Предложена альтернатива.' };
    }
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Ошибка при создании платежа ЮKassa через Telegram: ${errorMessage}`);

    // Пробуем отправить обычное сообщение с объяснением ошибки
    try {
      await bot.sendMessage(
          chatId,
          `❌ Не удалось создать платеж через Telegram: ${errorMessage}\n\nПожалуйста, попробуйте использовать другой способ оплаты.`
      );
    } catch (msgError) {
      logger.error(`Не удалось отправить сообщение об ошибке: ${msgError}`);
    }

    return { success: false, error: errorMessage };
  }
}

/**
 * Обработчик для answerPreCheckoutQuery - должен быть вызван в течение 10 секунд
 * после получения PreCheckoutQuery от Telegram
 *
 * @param bot Экземпляр бота Telegram
 * @param preCheckoutQueryId ID запроса предварительной проверки
 * @param ok Разрешить (true) или отклонить (false) платеж
 * @param errorMessage Сообщение об ошибке (только если ok=false)
 */
export async function answerPreCheckoutQuery(
    bot: TelegramBot,
    preCheckoutQueryId: string,
    ok: boolean,
    errorMessage?: string
): Promise<void> {
  try {
    logger.info(`Отвечаем на PreCheckoutQuery ${preCheckoutQueryId}, ok=${ok}`);

    if (ok) {
      // Для успешной проверки просто передаем true
      await bot.answerPreCheckoutQuery(preCheckoutQueryId, true);
      logger.info(`PreCheckoutQuery ${preCheckoutQueryId} успешно подтвержден`);
    } else {
      // Для отклонения платежа используем прямой API запрос с правильными параметрами
      const apiUrl = `https://api.telegram.org/bot${config.telegramBotToken}/answerPreCheckoutQuery`;
      const data = {
        pre_checkout_query_id: preCheckoutQueryId,
        ok: false,
        error_message: errorMessage || 'Невозможно обработать платеж'
      };

      await axios.post(apiUrl, data);
      logger.warn(`PreCheckoutQuery ${preCheckoutQueryId} отклонен: ${errorMessage}`);
    }
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Ошибка при ответе на PreCheckoutQuery ${preCheckoutQueryId}: ${errorMessage}`);

    // Пытаемся еще раз, если возможно
    try {
      // Используем прямой API запрос для отклонения
      const apiUrl = `https://api.telegram.org/bot${config.telegramBotToken}/answerPreCheckoutQuery`;
      const data = {
        pre_checkout_query_id: preCheckoutQueryId,
        ok: false,
        error_message: 'Ошибка обработки платежа'
      };

      await axios.post(apiUrl, data);
    } catch (retryError) {
      logger.error(`Не удалось повторно ответить на PreCheckoutQuery: ${retryError}`);
    }
  }
}

/**
 * Обработчик успешного платежа ЮKassa через Telegram
 * Вызывается после получения объекта SuccessfulPayment от Telegram
 */
export async function handleSuccessfulYookassaTelegramPayment(
    successfulPayment: TelegramBot.SuccessfulPayment
): Promise<void> {
  try {
    logger.info(`Обработка успешного платежа ЮKassa через Telegram: ${JSON.stringify(successfulPayment)}`);

    // Получаем провайдер ID платежа от ЮKassa (важно для отслеживания)
    const providerPaymentChargeId = successfulPayment.provider_payment_charge_id;

    // Разбираем payload, который мы создавали при формировании инвойса
    let metadata: any = {};
    try {
      metadata = JSON.parse(successfulPayment.invoice_payload);
    } catch (parseError) {
      logger.error(`Ошибка при разборе payload платежа: ${parseError}`);
      throw new Error('Невозможно разобрать данные платежа');
    }

    // Получаем нужные данные из метаданных
    const userId = parseInt(metadata.userId || '0', 10);
    const period = metadata.subscriptionPeriod as SubscriptionPeriod;
    const subscriptionId = metadata.subscriptionId ? parseInt(metadata.subscriptionId, 10) : undefined;
    const isGift = metadata.isGift === 'true';
    const giftSubscriptionId = metadata.giftSubscriptionId ? parseInt(metadata.giftSubscriptionId, 10) : undefined;
    const recipientId = metadata.recipientId ? parseInt(metadata.recipientId, 10) : undefined;

    // Проверяем, существует ли пользователь
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      logger.error(`Пользователь не найден при обработке платежа ЮKassa: ${userId}`);
      throw new Error(`Пользователь не найден: ${userId}`);
    }

    // Находим платеж в нашей БД по ID в связанной таблице или создаем новый
    const tgPaymentId = `tg_${Date.now()}_${userId}`; // Запасной ID, если не найдем существующий

    // Ищем платеж по пользователю и статусу
    const payment = await prisma.payment.findFirst({
      where: {
        userId: userId,
        status: 'PENDING',
        paymentMethod: 'YOOKASSA_TELEGRAM'
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    if (payment) {
      // Обновляем существующий платеж
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.SUCCEEDED,
          confirmedAt: new Date(),
          paymentMethod: `YOOKASSA_TELEGRAM:${providerPaymentChargeId}`
        }
      });

      logger.info(`Платеж ${payment.id} успешно обновлен до статуса SUCCEEDED с провайдер ID: ${providerPaymentChargeId}`);
    } else {
      // Создаем новый платеж
      await prisma.payment.create({
        data: {
          id: tgPaymentId,
          userId: userId,
          subscriptionId: subscriptionId || null,
          amount: successfulPayment.total_amount / 100, // Конвертируем копейки в рубли
          currency: successfulPayment.currency,
          status: PaymentStatus.SUCCEEDED,
          description: `Оплата через Telegram ЮKassa (${period})`,
          paymentMethod: `YOOKASSA_TELEGRAM:${providerPaymentChargeId}`,
          confirmedAt: new Date()
        }
      });

      logger.info(`Создан новый платеж ${tgPaymentId} на основе успешного платежа Telegram ЮKassa`);
    }

    // Обрабатываем платеж в зависимости от типа
    try {
      if (isGift && giftSubscriptionId && recipientId) {
        // Обрабатываем подарочную подписку
        await handleGiftPayment(userId, giftSubscriptionId, recipientId, period);
      } else if (subscriptionId) {
        // Продлеваем существующую подписку
        await handleSubscriptionRenewal(userId, subscriptionId, period);
      } else {
        // Создаем новую подписку
        await handleNewSubscription(userId, period);
      }

      logger.info(`Успешно обработан платеж ЮKassa для пользователя ${userId}`);
    } catch (processingError: any) {
      const errorMessage = processingError instanceof Error ? processingError.message : String(processingError);
      logger.error(`Ошибка при обработке подписки после платежа ЮKassa: ${errorMessage}`);
      throw processingError;
    }
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Ошибка при обработке платежа ЮKassa: ${errorMessage}`);
    throw error;
  }
}

/**
 * Обрабатывает подарочную подписку
 */
export async function handleGiftPayment(
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
        const periodName = getPeriodName(period);

        const recipientName = recipient.username
            ? '@' + recipient.username
            : recipient.firstName || recipient.telegramId.toString();

        // Уведомление отправителю
        await bot.sendMessage(
            sender.telegramId.toString(),
            `✅ Оплата подарочной подписки успешно завершена!\n\nПолучатель: ${recipientName}\nТариф: ${periodName}\n\nПолучатель получит уведомление о вашем подарке.`
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
            `🎁 *Вам подарили VPN-подписку!*\n\nОтправитель: ${senderName}\nТариф: ${periodName}\n\nНажмите кнопку ниже, чтобы активировать подарок.`,
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
export async function handleSubscriptionRenewal(
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
 * Проверяет статус платежа через API ЮKassa
 * @param paymentId Идентификатор платежа в системе ЮKassa
 * @returns Текущий статус платежа из PaymentStatus
 */
export async function checkYookassaPaymentStatus(paymentId: string): Promise<PaymentStatus> {
  try {
    logger.info(`Проверка статуса платежа ЮKassa: ${paymentId}`);

    // Создаем параметры для запроса к API ЮKassa
    const shopId = config.yookassaShopId;
    const secretKey = config.yookassaSecretKey;

    // Формируем заголовок авторизации в формате Basic Auth
    const authString = `${shopId}:${secretKey}`;
    const auth = Buffer.from(authString).toString('base64');

    // Выполняем запрос к API ЮKassa
    const response = await axios.get(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000 // 10 секунд таймаут
    });

    // Проверяем статус ответа
    if (response.status !== 200) {
      logger.error(`Ошибка API ЮKassa: Неверный статус ответа: ${response.status}`);
      throw new Error(`Ошибка API ЮKassa: Неверный статус ответа: ${response.status}`);
    }

    // Парсим ответ
    const paymentData = response.data;
    logger.debug(`Получены данные о платеже: ${JSON.stringify(paymentData)}`);

    // Маппинг статусов ЮKassa на наши статусы
    let status: PaymentStatus;
    switch (paymentData.status) {
      case 'pending':
        status = PaymentStatus.PENDING;
        break;
      case 'waiting_for_capture':
        status = PaymentStatus.WAITING_FOR_CAPTURE;
        break;
      case 'succeeded':
        status = PaymentStatus.SUCCEEDED;
        break;
      case 'canceled':
        status = PaymentStatus.CANCELED;
        break;
      default:
        status = PaymentStatus.FAILED;
    }

    // Обновляем запись о платеже в нашей БД
    const existingPayment = await prisma.payment.findUnique({
      where: { id: paymentId }
    });

    if (existingPayment && existingPayment.status !== status) {
      // Обновляем статус платежа в БД, если он изменился
      await prisma.payment.update({
        where: { id: paymentId },
        data: {
          status,
          confirmedAt: status === PaymentStatus.SUCCEEDED ? new Date() : existingPayment.confirmedAt
        }
      });

      logger.info(`Статус платежа ${paymentId} обновлен: ${existingPayment.status} -> ${status}`);

      // Если платеж успешно завершен, обрабатываем его
      if (status === PaymentStatus.SUCCEEDED && existingPayment.status !== PaymentStatus.SUCCEEDED) {
        const payment = await prisma.payment.findUnique({
          where: { id: paymentId },
          include: { user: true }
        });

        if (payment) {
          try {
            // Извлекаем метаданные платежа для определения типа
            const metadata = paymentData.metadata || {};
            const period = metadata.subscriptionPeriod as SubscriptionPeriod || SubscriptionPeriod.MONTHLY;

            // Проверяем тип платежа и обрабатываем соответствующим образом
            if (metadata.isGift === 'true' && metadata.giftSubscriptionId && metadata.recipientId) {
              // Обрабатываем подарочную подписку
              await handleGiftPayment(
                  payment.userId,
                  parseInt(metadata.giftSubscriptionId, 10),
                  parseInt(metadata.recipientId, 10),
                  period
              );
            } else if (payment.subscriptionId) {
              // Продлеваем существующую подписку
              await handleSubscriptionRenewal(
                  payment.userId,
                  payment.subscriptionId,
                  period
              );
            } else {
              // Создаем новую подписку
              await handleNewSubscription(payment.userId, period);
            }

            logger.info(`Платеж ${paymentId} успешно обработан после проверки статуса`);
          } catch (processingError: any) {
            const errorMessage = processingError instanceof Error ? processingError.message : String(processingError);
            logger.error(`Ошибка при обработке платежа ${paymentId}: ${errorMessage}`);
            throw processingError;
          }
        }
      }
    }

    return status;
  } catch (error: any) {
    // Обработка ошибок API ЮKassa
    if (error.response) {
      // Сервер ответил с кодом статуса вне диапазона 2xx
      const statusCode = error.response.status;
      const responseData = error.response.data;

      logger.error(`Ошибка API ЮKassa (${statusCode}): ${JSON.stringify(responseData)}`);

      // Обработка конкретных ошибок
      if (statusCode === 404) {
        // Платеж не найден
        logger.warn(`Платеж ${paymentId} не найден в системе ЮKassa`);

        // Обновляем статус в нашей БД
        const existingPayment = await prisma.payment.findUnique({
          where: { id: paymentId }
        });

        if (existingPayment && existingPayment.status === PaymentStatus.PENDING) {
          await prisma.payment.update({
            where: { id: paymentId },
            data: {
              status: PaymentStatus.FAILED,
              confirmedAt: new Date()
            }
          });

          logger.info(`Статус платежа ${paymentId} обновлен на FAILED (не найден в ЮKassa)`);
        }

        return PaymentStatus.FAILED;
      } else if (statusCode === 401 || statusCode === 403) {
        // Ошибка авторизации
        logger.error(`Ошибка авторизации при проверке платежа ${paymentId}: Проверьте shopId и secretKey`);
        throw new Error('Ошибка авторизации при доступе к API ЮKassa');
      }
    } else if (error.request) {
      // Запрос был сделан, но не получен ответ
      logger.error(`Нет ответа от API ЮKassa при проверке платежа ${paymentId}: ${error.message}`);
      throw new Error('Нет ответа от сервера ЮKassa');
    }

    // Общая ошибка
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Ошибка при проверке статуса платежа ${paymentId}: ${errorMessage}`);

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

