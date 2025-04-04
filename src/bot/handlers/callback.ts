import TelegramBot, { CallbackQuery, Message } from 'node-telegram-bot-api';
import config from "../../config";
import { prisma } from '../../services/database';
import {
  createPayment,
  createTelegramDirectPayment,
  getPaymentAmount,
  getSubscriptionDuration,
  SubscriptionPeriod
} from '../../services/payment';
import { generateClientConfig } from '../../services/vpn';
import { answerPreCheckoutQuery } from "../../services/yookassaTelegramPayments";
import logger from '../../utils/logger';
import { CallbackQueryHandler } from './types';
import { handleHelp } from './help';
import { handleProfile } from './profile';
import { handleBuy, handleGiftSubscription, handleRequestGiftRecipient, handleSelectPaymentMethod } from './buy';
import { handleReferral } from './referral';
import { handleSubscription } from './subscription';
import * as subscriptionService from '../../services/subscription';
import { handleFaqCategory, handleFaqItem, handleFaqSearch, handleFaq } from './faq';
import * as qrcodeService from '../../services/qrcode';

/**
 * Обработчик callback-запросов (inline кнопок)
 * @param bot - экземпляр Telegram бота
 */
export const handleCallbackQuery: CallbackQueryHandler = (bot: TelegramBot) => async (query: CallbackQuery): Promise<void> => {
  try {
    const chatId = query.message?.chat.id;
    const messageId = query.message?.message_id;
    const callbackData = query.data;

    if (!chatId || !messageId || !callbackData) {
      logger.warn(`Получен неполный callback_query: ${JSON.stringify(query)}`);
      return;
    }

    // Сначала отправляем acknowledgment для callback query
    await bot.answerCallbackQuery(query.id).catch(err => {
      logger.error(`Ошибка при отправке answerCallbackQuery: ${err}`);
      // Продолжаем выполнение даже при ошибке
    });

    logger.debug(`Обработка callback: ${callbackData} от пользователя ${query.from.id}`);

    // Обработка различных callback data
    if (callbackData === 'main_menu') {
      // Возврат в главное меню
      const welcomeMessage = `
🔐 *Главное меню VPN Bot*

Выберите действие:
      `;

      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '💳 Купить подписку', callback_data: 'buy' },
              { text: '🔑 Мои подписки', callback_data: 'subscription' }
            ],
            [
              { text: '👤 Профиль', callback_data: 'profile' },
              { text: '👥 Реферальная программа', callback_data: 'referral' }
            ],
            [
              { text: '❓ Помощь', callback_data: 'help' }
            ]
          ]
        },
        parse_mode: 'Markdown' as TelegramBot.ParseMode
      };

      await bot.editMessageText(welcomeMessage, {
        chat_id: chatId,
        message_id: messageId,
        ...keyboard
      });
    } else if (callbackData === 'buy') {
      // Перенаправляем на обработчик покупки
      const message = { chat: { id: chatId }, from: query.from } as Message;
      await handleBuy(bot)(message);
    } else if (callbackData === 'subscription') {
      // Перенаправляем на обработчик подписок
      const message = { chat: { id: chatId }, from: query.from } as Message;
      await handleSubscription(bot)(message);
    } else if (callbackData === 'profile') {
      // Перенаправляем на обработчик профиля
      const message = { chat: { id: chatId }, from: query.from } as Message;
      await handleProfile(bot)(message);
    } else if (callbackData === 'help') {
      // Перенаправляем на обработчик помощи
      const message = { chat: { id: chatId }, from: query.from } as Message;
      await handleHelp(bot)(message);
    } else if (callbackData === 'referral') {
      // Перенаправляем на обработчик реферальной программы
      const message = { chat: { id: chatId }, from: query.from } as Message;
      await handleReferral(bot)(message);
    } else if (callbackData === 'faq') {
      // Перенаправляем на обработчик FAQ
      const message = { chat: { id: chatId }, from: query.from } as Message;
      await handleFaq(bot)(message);
    } else if (callbackData.startsWith('faq_category_')) {
      // Обработка выбора категории FAQ
      const category = callbackData.replace('faq_category_', '');
      await handleFaqCategory(bot, chatId, messageId, category);
    } else if (callbackData.startsWith('faq_item_')) {
      // Обработка выбора элемента FAQ
      const itemId = parseInt(callbackData.replace('faq_item_', ''), 10);
      await handleFaqItem(bot, chatId, messageId, itemId);
    } else if (callbackData === 'faq_search') {
      // Обработка запроса на поиск по FAQ
      await handleFaqSearch(bot, chatId, messageId);
    } else if (callbackData.startsWith('buy_')) {
      // Обработка выбора тарифа для покупки
      const planType = callbackData.replace('buy_', '');

      let period: SubscriptionPeriod;

      switch (planType) {
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

      // Вместо создания URL для оплаты напрямую, показываем выбор метода оплаты
      await handleSelectPaymentMethod(bot, chatId, messageId, period, undefined);
    }

    else if (callbackData.startsWith('pay_telegram_direct_')) {
      // Обработка выбора способа оплаты через прямой Telegram Payment API
      const parts = callbackData.replace('pay_telegram_direct_', '').split('_');
      const periodStr = parts[0];
      const subscriptionId = parts.length > 1 ? parseInt(parts[1], 10) : undefined;

      let period: SubscriptionPeriod;
      switch (periodStr) {
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

      try {
        // Находим пользователя
        const user = await prisma.user.findUnique({
          where: { telegramId: BigInt(query.from?.id || 0) }
        });

        if (!user) {
          await bot.sendMessage(chatId, 'Пожалуйста, используйте /start для начала работы с ботом.');
          return;
        }

        // Информируем пользователя о подготовке платежа
        await bot.editMessageText(`⏳ Подготовка платежа через Telegram...`, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown'
        });

        // Импортируем функцию создания платежа
        const { createYookassaTelegramPayment } = require('../../services/yookassaTelegramPayments');

        // Создаем платеж через Telegram
        const result = await createYookassaTelegramPayment(
            bot,
            chatId,
            user,
            period,
            { subscriptionId: subscriptionId }
        );

        if (!result.success) {
          throw new Error(result.error || 'Не удалось создать платеж');
        }

        // Платеж успешно создан
        logger.info(`Создан платеж через Telegram для пользователя ${user.id}: ${result.paymentId}`);

        // Обновляем сообщение (не требуется, createYookassaTelegramPayment уже отправляет инвойс)
        await bot.editMessageText(
            `✅ Счет на оплату отправлен. Используйте кнопку оплаты в сообщении ниже ⬇️`,
            {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔙 Вернуться к тарифам', callback_data: 'buy' }]
                ]
              }
            }
        );
      } catch (error: any) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Ошибка при создании прямого платежа через Telegram: ${errorMessage}`);

        await bot.editMessageText(
            `❌ Произошла ошибка при подготовке платежа: ${errorMessage}\n\nПожалуйста, попробуйте позже или выберите другой способ оплаты.`,
            {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '💳 Оплатить картой', callback_data: `pay_card_${periodStr}${subscriptionId ? '_' + subscriptionId : ''}` }],
                  [{ text: '🔙 Назад', callback_data: 'buy' }]
                ]
              }
            }
        );
      }
    }

    else if (callbackData.startsWith('pay_telegram_') && !callbackData.startsWith('pay_telegram_direct_')) {
      // Обработка выбора способа оплаты через Telegram (ЮKassa)
      const parts = callbackData.replace('pay_telegram_', '').split('_');
      const periodStr = parts[0];
      const subscriptionId = parts.length > 1 ? parseInt(parts[1], 10) : undefined;

      let period: SubscriptionPeriod;
      switch (periodStr) {
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

      try {
        // Находим пользователя
        const user = await prisma.user.findUnique({
          where: { telegramId: BigInt(query.from?.id || 0) }
        });

        if (!user) {
          await bot.sendMessage(chatId, 'Пожалуйста, используйте /start для начала работы с ботом.');
          return;
        }

        // Информируем пользователя о подготовке платежа
        await bot.editMessageText(`⏳ Подготовка платежа через Telegram...`, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown'
        });

        // Создаем платеж через Telegram
        const result = await createTelegramDirectPayment(
          bot,
          chatId,
          user,
          period,
          { subscriptionId: subscriptionId }
        );

        if (!result.success) {
          throw new Error(result.error || 'Не удалось создать платеж');
        }

        // Платеж уже создан и отправлен пользователю через инвойс
        logger.info(`Создан платеж через Telegram для пользователя ${user.id}: ${result.paymentId}`);
      } catch (error: any) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Ошибка при создании платежа через Telegram: ${errorMessage}`);

        await bot.editMessageText(
          `❌ Произошла ошибка при подготовке платежа: ${errorMessage}\n\nПожалуйста, попробуйте позже или выберите другой способ оплаты.`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Назад', callback_data: 'buy' }]]
            }
          }
        );
      }
    } else if (callbackData === 'pay_telegram_direct') {
      // Обработка выбора способа оплаты через прямой Telegram Payment API
      const parts = callbackData.replace('pay_telegram_direct_', '').split('_');
      const periodStr = parts[0];
      const subscriptionId = parts.length > 1 ? parseInt(parts[1], 10) : undefined;

      let period: SubscriptionPeriod;
      switch (periodStr) {
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

      try {
        // Находим пользователя
        const user = await prisma.user.findUnique({
          where: { telegramId: BigInt(query.from?.id || 0) }
        });

        if (!user) {
          await bot.sendMessage(chatId, 'Пожалуйста, используйте /start для начала работы с ботом.');
          return;
        }

        // Информируем пользователя о подготовке платежа
        await bot.editMessageText(`⏳ Подготовка прямого платежа через Telegram...`, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown'
        });

        // Создаем платеж через Telegram
        const result = await createTelegramDirectPayment(
          bot,
          chatId,
          user,
          period,
          { subscriptionId: subscriptionId }
        );

        if (!result.success) {
          throw new Error(result.error || 'Не удалось создать платеж');
        }

        // Платеж уже создан и отправлен пользователю через инвойс
        logger.info(`Создан прямой платеж через Telegram для пользователя ${user.id}: ${result.paymentId}`);
      } catch (error: any) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Ошибка при создании прямого платежа через Telegram: ${errorMessage}`);

        await bot.editMessageText(
          `❌ Произошла ошибка при подготовке платежа: ${errorMessage}\n\nПожалуйста, попробуйте позже или выберите другой способ оплаты.`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Назад', callback_data: 'buy' }]]
            }
          }
        );
      }
    } else if (callbackData.startsWith('pay_gift_telegram_')) {
      // Обработка оплаты подарочной подписки через Telegram (ЮKassa)
      const giftSubscriptionId = parseInt(callbackData.replace('pay_gift_telegram_', ''), 10);

      try {
        // Находим пользователя
        const user = await prisma.user.findUnique({
          where: { telegramId: BigInt(query.from?.id || 0) }
        });

        if (!user) {
          await bot.sendMessage(chatId, 'Пожалуйста, используйте /start для начала работы с ботом.');
          return;
        }

        // Находим подарочную подписку
        const giftSubscription = await prisma.giftSubscription.findUnique({
          where: { id: giftSubscriptionId },


        });

        if (!giftSubscription) {
          throw new Error('Подарочная подписка не найдена');
        }

        // Проверяем, что пользователь является отправителем подарка
        if (giftSubscription.senderId !== user.id) {
          throw new Error('Вы не являетесь отправителем этого подарка');
        }

        // Определяем период подписки
        let period: SubscriptionPeriod;
        switch (giftSubscription.period) {
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

        // Информируем пользователя о подготовке платежа
        await bot.editMessageText(`⏳ Подготовка платежа через Telegram...`, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown'
        });

        // Создаем платеж через Telegram
        const result = await createTelegramDirectPayment(
          bot,
          chatId,
          user,
          period,
          {
            isGift: true,
            giftSubscriptionId: giftSubscription.id,
            recipientId: giftSubscription.recipientId
          }
        );

        if (!result.success) {
          throw new Error(result.error || 'Не удалось создать платеж');
        }

        // Платеж уже создан и отправлен пользователю через инвойс
        logger.info(`Создан платеж подарочной подписки через Telegram: ${result.paymentId}`);
      } catch (error: any) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Ошибка при создании платежа подарочной подписки через Telegram: ${errorMessage}`);

        await bot.editMessageText(
          `❌ Произошла ошибка при подготовке платежа: ${errorMessage}\n\nПожалуйста, попробуйте позже или выберите другой способ оплаты.`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Назад', callback_data: 'gift_subscription' }]]
            }
          }
        );
      }
    } else if (callbackData.startsWith('pay_gift_telegram_direct_')) {
      // Обработка оплаты подарочной подписки через прямой Telegram Payment API
      const giftSubscriptionId = parseInt(callbackData.replace('pay_gift_telegram_direct_', ''), 10);

      try {
        // Находим пользователя
        const user = await prisma.user.findUnique({
          where: { telegramId: BigInt(query.from?.id || 0) }
        });

        if (!user) {
          await bot.sendMessage(chatId, 'Пожалуйста, используйте /start для начала работы с ботом.');
          return;
        }

        // Находим подарочную подписку
        const giftSubscription = await prisma.giftSubscription.findUnique({
          where: { id: giftSubscriptionId },
        });

        if (!giftSubscription) {
          throw new Error('Подарочная подписка не найдена');
        }

        // Проверяем, что пользователь является отправителем подарка
        if (giftSubscription.senderId !== user.id) {
          throw new Error('Вы не являетесь отправителем этого подарка');
        }

        // Определяем период подписки
        let period: SubscriptionPeriod;
        switch (giftSubscription.period) {
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

        // Информируем пользователя о подготовке платежа
        await bot.editMessageText(`⏳ Подготовка прямого платежа через Telegram...`, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown'
        });

        // Создаем прямой платеж через Telegram
        const result = await createTelegramDirectPayment(
          bot,
          chatId,
          user,
          period,
          {
            isGift: true,
            giftSubscriptionId: giftSubscription.id,
            recipientId: giftSubscription.recipientId
          }
        );

        if (!result.success) {
          throw new Error(result.error || 'Не удалось создать платеж');
        }

        // Платеж уже создан и отправлен пользователю через инвойс
        logger.info(`Создан прямой платеж подарочной подписки через Telegram: ${result.paymentId}`);
      } catch (error: any) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Ошибка при создании прямого платежа подарочной подписки через Telegram: ${errorMessage}`);

        await bot.editMessageText(
          `❌ Произошла ошибка при подготовке платежа: ${errorMessage}\n\nПожалуйста, попробуйте позже или выберите другой способ оплаты.`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Назад', callback_data: 'gift_subscription' }]]
            }
          }
        );
      }
    } else if (callbackData.startsWith('get_config_')) {
      // Обработка запроса на получение конфигурации
      const subscriptionId = parseInt(callbackData.replace('get_config_', ''), 10);

      try {
        // Находим подписку
        const subscription = await prisma.subscription.findUnique({
          where: { id: subscriptionId },
          include: {
            user: true,
            vpnServer: true
          }
        });

        if (!subscription) {
          await bot.sendMessage(chatId, '❌ Подписка не найдена.');
          return;
        }

        // Проверяем, что подписка принадлежит пользователю
        if (subscription.user.telegramId !== BigInt(query.from?.id || 0)) {
          await bot.sendMessage(chatId, '⛔ У вас нет доступа к этой подписке.');
          return;
        }

        // Информируем пользователя о подготовке конфигурации
        await bot.editMessageText(`⏳ Подготовка VPN конфигурации...`, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown'
        });

        const server = subscription.vpnServer;

        // Проверка данных сервера
        if (!server || !server.isActive) {
          await bot.editMessageText(`❌ Возникла проблема с назначенным вам сервером. Обратитесь в поддержку.`, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Назад', callback_data: 'subscription' }]]
            }
          });
          return;
        }

        if (server.configData !== 'docker' || !server.initialUserId || !server.realityPublicKey || !server.realityShortId) {
          await bot.editMessageText(`❌ Конфигурация для вашего сервера еще не готова или неполная. Обратитесь в поддержку.`, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Назад', callback_data: 'subscription' }]]
            }
          });
          return;
        }

        // Импортируем функцию generateVlessUrl
        const { generateVlessUrl } = require('../../utils/generateVlessUrl');
        const QRCode = require('qrcode');

        // Генерируем VLESS URL для подключения
        const vlessUrl = generateVlessUrl({
          uuid: server.initialUserId, 
          address: server.host,
          port: server.port, 
          publicKey: server.realityPublicKey,
          shortId: server.realityShortId,
          serverName: 'www.google.com', // TODO: Вынести в настройки
          fingerprint: 'chrome', // TODO: Вынести в настройки
          serverDescription: server.name || server.host,
        });

        // Генерируем QR-код
        const qrCodeDataUrl = await QRCode.toDataURL(vlessUrl);
        const base64Data = qrCodeDataUrl.replace(/^data:image\/png;base64,/, "");
        const qrCodeBuffer = Buffer.from(base64Data, 'base64');

        // Отправляем VLESS-ссылку в текстовом виде
        await bot.sendMessage(chatId, `Ваша ссылка для подключения (скопируйте):\n<code>${vlessUrl}</code>`, { parse_mode: 'HTML' });

        // Отправляем QR-код как фото
        await bot.sendPhoto(chatId, qrCodeBuffer, {
          caption: `QR-код для подключения к серверу "${server.name || server.host}" (отсканируйте в приложении).`,
        });

        // Восстанавливаем интерфейс подписок и отправляем инструкции
        const instructionMessage = `
📱 *Инструкции по установке:*

1. Установите приложение v2rayNG (Android) или FoXray (iOS)
2. Нажмите на ссылку для копирования
3. В приложении добавьте новую конфигурацию "из буфера обмена"
4. Или отсканируйте QR-код камерой приложения

Приятного использования!
        `;

        const keyboard = {
          reply_markup: {
            inline_keyboard: [
              [{ text: '❓ Инструкции по установке', callback_data: 'help' }],
              [{ text: '🔙 Назад к подпискам', callback_data: 'subscription' }]
            ]
          },
          parse_mode: 'Markdown' as TelegramBot.ParseMode
        };

        await bot.sendMessage(chatId, instructionMessage, keyboard);

        // Восстанавливаем предыдущее сообщение о подписке
        await handleSubscription(bot)({ chat: { id: chatId }, from: query.from } as Message);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Ошибка при получении конфигурации: ${errorMessage}`);

        await bot.editMessageText(
            `❌ Произошла ошибка при получении конфигурации: ${errorMessage}\n\nПожалуйста, попробуйте позже или обратитесь в поддержку.`,
            {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[{ text: '🔙 Назад', callback_data: 'subscription' }]]
              }
            }
        );
      }
    } else if (callbackData.startsWith('help_')) {
      // Обработка запросов помощи для разных платформ
      const platform = callbackData.replace('help_', '');
      let helpText = '';

      switch (platform) {
        case 'windows':
          helpText = `
📱 *Инструкция по установке VPN на Windows*

1. Скачайте и установите приложение V2rayN с официального сайта:
   https://github.com/2dust/v2rayN/releases

2. Запустите приложение V2rayN

3. Нажмите на кнопку меню (три полоски) слева вверху

4. Выберите "Import config from file"

5. Выберите файл конфигурации, полученный от бота

6. После импорта выберите ваш сервер из списка и нажмите "Set as active server"

7. VPN будет автоматически подключен

Если у вас возникли проблемы, обратитесь в нашу поддержку.
          `;
          break;

        case 'macos':
          helpText = `
📱 *Инструкция по установке VPN на macOS*

1. Скачайте и установите приложение ClashX с официального сайта:
   https://github.com/yichengchen/clashX/releases

2. Запустите приложение ClashX

3. Нажмите на иконку ClashX в строке меню

4. Выберите "Config" -> "Import" -> "Import from file"

5. Выберите файл конфигурации, полученный от бота

6. После импорта VPN будет автоматически подключен

Если у вас возникли проблемы, обратитесь в нашу поддержку.
          `;
          break;

        case 'android':
          helpText = `
📱 *Инструкция по установке VPN на Android*

1. Установите приложение V2rayNG из Google Play:
   https://play.google.com/store/apps/details?id=com.v2ray.ang

2. Откройте приложение V2rayNG

3. Нажмите на значок "+" в правом верхнем углу

4. Выберите "Import config file" или "Scan QR code"

5. Выберите файл конфигурации, полученный от бота, или отсканируйте QR-код

6. После импорта нажмите на выключатель в нижней части экрана для подключения

Если у вас возникли проблемы, обратитесь в нашу поддержку.
          `;
          break;

        case 'ios':
          helpText = `
📱 *Инструкция по установке VPN на iOS*

1. Установите приложение Shadowrocket из App Store:
   https://apps.apple.com/app/shadowrocket/id932747118

2. Откройте приложение Shadowrocket

3. Нажмите на кнопку "+" в правом верхнем углу

4. Выберите "Type" -> "Vmess"

5. Введите данные из файла конфигурации, полученного от бота, или отсканируйте QR-код

6. Нажмите "Done" и включите переключатель для подключения

Если у вас возникли проблемы, обратитесь в нашу поддержку.
          `;
          break;

        case 'commands':
          helpText = `
📋 *Все команды бота*

/start - Начать работу с ботом
/help - Получить справку и инструкции
/subscription - Управление подписками
/buy - Приобрести подписку
/profile - Информация о вашем профиле
/referral - Управление реферальной программой
/support - Связаться с поддержкой

Используйте эти команды для взаимодействия с ботом.
          `;
          break;

        default:
          helpText = `Выберите платформу для получения подробных инструкций.`;
      }

      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔙 К списку платформ', callback_data: 'help' }
            ]
          ]
        },
        parse_mode: 'Markdown' as TelegramBot.ParseMode
      };

      await bot.editMessageText(helpText, {
        chat_id: chatId,
        message_id: messageId,
        ...keyboard
      }).catch(err => {
        logger.error(`Ошибка при отправке инструкций по платформе ${platform}: ${err}`);
        // В случае ошибки пробуем отправить новое сообщение вместо редактирования
        bot.sendMessage(chatId, helpText, keyboard);
      });
    } else if (callbackData.startsWith('manage_sub_')) {
      // Обработка запроса на управление подпиской
      const subscriptionId = parseInt(callbackData.replace('manage_sub_', ''), 10);

      try {
        // Находим подписку
        const subscription = await prisma.subscription.findUnique({
          where: { id: subscriptionId },
          include: {
            user: true,
            vpnServer: true
          }
        });

        if (!subscription) {
          await bot.sendMessage(chatId, '❌ Подписка не найдена.');
          return;
        }

        // Проверяем, что подписка принадлежит пользователю
        if (subscription.user.telegramId !== BigInt(query.from?.id || 0)) {
          await bot.sendMessage(chatId, '⛔ У вас нет доступа к этой подписке.');
          return;
        }

        const managementMessage = `
🔧 *Управление подпиской #${subscription.id}*

Сервер: ${subscription.vpnServer.name}
Действует до: ${new Date(subscription.endDate).toLocaleDateString()}
Автопродление: ${subscription.autoRenewal ? 'Включено ✅' : 'Отключено ❌'}

Выберите действие:
        `;

        const keyboard = {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: subscription.autoRenewal ? 'Отключить автопродление' : 'Включить автопродление',
                  callback_data: `auto_renewal_${subscription.id}_${!subscription.autoRenewal}`
                }
              ],
              [
                { text: '📥 Получить конфигурацию', callback_data: `get_config_${subscription.id}` }
              ],
              [
                { text: '♻️ Обновить конфигурацию', callback_data: `refresh_config_${subscription.id}` }
              ],
              [
                { text: '🔙 Назад к подпискам', callback_data: 'subscription' }
              ]
            ]
          },
          parse_mode: 'Markdown' as TelegramBot.ParseMode
        };

        await bot.editMessageText(managementMessage, {
          chat_id: chatId,
          message_id: messageId,
          ...keyboard
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Ошибка при управлении подпиской: ${errorMessage}`);

        await bot.editMessageText(
            `❌ Произошла ошибка при запросе настроек подписки: ${errorMessage}\n\nПожалуйста, попробуйте позже.`,
            {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[{ text: '🔙 Назад', callback_data: 'subscription' }]]
              }
            }
        );
      }
    } else if (callbackData.startsWith('show_sub_')) {
      // Обработка запроса на просмотр информации о подписке
      const subscriptionId = parseInt(callbackData.replace('show_sub_', ''), 10);

      try {
        // Находим подписку
        const subscription = await prisma.subscription.findUnique({
          where: { id: subscriptionId },
          include: {
            user: true,
            vpnServer: true
          }
        });

        if (!subscription) {
          await bot.sendMessage(chatId, '❌ Подписка не найдена.');
          return;
        }

        // Проверяем, что подписка принадлежит пользователю
        if (subscription.user.telegramId !== BigInt(query.from?.id || 0)) {
          await bot.sendMessage(chatId, '⛔ У вас нет доступа к этой подписке.');
          return;
        }

        // Формируем сообщение с информацией о подписке
        const endDate = new Date(subscription.endDate);
        const formattedDate = `${endDate.getDate()}.${endDate.getMonth() + 1}.${endDate.getFullYear()}`;

        let subscriptionMessage = '🔑 *Информация о подписке:*\n\n';

        subscriptionMessage += `🌐 *Подписка #${subscription.id}*\n`;
        subscriptionMessage += `📍 Сервер: ${subscription.vpnServer.name} (${subscription.vpnServer.location})\n`;
        subscriptionMessage += `⏱ Действует до: ${formattedDate}\n`;
        subscriptionMessage += `⬇️ Скорость скачивания: ${subscription.downloadSpeed} Mbps\n`;
        subscriptionMessage += `⬆️ Скорость загрузки: ${subscription.uploadSpeed} Mbps\n`;
        subscriptionMessage += `🔄 Автопродление: ${subscription.autoRenewal ? 'Включено' : 'Отключено'}\n`;
        subscriptionMessage += `📂 Торренты: ${subscription.torrentsAllowed ? 'Разрешены' : 'Запрещены'}\n`;

        // Получаем все активные подписки пользователя для создания кнопок навигации
        const allSubscriptions = await prisma.subscription.findMany({
          where: {
            userId: subscription.userId,
            status: 'ACTIVE',
            endDate: {
              gt: new Date()
            }
          },
          orderBy: {
            id: 'asc'
          }
        });

        // Создаем клавиатуру с кнопками управления
        const keyboard = {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '📥 Получить конфигурацию', callback_data: `get_config_${subscription.id}` },
                { text: '🔄 Управление', callback_data: `manage_sub_${subscription.id}` }
              ],
              [
                { text: '💳 Купить еще', callback_data: 'buy' },
                { text: '🔙 Назад', callback_data: 'subscription' }
              ]
            ]
          },
          parse_mode: 'Markdown' as TelegramBot.ParseMode
        };

        // Если подписок больше одной, добавляем возможность переключения между ними
        if (allSubscriptions.length > 1) {
          const navigationButtons = allSubscriptions.map((sub, index) => ({
            text: subscription.id === sub.id ? `•${index + 1}•` : `${index + 1}`,
            callback_data: `show_sub_${sub.id}`
          }));

          keyboard.reply_markup.inline_keyboard.splice(
              1, 0, navigationButtons
          );
        }

        await bot.editMessageText(subscriptionMessage, {
          chat_id: chatId,
          message_id: messageId,
          ...keyboard
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Ошибка при отображении информации о подписке: ${errorMessage}`);

        await bot.editMessageText(
            `❌ Произошла ошибка при получении информации о подписке: ${errorMessage}\n\nПожалуйста, попробуйте позже.`,
            {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[{ text: '🔙 Назад', callback_data: 'subscription' }]]
              }
            }
        );
      }
    } else if (callbackData.startsWith('auto_renewal_')) {
      // Обработка запроса на изменение статуса автопродления
      const parts = callbackData.split('_');
      const subscriptionId = parseInt(parts[2], 10);
      const newStatus = parts[3] === 'true';

      try {
        // Обновляем статус автопродления
        if (newStatus) {
          await subscriptionService.enableAutoRenewal(subscriptionId);
        } else {
          await subscriptionService.disableAutoRenewal(subscriptionId);
        }

        // Отправляем сообщение об успешном обновлении
        const statusMessage = newStatus
            ? '✅ Автопродление успешно включено'
            : '❌ Автопродление успешно отключено';

        await bot.answerCallbackQuery(query.id, {
          text: statusMessage,
          show_alert: true
        });

        // Возвращаемся к управлению подпиской для отображения обновленной информации
        const callbackQuery = {
          ...query,
          data: `manage_sub_${subscriptionId}`
        };

        await handleCallbackQuery(bot)(callbackQuery);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Ошибка при изменении статуса автопродления: ${errorMessage}`);

        await bot.answerCallbackQuery(query.id, {
          text: `Ошибка: ${errorMessage}`,
          show_alert: true
        });

        // Возвращаемся к управлению подпиской
        const callbackQuery = {
          ...query,
          data: `manage_sub_${subscriptionId}`
        };

        await handleCallbackQuery(bot)(callbackQuery);
      }
    } else if (callbackData === 'payment_history') {
      // Обработка запроса на просмотр истории платежей
      try {
        const user = await prisma.user.findUnique({
          where: { telegramId: BigInt(query.from?.id || 0) }
        });

        if (!user) {
          await bot.sendMessage(chatId, 'Пожалуйста, используйте /start для начала работы с ботом.');
          return;
        }

        // Получаем историю платежей
        const payments = await prisma.payment.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
          take: 10
        });

        if (payments.length === 0) {
          const noPaymentsMessage = `
💳 *История платежей*

У вас пока нет платежей.
          `;

          const keyboard = {
            reply_markup: {
              inline_keyboard: [
                [{ text: '💳 Купить подписку', callback_data: 'buy' }],
                [{ text: '🔙 Назад', callback_data: 'profile' }]
              ]
            },
            parse_mode: 'Markdown' as TelegramBot.ParseMode
          };

          await bot.editMessageText(noPaymentsMessage, {
            chat_id: chatId,
            message_id: messageId,
            ...keyboard
          });
          return;
        }

        // Формируем сообщение с историей платежей
        let paymentHistoryMessage = `
💳 *История платежей*

`;

        for (const payment of payments) {
          const date = new Date(payment.createdAt).toLocaleDateString();
          const time = new Date(payment.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const status = payment.status === 'SUCCEEDED'
              ? '✅ Оплачен'
              : payment.status === 'PENDING'
                  ? '⏳ В обработке'
                  : '❌ Отменен';

          paymentHistoryMessage += `${date} ${time} - ${payment.amount} ${payment.currency} ${status}\n`;

          // Если есть описание платежа, добавляем его
          if (payment.description) {
            paymentHistoryMessage += `└ ${payment.description}\n`;
          }

          // Добавляем разделитель между платежами
          if (payments.indexOf(payment) < payments.length - 1) {
            paymentHistoryMessage += `──────────────\n`;
          }
        }

        const keyboard = {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Назад', callback_data: 'profile' }]
            ]
          },
          parse_mode: 'Markdown' as TelegramBot.ParseMode
        };

        await bot.editMessageText(paymentHistoryMessage, {
          chat_id: chatId,
          message_id: messageId,
          ...keyboard
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Ошибка при получении истории платежей: ${errorMessage}`);

        await bot.editMessageText(
            `❌ Произошла ошибка при получении истории платежей: ${errorMessage}\n\nПожалуйста, попробуйте позже.`,
            {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[{ text: '🔙 Назад', callback_data: 'profile' }]]
              }
            }
        );
      }
    } else if (callbackData === 'settings') {
      // Обработка запроса на просмотр настроек пользователя
      try {
        const user = await prisma.user.findUnique({
          where: { telegramId: BigInt(query.from?.id || 0) }
        });

        if (!user) {
          await bot.sendMessage(chatId, 'Пожалуйста, используйте /start для начала работы с ботом.');
          return;
        }

        const settingsMessage = `
⚙️ *Настройки профиля*

Язык: ${user.language === 'ru' ? 'Русский 🇷🇺' : 'English 🇬🇧'}

Выберите действие:
        `;

        const keyboard = {
          reply_markup: {
            inline_keyboard: [
              [{
                text: user.language === 'ru' ? 'Сменить на English 🇬🇧' : 'Change to Русский 🇷🇺',
                callback_data: `change_language_${user.language === 'ru' ? 'en' : 'ru'}`
              }],
              [{ text: '🔙 Назад', callback_data: 'profile' }]
            ]
          },
          parse_mode: 'Markdown' as TelegramBot.ParseMode
        };

        await bot.editMessageText(settingsMessage, {
          chat_id: chatId,
          message_id: messageId,
          ...keyboard
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Ошибка при запросе настроек пользователя: ${errorMessage}`);

        await bot.editMessageText(
            `❌ Произошла ошибка при получении настроек: ${errorMessage}\n\nПожалуйста, попробуйте позже.`,
            {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[{ text: '🔙 Назад', callback_data: 'profile' }]]
              }
            }
        );
      }
    } else if (callbackData.startsWith('change_language_')) {
      // Обработка запроса на изменение языка
      const newLanguage = callbackData.replace('change_language_', '');

      try {
        // Находим пользователя
        const user = await prisma.user.findUnique({
          where: { telegramId: BigInt(query.from?.id || 0) }
        });

        if (!user) {
          await bot.sendMessage(chatId, 'Пожалуйста, используйте /start для начала работы с ботом.');
          return;
        }

        // Обновляем язык пользователя
        await prisma.user.update({
          where: { id: user.id },
          data: { language: newLanguage }
        });

        // Отправляем сообщение об успешном обновлении
        const successMessage = newLanguage === 'ru'
            ? '✅ Язык успешно изменен на Русский'
            : '✅ Language successfully changed to English';

        await bot.answerCallbackQuery(query.id, {
          text: successMessage,
          show_alert: true
        });

        // Возвращаемся в настройки для отображения обновленной информации
        const callbackQuery = {
          ...query,
          data: 'settings'
        };

        await handleCallbackQuery(bot)(callbackQuery);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Ошибка при изменении языка: ${errorMessage}`);

        await bot.answerCallbackQuery(query.id, {
          text: `Ошибка: ${errorMessage}`,
          show_alert: true
        });

        // Возвращаемся в настройки
        const callbackQuery = {
          ...query,
          data: 'settings'
        };

        await handleCallbackQuery(bot)(callbackQuery);
      }
    } else if (callbackData.startsWith('enable_auto_renewal_')) {
      // Обработка включения автопродления
      const subscriptionId = parseInt(callbackData.replace('enable_auto_renewal_', ''), 10);
      await handleEnableAutoRenewal(bot, chatId, messageId, subscriptionId);
    } else if (callbackData.startsWith('disable_auto_renewal_')) {
      // Обработка отключения автопродления
      const subscriptionId = parseInt(callbackData.replace('disable_auto_renewal_', ''), 10);
      await handleDisableAutoRenewal(bot, chatId, messageId, subscriptionId);
    } else if (callbackData.startsWith('renew_subscription_')) {
      // Обработка продления подписки
      const subscriptionId = parseInt(callbackData.replace('renew_subscription_', ''), 10);
      await handleRenewSubscription(bot, chatId, messageId, subscriptionId);
    } else if (callbackData === 'gift_subscription') {
      // Обработка запроса на создание подарочной подписки
      await handleGiftSubscription(bot, chatId, messageId);
    } else if (callbackData.startsWith('gift_')) {
      // Обработка выбора периода для подарочной подписки
      const period = callbackData.replace('gift_', '');

      let subscriptionPeriod: SubscriptionPeriod;
      switch (period) {
        case 'monthly':
          subscriptionPeriod = SubscriptionPeriod.MONTHLY;
          break;
        case 'quarterly':
          subscriptionPeriod = SubscriptionPeriod.QUARTERLY;
          break;
        case 'annual':
          subscriptionPeriod = SubscriptionPeriod.ANNUAL;
          break;
        default:
          subscriptionPeriod = SubscriptionPeriod.MONTHLY;
      }

      await handleRequestGiftRecipient(bot, chatId, messageId, subscriptionPeriod);
    } else if (callbackData.startsWith('redeem_gift_')) {
      // Обработка активации подарочной подписки
      const giftSubscriptionId = parseInt(callbackData.replace('redeem_gift_', ''), 10);
      await handleRedeemGift(bot, chatId, messageId, giftSubscriptionId, query.from?.id || 0);
    } else if (callbackData.startsWith('refresh_config_')) {
      // Обработка запроса на обновление конфигурации
      const subscriptionId = parseInt(callbackData.replace('refresh_config_', ''), 10);
      await handleRefreshConfig(bot, chatId, messageId, subscriptionId, query.from?.id || 0);
    } else if (callbackData.startsWith('gift_pay_yookassa_telegram_')) {
      const parts = callbackData.replace('gift_pay_yookassa_telegram_', '').split('_');
      const planType = parts[0];
      const recipientTelegramId = parts[1];
      
      let period: SubscriptionPeriod;
      switch (planType) {
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

      try {
        // Находим отправителя и получателя
        const sender = await prisma.user.findUnique({
          where: { telegramId: BigInt(query.from?.id || 0) }
        });

        const recipient = await prisma.user.findUnique({
          where: { telegramId: BigInt(recipientTelegramId) }
        });

        if (!sender || !recipient) {
          await bot.sendMessage(chatId, 'Пользователь не найден. Пожалуйста, попробуйте снова.');
          return;
        }

        // Отправляем сообщение о создании платежа
        await bot.editMessageText(`⏳ Создаю счет на оплату подарочной подписки...`, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown'
        });

        // Создаем запись о подарочной подписке
        const giftSubscription = await prisma.giftSubscription.create({
          data: {
            senderId: sender.id,
            recipientId: recipient.id,
            period,
            status: 'PENDING',
            createdAt: new Date()
          }
        });

        // Импортируем сервис оплаты и создаем платеж
        const { createYookassaTelegramPayment } = require('../../services/yookassaTelegramPayments');
        const paymentResult = await createYookassaTelegramPayment(bot, chatId, sender, period, {
          isGift: true,
          recipientId: recipient.id,
          giftSubscriptionId: giftSubscription.id
        });

        if (!paymentResult.success) {
          logger.error(`Ошибка при создании платежа для подарка через ЮKassa: ${paymentResult.error}`);
          
          // Удаляем созданную подарочную подписку
          await prisma.giftSubscription.delete({
            where: { id: giftSubscription.id }
          });
          
          await bot.editMessageText(
            `❌ Ошибка при создании платежа. Пожалуйста, выберите другой способ оплаты или попробуйте позже.\n\nДетали ошибки: ${paymentResult.error}`,
            {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '💳 Оплатить картой', callback_data: `gift_pay_card_${period}_${recipientTelegramId}` }],
                  [{ text: '🔙 Назад', callback_data: 'gift_subscription' }]
                ]
              }
            }
          );
          return;
        }

        // Платежная ссылка отправлена в сообщении, показываем сообщение об успехе
        await bot.editMessageText(
          `✅ Счет на оплату подарочной подписки отправлен. Пожалуйста, нажмите на кнопку в сообщении выше для завершения оплаты.`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔙 Назад', callback_data: 'gift_subscription' }]
              ]
            }
          }
        );
      } catch (error: any) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Ошибка при обработке платежа подарка через ЮKassa: ${errorMessage}`);

        await bot.editMessageText(
          `❌ Произошла ошибка при создании платежа: ${errorMessage}\n\nПожалуйста, попробуйте позже или обратитесь в поддержку.`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Назад', callback_data: 'gift_subscription' }]]
            }
          }
        );
      }
    } else if (callbackData.startsWith('select_renewal_period_')) {
      // Обрабатываем выбор периода для продления
      const parts = callbackData.replace('select_renewal_period_', '').split('_');
      const periodStr = parts[0];
      const subscriptionId = parseInt(parts[1], 10);
      
      // Преобразуем строку периода в enum
      let period: SubscriptionPeriod;
      switch (periodStr) {
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
      
      // Передаем управление на выбор способа оплаты с указанием ID подписки
      await handleSelectPaymentMethod(bot, chatId, messageId, period, subscriptionId);
    } else if (callbackData === 'check_payment') {
      // Разбираем данные callback
      const parts = callbackData.split('_');
      
      if (parts.length === 3) {
        const paymentId = parts[2];
        logger.info(`Запрос на проверку статуса платежа: ${paymentId}`);
        
        // Отправляем сообщение о начале проверки
        const loadingMessage = await bot.sendMessage(
          chatId, 
          '⏳ Проверяем статус платежа...',
          { reply_to_message_id: messageId }
        );
        
        try {
          // Импортируем функцию проверки статуса
          const { checkPaymentStatus } = require('../../services/payment');
          
          // Проверяем статус платежа
          const status = await checkPaymentStatus(paymentId);
          
          // Обновляем сообщение в зависимости от статуса
          if (status === 'SUCCEEDED') {
            // Обработка успешного платежа
            await bot.editMessageText(
              '✅ Платеж успешно завершен! Ваша подписка активирована.\n\nИспользуйте команду /subscription для просмотра деталей.',
              { 
                chat_id: chatId, 
                message_id: loadingMessage.message_id,
                parse_mode: 'Markdown'
              }
            );
          } else if (status === 'PENDING') {
            // Платеж в процессе
            await bot.editMessageText(
              '⏱ Платеж в обработке. Это может занять несколько минут.\n\nВы можете проверить статус снова через некоторое время.',
              { 
                chat_id: chatId, 
                message_id: loadingMessage.message_id,
                reply_markup: {
                  inline_keyboard: [
                    [{ text: '🔄 Проверить снова', callback_data: `check_payment_${paymentId}` }]
                  ]
                }
              }
            );
          } else {
            // Платеж отменен или не удался
            await bot.editMessageText(
              '❌ Платеж не удался или был отменен.\n\nПожалуйста, попробуйте оплатить снова или выберите другой способ оплаты.',
              { 
                chat_id: chatId, 
                message_id: loadingMessage.message_id,
                reply_markup: {
                  inline_keyboard: [
                    [{ text: '🔙 Вернуться к тарифам', callback_data: 'buy' }]
                  ]
                }
              }
            );
          }
        } catch (error) {
          logger.error(`Ошибка при проверке статуса платежа: ${error}`);
          
          // Обновляем сообщение об ошибке
          await bot.editMessageText(
            '⚠️ Произошла ошибка при проверке статуса платежа.\n\nПожалуйста, попробуйте позже или свяжитесь с поддержкой.',
            { 
              chat_id: chatId, 
              message_id: loadingMessage.message_id,
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔄 Попробовать снова', callback_data: `check_payment_${paymentId}` }],
                  [{ text: '🔙 Вернуться к тарифам', callback_data: 'buy' }]
                ]
              }
            }
          );
        }
        return;
      }
    } else if (callbackData.startsWith('pay_gift_telegram_')) {
      // Обработка оплаты подарочной подписки через Telegram (ЮKassa)
      const giftSubscriptionId = parseInt(callbackData.replace('pay_gift_telegram_', ''), 10);

      try {
        // Находим пользователя
        const user = await prisma.user.findUnique({
          where: { telegramId: BigInt(query.from?.id || 0) }
        });

        if (!user) {
          await bot.sendMessage(chatId, 'Пожалуйста, используйте /start для начала работы с ботом.');
          return;
        }

        // Находим подарочную подписку
        const giftSubscription = await prisma.giftSubscription.findUnique({
          where: { id: giftSubscriptionId },
          // include: { recipient: true }
        });

        if (!giftSubscription) {
          throw new Error('Подарочная подписка не найдена');
        }

        // Проверяем, что пользователь является отправителем подарка
        if (giftSubscription.senderId !== user.id) {
          throw new Error('Вы не являетесь отправителем этого подарка');
        }

        // Определяем период подписки
        let period: SubscriptionPeriod;
        switch (giftSubscription.period) {
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

        // Информируем пользователя о подготовке платежа
        await bot.editMessageText(`⏳ Подготовка платежа через Telegram...`, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown'
        });

        // Создаем платеж через Telegram
        const result = await createTelegramDirectPayment(
          bot,
          chatId,
          user,
          period,
          {
            isGift: true,
            giftSubscriptionId: giftSubscription.id,
            recipientId: giftSubscription.recipientId
          }
        );

        if (!result.success) {
          throw new Error(result.error || 'Не удалось создать платеж');
        }

        // Платеж уже создан и отправлен пользователю через инвойс
        logger.info(`Создан платеж подарочной подписки через Telegram: ${result.paymentId}`);
      } catch (error: any) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Ошибка при создании платежа подарочной подписки через Telegram: ${errorMessage}`);

        await bot.editMessageText(
          `❌ Произошла ошибка при подготовке платежа: ${errorMessage}\n\nПожалуйста, попробуйте позже или выберите другой способ оплаты.`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Назад', callback_data: 'gift_subscription' }]]
            }
          }
        );
      }
    }
    // Здесь можно добавить обработку других callback_data

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : 'Стек недоступен';

    logger.error(`Ошибка при обработке callback query: ${errorMessage}`);
    logger.debug(`Стек ошибки: ${stack}`);

    if (query.message?.chat.id) {
      try {
        bot.sendMessage(
            query.message.chat.id,
            '😞 Произошла ошибка при обработке запроса. Пожалуйста, попробуйте позже или обратитесь в поддержку.',
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔙 Главное меню', callback_data: 'main_menu' }]
                ]
              }
            }
        );
      } catch (sendError) {
        logger.error(`Не удалось отправить сообщение об ошибке: ${sendError}`);
      }
    }
  }
};

/**
 * Обработчик для включения автопродления подписки
 */
async function handleEnableAutoRenewal(
    bot: TelegramBot,
    chatId: number,
    messageId: number,
    subscriptionId: number
): Promise<void> {
  try {
    // Получаем пользователя по Telegram ID
    const user = await prisma.user.findFirst({
      where: { telegramId: BigInt(chatId) }
    });

    if (!user) {
      await bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.');
      return;
    }

    // Получаем подписку и проверяем, что она принадлежит пользователю
    const subscription = await prisma.subscription.findFirst({
      where: {
        id: subscriptionId,
        userId: user.id
      },
      include: {
        vpnServer: true
      }
    });

    if (!subscription) {
      await bot.sendMessage(chatId, '❌ Ошибка: подписка не найдена или не принадлежит вам.');
      return;
    }

    // Включаем автопродление
    const result = await subscriptionService.enableAutoRenewal(subscriptionId);

    if (result.success) {
      await bot.editMessageText(
          '✅ *Автопродление включено*\n\n'
          + 'Ваша подписка будет автоматически продлена при истечении срока действия.\n'
          + 'Вы всегда можете отключить автопродление в разделе "Мои подписки".',
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: 'Отключить автопродление', callback_data: `disable_auto_renewal_${subscriptionId}` }],
                [{ text: 'Назад к подпискам', callback_data: 'subscription' }]
              ]
            }
          }
      );
    } else {
      await bot.sendMessage(chatId, `❌ Ошибка при включении автопродления: ${result.error}`);
    }
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Ошибка при включении автопродления: ${errorMessage}`);
    await bot.sendMessage(chatId, '❌ Произошла ошибка при обработке запроса. Попробуйте позже.');
  }
}

