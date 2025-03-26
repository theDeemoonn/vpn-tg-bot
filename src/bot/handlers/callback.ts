import TelegramBot, { CallbackQuery, Message } from 'node-telegram-bot-api';
import { prisma } from '../../services/database';
import { createPayment, getPaymentAmount, getSubscriptionDuration, SubscriptionPeriod } from '../../services/payment';
import { generateClientConfig } from '../../services/vpn';
import logger from '../../utils/logger';
import { CallbackQueryHandler } from './types';
import { handleHelp } from './help';
import { handleProfile } from './profile';
import { handleBuy, handleSelectPaymentMethod } from './buy';
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
      return;
    }
    
    // Сначала отправляем acknowledgment для callback query
    await bot.answerCallbackQuery(query.id);
    
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
      await handleSelectPaymentMethod(bot, chatId, messageId, period);
    } else if (callbackData.startsWith('pay_card_')) {
      // Обработка выбора банковской карты
      const planType = callbackData.replace('pay_card_', '');
      
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
      
      // Находим пользователя
      const user = await prisma.user.findUnique({
        where: { telegramId: BigInt(query.from?.id || 0) }
      });
      
      if (!user) {
        bot.sendMessage(chatId, 'Пожалуйста, используйте /start для начала работы с ботом.');
        return;
      }
      
      // Создаем URL для оплаты
      const returnUrl = `https://t.me/${(await bot.getMe()).username}`;
      const paymentUrl = await createPayment(user, period, returnUrl);
      
      // Отправляем сообщение с ссылкой на оплату
      const paymentMessage = `
💳 *Оплата подписки*

Тариф: ${period === SubscriptionPeriod.MONTHLY ? 'Месячный' :
        period === SubscriptionPeriod.QUARTERLY ? 'Квартальный' : 'Годовой'}
Сумма: ${getPaymentAmount(period)} ₽
Длительность: ${getSubscriptionDuration(period)} дней

Для оплаты нажмите на кнопку ниже 👇
      `;
      
      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '💰 Перейти к оплате', url: paymentUrl }],
            [{ text: '🔙 Назад', callback_data: 'buy' }]
          ]
        },
        parse_mode: 'Markdown' as TelegramBot.ParseMode
      };
      
      await bot.editMessageText(paymentMessage, {
        chat_id: chatId,
        message_id: messageId,
        ...keyboard
      });
    } else if (callbackData.startsWith('pay_telegram_')) {
      // Обработка выбора оплаты через Telegram Payments
      const planType = callbackData.replace('pay_telegram_', '');
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
      
      // Находим пользователя
      const user = await prisma.user.findUnique({
        where: { telegramId: BigInt(query.from?.id || 0) }
      });
      
      if (!user) {
        bot.sendMessage(chatId, 'Пожалуйста, используйте /start для начала работы с ботом.');
        return;
      }
      
      try {
        // Импортируем функцию создания инвойса
        const { createTelegramInvoice } = require('../../services/telegramPayments');
        
        // Создаем инвойс для оплаты через Telegram
        const invoiceResult = await createTelegramInvoice(bot, chatId, user, period);
        
        if (!invoiceResult.success) {
          logger.error(`Ошибка при создании инвойса: ${invoiceResult.error}`);
          await bot.sendMessage(chatId, `❌ Ошибка при создании платежа: ${invoiceResult.error}`);
          return;
        }
        
        logger.info(`Создан инвойс Telegram Payments для пользователя ${user.telegramId}`);
        
        // Отправляем сообщение с информацией о платеже
        await bot.sendMessage(chatId, `✅ Счет на оплату отправлен. Пожалуйста, следуйте инструкциям для завершения платежа.`);
      } catch (error) {
        logger.error(`Ошибка при обработке оплаты через Telegram: ${error instanceof Error ? error.message : String(error)}`);
        await bot.sendMessage(chatId, '❌ Произошла ошибка при обработке платежа. Пожалуйста, попробуйте другой способ оплаты.');
      }
    } else if (callbackData.startsWith('get_config_')) {
      // Обработка запроса на получение конфигурации
      const subscriptionId = parseInt(callbackData.replace('get_config_', ''), 10);
      
      // Находим подписку
      const subscription = await prisma.subscription.findUnique({
        where: { id: subscriptionId },
        include: {
          user: true,
          vpnServer: true
        }
      });
      
      if (!subscription) {
        bot.sendMessage(chatId, '❌ Подписка не найдена.');
        return;
      }
      
      // Проверяем, что подписка принадлежит пользователю
      if (subscription.user.telegramId !== BigInt(query.from?.id || 0)) {
        bot.sendMessage(chatId, '⛔ У вас нет доступа к этой подписке.');
        return;
      }
      
      // Если конфигурация не существует, генерируем ее
      if (!subscription.vpnConfig) {
        await generateClientConfig(subscription);
        
        // Получаем обновленную подписку с конфигурацией
        const updatedSubscription = await prisma.subscription.findUnique({
          where: { id: subscriptionId },
          include: {
            user: true,
            vpnServer: true
          }
        });
        
        if (!updatedSubscription || !updatedSubscription.vpnConfig) {
          bot.sendMessage(chatId, '❌ Не удалось сгенерировать конфигурацию.');
          return;
        }
        
        subscription.vpnConfig = updatedSubscription.vpnConfig;
      }
      
      // Отправляем конфигурацию пользователю в виде файла
      const configBuffer = Buffer.from(subscription.vpnConfig);
      
      const fileOptions = {
        filename: `vpn_config_${subscription.id}.json`,
        contentType: 'application/json'
      };
      
      await bot.sendDocument(chatId, configBuffer, {
        caption: '🔐 Ваша VPN конфигурация готова! Импортируйте этот файл в клиент Xray.'
      }, fileOptions);
      
      // Генерируем и отправляем QR-код для конфигурации
      try {
        // Генерируем QR-код для конфигурации
        const qrCodePath = await qrcodeService.generateVpnConfigQrCode(
          subscription.vpnConfig,
          subscription.userId,
          subscription.id
        );
        
        // Отправляем QR-код
        await bot.sendPhoto(chatId, qrCodePath, {
          caption: '📱 Отсканируйте этот QR-код мобильным приложением для быстрой настройки VPN.'
        });
        
        // Удаляем временный файл QR-кода
        qrcodeService.removeQrCodeFile(qrCodePath);
      } catch (error: any) {
        logger.error(`Ошибка при генерации QR-кода: ${error instanceof Error ? error.message : String(error)}`);
        // Не прерываем выполнение, так как основная конфигурация уже отправлена
      }
      
      // Отправляем инструкции по установке
      const instructionMessage = `
📝 *Инструкции по установке:*

1. Установите клиент Xray для вашего устройства
2. Импортируйте файл конфигурации или отсканируйте QR-код
3. Подключитесь к VPN

Для более подробных инструкций воспользуйтесь командой /help
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
      });
    } else if (callbackData.startsWith('manage_sub_')) {
      // Обработка запроса на управление подпиской
      const subscriptionId = parseInt(callbackData.replace('manage_sub_', ''), 10);
      
      // Находим подписку
      const subscription = await prisma.subscription.findUnique({
        where: { id: subscriptionId },
        include: {
          user: true,
          vpnServer: true
        }
      });
      
      if (!subscription) {
        bot.sendMessage(chatId, '❌ Подписка не найдена.');
        return;
      }
      
      // Проверяем, что подписка принадлежит пользователю
      if (subscription.user.telegramId !== BigInt(query.from?.id || 0)) {
        bot.sendMessage(chatId, '⛔ У вас нет доступа к этой подписке.');
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
    } else if (callbackData.startsWith('show_sub_')) {
      // Обработка запроса на просмотр информации о подписке
      const subscriptionId = parseInt(callbackData.replace('show_sub_', ''), 10);
      
      // Находим подписку
      const subscription = await prisma.subscription.findUnique({
        where: { id: subscriptionId },
        include: {
          user: true,
          vpnServer: true
        }
      });
      
      if (!subscription) {
        bot.sendMessage(chatId, '❌ Подписка не найдена.');
        return;
      }
      
      // Проверяем, что подписка принадлежит пользователю
      if (subscription.user.telegramId !== BigInt(query.from?.id || 0)) {
        bot.sendMessage(chatId, '⛔ У вас нет доступа к этой подписке.');
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
    } else if (callbackData.startsWith('auto_renewal_')) {
      // Обработка запроса на изменение статуса автопродления
      const parts = callbackData.split('_');
      const subscriptionId = parseInt(parts[2], 10);
      const newStatus = parts[3] === 'true';
      
      // Обновляем статус автопродления
      await prisma.subscription.update({
        where: { id: subscriptionId },
        data: { autoRenewal: newStatus }
      });
      
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
    } else if (callbackData === 'payment_history') {
      // Обработка запроса на просмотр истории платежей
      const user = await prisma.user.findUnique({
        where: { telegramId: BigInt(query.from?.id || 0) }
      });
      
      if (!user) {
        bot.sendMessage(chatId, 'Пожалуйста, используйте /start для начала работы с ботом.');
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
        const time = new Date(payment.createdAt).toLocaleTimeString();
        const status = payment.status === 'SUCCEEDED' 
          ? '✅ Оплачен' 
          : payment.status === 'PENDING' 
            ? '⏳ В обработке' 
            : '❌ Отменен';
        
        paymentHistoryMessage += `${date} ${time} - ${payment.amount} ${payment.currency} ${status}\n`;
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
    } else if (callbackData === 'settings') {
      // Обработка запроса на просмотр настроек пользователя
      const user = await prisma.user.findUnique({
        where: { telegramId: BigInt(query.from?.id || 0) }
      });
      
      if (!user) {
        bot.sendMessage(chatId, 'Пожалуйста, используйте /start для начала работы с ботом.');
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
    } else if (callbackData.startsWith('change_language_')) {
      // Обработка запроса на изменение языка
      const newLanguage = callbackData.replace('change_language_', '');
      
      // Находим пользователя
      const user = await prisma.user.findUnique({
        where: { telegramId: BigInt(query.from?.id || 0) }
      });
      
      if (!user) {
        bot.sendMessage(chatId, 'Пожалуйста, используйте /start для начала работы с ботом.');
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
    }
    // Здесь можно добавить обработку других callback_data
    
  } catch (error) {
    logger.error(`Ошибка при обработке callback query: ${error}`);
    if (query.message?.chat.id) {
      bot.sendMessage(query.message.chat.id, '😞 Произошла ошибка. Пожалуйста, попробуйте позже.');
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
              [{ text: 'Назад к подпискам', callback_data: 'my_subscriptions' }]
            ]
          }
        }
      );
    } else {
      await bot.sendMessage(chatId, `❌ Ошибка при включении автопродления: ${result.error}`);
    }
  } catch (error: any) {
    logger.error(`Ошибка при включении автопродления: ${error instanceof Error ? error.message : String(error)}`);
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
              [{ text: 'Назад к подпискам', callback_data: 'my_subscriptions' }]
            ]
          }
        }
      );
    } else {
      await bot.sendMessage(chatId, `❌ Ошибка при отключении автопродления: ${result.error}`);
    }
  } catch (error: any) {
    logger.error(`Ошибка при отключении автопродления: ${error instanceof Error ? error.message : String(error)}`);
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
            [{ text: '1 месяц - 300₽', callback_data: `buy_renewal_monthly_${subscriptionId}` }],
            [{ text: '3 месяца - 800₽', callback_data: `buy_renewal_quarterly_${subscriptionId}` }],
            [{ text: '12 месяцев - 2900₽', callback_data: `buy_renewal_annual_${subscriptionId}` }],
            [{ text: 'Назад к подпискам', callback_data: 'my_subscriptions' }]
          ]
        }
      }
    );
  } catch (error: any) {
    logger.error(`Ошибка при подготовке продления подписки: ${error instanceof Error ? error.message : String(error)}`);
    await bot.sendMessage(chatId, '❌ Произошла ошибка при обработке запроса. Попробуйте позже.');
  }
} 