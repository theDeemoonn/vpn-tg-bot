import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import config from './config';
import { createServer } from 'http';
import { handlePaymentWebhook } from './services/payment';
import logger from './utils/logger';
import * as subscriptionService from './services/subscription';
import TelegramBot from 'node-telegram-bot-api';
import bot, { startBot } from './bot';
import { prisma } from './services/database';
import { handleSuccessfulTelegramPayment } from './services/telegramPayments';
import { validateYookassaWebhook } from './middlewares/yookassaWebhookAuth';
import { startPaymentChecker } from './services/paymentChecker';

// Загружаем переменные окружения
dotenv.config();

// Обработчик необработанных исключений
process.on('uncaughtException', (error: Error) => {
  logger.error(`Необработанное исключение: ${error.message}`, { error });
  
  // Завершаем процесс с ошибкой
  process.exit(1);
});

// Обработчик необработанных исключений в Promise
process.on('unhandledRejection', (reason: Error | any) => {
  logger.error(`Необработанное отклонение Promise: ${reason.message || 'Неизвестная ошибка'}`, { error: reason });
});

async function startServer() {
  try {
    logger.info('Запуск сервера...');
    
    // Инициализируем Express
    const app = express();
    app.use(express.json());
    app.use(cors()); // Добавляем поддержку CORS для API
    
    // Инициализируем Telegram бота
    await startBot();
    
    // Настраиваем обработчики веб-запросов для платежей
    app.post('/payment/webhook', 
      process.env.NODE_ENV === 'production' ? validateYookassaWebhook : (req, res, next) => next(),
      async (req, res) => {
        try {
          logger.info(`Получен webhook на /payment/webhook: ${JSON.stringify(req.body)}`);
          await handlePaymentWebhook(req.body);
          res.status(200).send('OK');
        } catch (error) {
          logger.error(`Ошибка в обработке webhook: ${error}`);
          res.status(500).send('Internal Server Error');
        }
      }
    );
    
    // Добавляем альтернативный маршрут для обратной совместимости
    app.post('/webhooks/payment', 
      process.env.NODE_ENV === 'production' ? validateYookassaWebhook : (req, res, next) => next(),
      async (req, res) => {
        try {
          logger.info(`Получен webhook на /webhooks/payment: ${JSON.stringify(req.body)}`);
          await handlePaymentWebhook(req.body);
          res.status(200).send('OK');
        } catch (error) {
          logger.error(`Ошибка в обработке webhook по альтернативному URL: ${error}`);
          res.status(500).send('Internal Server Error');
        }
      }
    );
    
    // Настраиваем обработчики событий для Telegram бота
    bot.on('pre_checkout_query', async (query) => {
      logger.info(`Получен pre_checkout_query: ${query.id}, от пользователя: ${query.from.id}`);
      try {
        const payload = JSON.parse(query.invoice_payload);
        logger.debug(`Payload платежа: ${JSON.stringify(payload)}`);
        
        // Проверка данных платежа
        const user = await prisma.user.findUnique({ where: { id: payload.userId } });
        if (!user) {
          logger.error(`Пользователь не найден: ${payload.userId}`);
          await bot.answerPreCheckoutQuery(query.id, false, { 
            error_message: 'Пользователь не найден. Пожалуйста, попробуйте позже или обратитесь в поддержку.' 
          });
          return;
        }
        
        // Здесь можно добавить дополнительные проверки платежа
        
        // Если все проверки прошли успешно, подтверждаем платеж
        logger.info(`Платеж прошел проверку, подтверждаем pre_checkout_query: ${query.id}`);
        await bot.answerPreCheckoutQuery(query.id, true);
      } catch (error: any) {
        // Если возникла ошибка при обработке, отклоняем платеж
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Ошибка при обработке pre_checkout_query: ${errorMessage}`, { error });
        try {
          await bot.answerPreCheckoutQuery(query.id, false, { 
            error_message: 'Произошла ошибка при обработке платежа. Пожалуйста, попробуйте позже.' 
          });
        } catch (answerError: any) {
          logger.error(`Не удалось ответить на pre_checkout_query: ${answerError.message}`, { error: answerError });
        }
      }
    });
    
    // Обработчик успешного платежа
    bot.on('successful_payment', async (msg) => {
      try {
        if (!msg.from) {
          logger.error('Получен successful_payment без информации об отправителе');
          return;
        }
        
        logger.info(`Получено уведомление об успешном платеже от пользователя: ${msg.from.id}`);
        const payment = msg.successful_payment;
        
        if (!payment) {
          logger.error('Получен successful_payment без данных о платеже');
          return;
        }
        
        logger.debug(`Данные платежа: ${JSON.stringify(payment)}`);
        
        try {
          // Парсим payload платежа
          const payload = JSON.parse(payment.invoice_payload);
          
          // Обрабатываем успешный платеж
          await handleSuccessfulTelegramPayment(payload, payment.total_amount / 100);
          
          // Отправляем уведомление пользователю
          await bot.sendMessage(
            msg.from.id,
            'Спасибо! Ваш платеж успешно обработан. Подписка активирована.'
          );
        } catch (payloadError: any) {
          logger.error(`Ошибка при обработке данных платежа: ${payloadError.message}`, { error: payloadError });
          
          // Отправляем сообщение об ошибке пользователю
          await bot.sendMessage(
            msg.from.id,
            'Платеж получен, но возникла ошибка при обработке. Наши специалисты проверят ситуацию и активируют вашу подписку в ближайшее время. Если проблема не решится в течение 15 минут, пожалуйста, обратитесь в поддержку.'
          );
        }
      } catch (error: any) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Ошибка при обработке successful_payment: ${errorMessage}`, { error });
      }
    });
    
    // Подключаем API маршруты
    // TODO: require('./routes')(app);
    
    // Запускаем сервер
    const server = createServer(app);
    server.listen(config.port, config.host, async () => {
      logger.info(`Сервер запущен на http://${config.host}:${config.port}`);
      
      // Запускаем проверку платежей
      startPaymentChecker().catch(error => {
        logger.error(`Ошибка при запуске проверки платежей: ${error}`);
      });
      
      // Проверка и обновление статусов подписок
      // TODO: Реализовать функцию startSubscriptionChecker в subscriptionService
      // await subscriptionService.startSubscriptionChecker();
    });
    
    // Запускаем планировщик проверки подписок
    // subscriptionService.startSubscriptionChecker();
    // Раскомментируйте эту строку, когда функция будет реализована
    
  } catch (error: any) {
    logger.error(`Ошибка при запуске сервера: ${error.message}`, { error });
    process.exit(1);
  }
}

// Запускаем сервер
startServer(); 