/**
 * Обработчик для отключения автопродления подписки
 */
async function handleDisableAutoRenewal(
    bot: TelegramBot,
    chatId: number,
    messageId: number,
    subscriptionId: number
): Promise<void> {
  try {
    // Получаем пользователя по Telegram ID
    const user = await prisma.user.findFirst({
      where: { telegramId: BigInt(chatId) }
    });

    if (!user) {
      await bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.');
      return;
    }

    // Получаем подписку и проверяем, что она принадлежит пользователю
    const subscription = await prisma.subscription.findFirst({
      where: {
        id: subscriptionId,
        userId: user.id
      },
      include: {
        vpnServer: true
      }
    });

    if (!subscription) {
      await bot.sendMessage(chatId, '❌ Ошибка: подписка не найдена или не принадлежит вам.');
      return;
    }

    // Отключаем автопродление
    const result = await subscriptionService.disableAutoRenewal(subscriptionId);

    if (result.success) {
      await bot.editMessageText(
          '✅ *Автопродление отключено*\n\n'
          + 'Ваша подписка не будет автоматически продлена при истечении срока действия.\n'
          + 'Вы всегда можете включить автопродление в разделе "Мои подписки".',
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: 'Включить автопродление', callback_data: `enable_auto_renewal_${subscriptionId}` }],
                [{ text: 'Назад к подпискам', callback_data: 'subscription' }]
              ]
            }
          }
      );
    } else {
      await bot.sendMessage(chatId, `❌ Ошибка при отключении автопродления: ${result.error}`);
    }
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Ошибка при отключении автопродления: ${errorMessage}`);
    await bot.sendMessage(chatId, '❌ Произошла ошибка при обработке запроса. Попробуйте позже.');
  }
}

/**
 * Обработчик для продления подписки
 */
async function handleRenewSubscription(
    bot: TelegramBot,
    chatId: number,
    messageId: number,
    subscriptionId: number
): Promise<void> {
  try {
    // Получаем пользователя по Telegram ID
    const user = await prisma.user.findFirst({
      where: { telegramId: BigInt(chatId) }
    });

    if (!user) {
      await bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.');
      return;
    }

    // Получаем подписку и проверяем, что она принадлежит пользователю
    const subscription = await prisma.subscription.findFirst({
      where: {
        id: subscriptionId,
        userId: user.id
      },
      include: {
        vpnServer: true
      }
    });

    if (!subscription) {
      await bot.sendMessage(chatId, '❌ Ошибка: подписка не найдена или не принадлежит вам.');
      return;
    }

    // Отправляем меню выбора тарифа для продления
    await bot.editMessageText(
        `🔄 *Продление подписки*\n\n`
        + `Выберите тариф для продления вашей подписки на сервере ${subscription.vpnServer.name}:`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: `1 месяц - ${getPaymentAmount(SubscriptionPeriod.MONTHLY)} ₽`, callback_data: `select_renewal_period_${SubscriptionPeriod.MONTHLY}_${subscriptionId}` }],
              [{ text: `3 месяца - ${getPaymentAmount(SubscriptionPeriod.QUARTERLY)} ₽`, callback_data: `select_renewal_period_${SubscriptionPeriod.QUARTERLY}_${subscriptionId}` }],
              [{ text: `12 месяцев - ${getPaymentAmount(SubscriptionPeriod.ANNUAL)} ₽`, callback_data: `select_renewal_period_${SubscriptionPeriod.ANNUAL}_${subscriptionId}` }],
              [{ text: '🔙 Назад к подпискам', callback_data: 'subscription' }]
            ]
          }
        }
    );
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Ошибка при подготовке продления подписки: ${errorMessage}`);
    await bot.sendMessage(chatId, '❌ Произошла ошибка при обработке запроса. Попробуйте позже.');
  }
}

/**
 * Обработчик для активации подарочной подписки
 */
async function handleRedeemGift(
    bot: TelegramBot,
    chatId: number,
    messageId: number,
    giftSubscriptionId: number,
    telegramId: number
): Promise<void> {
  try {
    // Находим подарочную подписку
    const giftSubscription = await prisma.giftSubscription.findUnique({
      where: { id: giftSubscriptionId },
      // include: {
      // }
    });

    if (!giftSubscription) {
      await bot.editMessageText(
          '❌ Подарочная подписка не найдена или уже была активирована.',
          {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Главное меню', callback_data: 'main_menu' }]]
            }
          }
      );
      return;
    }

    // Проверяем, что подписка в статусе PAID и не активирована
    if (giftSubscription.status !== 'PAID') {
      await bot.editMessageText(
          `❌ Подарочная подписка не может быть активирована (текущий статус: ${giftSubscription.status}).`,
          {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Главное меню', callback_data: 'main_menu' }]]
            }
          }
      );
      return;
    }

    // Проверяем, что получатель совпадает с текущим пользователем
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramId) }
    });

    if (!user || user.id !== giftSubscription.recipientId) {
      await bot.editMessageText(
          '❌ Эта подарочная подписка предназначена для другого пользователя.',
          {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Главное меню', callback_data: 'main_menu' }]]
            }
          }
      );
      return;
    }

    // Информируем пользователя о активации
    await bot.editMessageText(
        '⏳ Активация подарочной подписки...',
        {
          chat_id: chatId,
          message_id: messageId
        }
    );

    // Создаем новую подписку для пользователя
    const vpnService = require('../services/vpn');

    try {
      // Выбираем оптимальный сервер
      const server = await vpnService.selectOptimalServer();

      // Определяем период и длительность подписки
      let period: SubscriptionPeriod;
      switch (giftSubscription.period) {
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

      const durationInDays = getSubscriptionDuration(period);

      // Создаем новую подписку
      const startDate = new Date();
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + durationInDays);

      const subscription = await prisma.subscription.create({
        data: {
          userId: user.id,
          vpnServerId: server.id,
          status: 'ACTIVE',
          startDate,
          endDate,
          autoRenewal: false,
          downloadSpeed: require('../../config').default.defaultDownloadSpeed,
          uploadSpeed: require('../../config').default.defaultUploadSpeed,
          torrentsAllowed: require('../../config').default.torrentAllowed,
          fromReferral: true
        }
      });

      // Генерируем VPN конфигурацию
      await vpnService.generateClientConfig(subscription);

      // Обновляем статус подарочной подписки
      await prisma.giftSubscription.update({
        where: { id: giftSubscriptionId },
        data: {
          status: 'REDEEMED',
          redeemedAt: new Date(),
          subscriptionId: subscription.id
        }
      });

      // Увеличиваем счетчик клиентов на сервере
      await prisma.vpnServer.update({
        where: { id: server.id },
        data: { currentClients: { increment: 1 } }
      });

      // Отправляем уведомление об успешной активации
      await bot.editMessageText(
          `✅ *Подарочная подписка успешно активирована!*\n\n`
          + `Ваша подписка действует до ${endDate.toLocaleDateString()}.\n\n`
          + `Используйте команду /subscription для просмотра деталей и получения конфигурации VPN.`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '📱 Мои подписки', callback_data: 'subscription' }],
                [{ text: '🔙 Главное меню', callback_data: 'main_menu' }]
              ]
            }
          }
      );

      // Отправляем уведомление отправителю
      const sender = await prisma.user.findUnique({
        where: { id: giftSubscription.senderId }
      });

      if (sender) {
        try {
          await bot.sendMessage(
              sender.telegramId.toString(),
              `🎁 Ваша подарочная подписка была успешно активирована получателем!`
          );
        } catch (notifyError) {
          logger.error(`Ошибка при отправке уведомления отправителю подарка: ${notifyError}`);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Ошибка при активации подарочной подписки: ${errorMessage}`);

      await bot.editMessageText(
          `❌ Произошла ошибка при активации подарочной подписки: ${errorMessage}\n\nПожалуйста, попробуйте позже или обратитесь в поддержку.`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Главное меню', callback_data: 'main_menu' }]]
            }
          }
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Ошибка при обработке активации подарка: ${errorMessage}`);

    await bot.sendMessage(
        chatId,
        `❌ Произошла ошибка при обработке запроса: ${errorMessage}\n\nПожалуйста, попробуйте позже или обратитесь в поддержку.`
    );
  }
}

/**
 * Обработчик для обновления конфигурации VPN
 */
async function handleRefreshConfig(
    bot: TelegramBot,
    chatId: number,
    messageId: number,
    subscriptionId: number,
    telegramId: number
): Promise<void> {
  try {
    // Находим подписку
    const subscription = await prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        user: true,
        vpnServer: true
      }
    });

    if (!subscription) {
      await bot.editMessageText(
          '❌ Подписка не найдена.',
          {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Назад', callback_data: 'subscription' }]]
            }
          }
      );
      return;
    }

    // Проверяем, что подписка принадлежит пользователю
    if (subscription.user.telegramId !== BigInt(telegramId)) {
      await bot.editMessageText(
          '⛔ У вас нет доступа к этой подписке.',
          {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Назад', callback_data: 'subscription' }]]
            }
          }
      );
      return;
    }

    // Информируем о начале обновления
    await bot.editMessageText(
        '⏳ Обновление VPN конфигурации...',
        {
          chat_id: chatId,
          message_id: messageId
        }
    );

    // Обновляем конфигурацию
    await generateClientConfig(subscription);

    // Получаем обновленную подписку
    const updatedSubscription = await prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        user: true,
        vpnServer: true
      }
    });

    if (!updatedSubscription || !updatedSubscription.vpnConfig) {
      await bot.editMessageText(
          '❌ Не удалось обновить конфигурацию. Пожалуйста, попробуйте позже или обратитесь в поддержку.',
          {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Назад', callback_data: 'subscription' }]]
            }
          }
      );
      return;
    }

    // Отправляем сообщение об успешном обновлении
    await bot.editMessageText(
        '✅ VPN конфигурация успешно обновлена!\n\n'
        + 'Ваша конфигурация была обновлена. Нажмите кнопку ниже, чтобы получить новую конфигурацию.',
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [
              [{ text: '📥 Получить новую конфигурацию', callback_data: `get_config_${subscriptionId}` }],
              [{ text: '🔙 Назад к подпискам', callback_data: 'subscription' }]
            ]
          }
        }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Ошибка при обновлении конфигурации: ${errorMessage}`);

    await bot.editMessageText(
        `❌ Произошла ошибка при обновлении конфигурации: ${errorMessage}\n\nПожалуйста, попробуйте позже или обратитесь в поддержку.`,
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [[{ text: '🔙 Назад', callback_data: 'subscription' }]]
          }
        }
    );
  }
}

// Добавляем обработчики для Telegram-платежей

/**
 * Обработчик для pre_checkout_query от Telegram
 * Должен быть добавлен как обработчик события 'pre_checkout_query' в основном файле бота
 * 
 * @param bot Экземпляр Telegram бота
 */
export const handlePreCheckoutQuery = (bot: TelegramBot) => async (query: TelegramBot.PreCheckoutQuery): Promise<void> => {
  try {
    logger.info(`Получен pre_checkout_query от пользователя ${query.from.id}: ${JSON.stringify(query)}`);

    // Пытаемся разобрать payload
    let payloadData: any = {};
    try {
      payloadData = JSON.parse(query.invoice_payload);
    } catch (parseError) {
      logger.error(`Ошибка при разборе payload pre_checkout_query: ${parseError}`);
      await answerPreCheckoutQuery(bot, query.id, false, 'Невозможно обработать данные платежа' );
      return;
    }

    // Проверяем наличие обязательных полей
    if (!payloadData.userId || !payloadData.subscriptionPeriod) {
      logger.error(`Отсутствуют обязательные поля в payload: ${JSON.stringify(payloadData)}`);
      await answerPreCheckoutQuery(bot, query.id, false, 'Неверные данные платежа' );
      return;
    }

    // Проверяем существование пользователя
    const userId = parseInt(payloadData.userId, 10);
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      logger.error(`Пользователь с ID ${userId} не найден при обработке pre_checkout_query`);
      await answerPreCheckoutQuery(bot, query.id, false, 'Пользователь не найден' );
      return;
    }

    // Если всё в порядке, подтверждаем платёж
    await answerPreCheckoutQuery(bot, query.id, true);
    logger.info(`Pre-checkout query ${query.id} успешно подтвержден`);

  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Ошибка при обработке pre_checkout_query: ${errorMessage}`);

    // Отклоняем платёж при ошибке
    try {
      await answerPreCheckoutQuery(bot, query.id, false, 'Произошла ошибка при обработке платежа' );
    } catch (replyError) {
      logger.error(`Не удалось ответить на pre_checkout_query: ${replyError}`);
    }
  }
};
/**
 * Обработчик successful_payment от Telegram
 */
export const handleSuccessfulPayment = (bot: TelegramBot) => async (message: TelegramBot.Message): Promise<void> => {
  try {
    if (!message.successful_payment) {
      logger.error('Получено сообщение без successful_payment');
      return;
    }
    
    logger.info(`Получено уведомление о successful_payment: ${message.successful_payment.invoice_payload}`);
    
    // Обрабатываем успешный платеж через новый сервис
    const yookassaTelegram = await import('../../services/yookassaTelegramPayments');
    await yookassaTelegram.handleSuccessfulYookassaTelegramPayment(message.successful_payment);
    
    logger.info('Успешный платеж обработан');
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Ошибка при обработке successful_payment: ${errorMessage}`);
    
    // Отправляем сообщение администратору об ошибке
    if (config.adminChatId) {
    try {

      await bot.sendMessage(
        message.chat.id.toString(),
        '❌ Произошла ошибка при обработке вашего платежа. Пожалуйста, обратитесь в поддержку.'
      );
    } catch (sendError) {
      logger.error(`Не удалось отправить сообщение об ошибке: ${sendError}`);
    }
    }
  }
};