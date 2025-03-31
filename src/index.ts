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
import { validateYookassaWebhook } from './middlewares/yookassaWebhookAuth';
import { startPaymentChecker } from './services/paymentChecker';
import path from 'path';
import apiRoutes from './api';

// Загружаем переменные окружения
dotenv.config();

// Обработчик необработанных исключений
process.on('uncaughtException', (error: Error) => {
  logger.error(`Необработанное исключение: ${error.message}`, { error, stack: error.stack });

  // Завершаем процесс с ошибкой
  process.exit(1);
});

// Обработчик необработанных исключений в Promise
process.on('unhandledRejection', (reason: Error | any) => {
  const errorMessage = reason instanceof Error ? reason.message : String(reason);
  const errorStack = reason instanceof Error ? reason.stack : 'Стек недоступен';

  logger.error(`Необработанное отклонение Promise: ${errorMessage}`, { error: reason, stack: errorStack });
});

// Функция для настройки фоновых задач
function setupBackgroundTasks() {
  logger.info('Настройка фоновых задач...');

  // Интервал для отправки напоминаний о подписках (каждый час)
  const reminderInterval = 60 * 60 * 1000; // 1 час в миллисекундах
  logger.info(`Настройка отправки напоминаний с интервалом ${reminderInterval}ms`);

  setInterval(() => {
    if (config.enableAutoRenewal) {
      logger.info('Запуск задачи отправки напоминаний о подписках...');
      subscriptionService.sendSubscriptionReminders()
          .then(() => {
            logger.info('Задача отправки напоминаний успешно выполнена');
          })
          .catch(error => {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const errorStack = error instanceof Error ? error.stack : 'Стек недоступен';

            logger.error(`Ошибка при отправке напоминаний: ${errorMessage}`, {
              error,
              stack: errorStack
            });
          });
    }
  }, reminderInterval);

  // Интервал для обработки автопродлений (каждые 6 часов)
  const renewalInterval = 6 * 60 * 60 * 1000; // 6 часов в миллисекундах
  logger.info(`Настройка автопродлений с интервалом ${renewalInterval}ms`);

  setInterval(() => {
    if (config.enableAutoRenewal) {
      logger.info('Запуск задачи обработки автопродлений...');
      subscriptionService.processAutoRenewals()
          .then(() => {
            logger.info('Задача обработки автопродлений успешно выполнена');
          })
          .catch(error => {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const errorStack = error instanceof Error ? error.stack : 'Стек недоступен';

            logger.error(`Ошибка при обработке автопродлений: ${errorMessage}`, {
              error,
              stack: errorStack
            });
          });
    }
  }, renewalInterval);

  // Интервал для обновления статусов подписок (каждые 30 минут)
  const statusUpdateInterval = 30 * 60 * 1000; // 30 минут в миллисекундах
  logger.info(`Настройка обновления статусов подписок с интервалом ${statusUpdateInterval}ms`);

  setInterval(() => {
    logger.info('Запуск задачи обновления статусов подписок...');
    subscriptionService.updateSubscriptionStatuses()
        .then(() => {
          logger.info('Задача обновления статусов подписок успешно выполнена');
        })
        .catch(error => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const errorStack = error instanceof Error ? error.stack : 'Стек недоступен';

          logger.error(`Ошибка при обновлении статусов подписок: ${errorMessage}`, {
            error,
            stack: errorStack
          });
        });
  }, statusUpdateInterval);

  // Запуск проверки платежей (каждые 5 минут)
  startPaymentChecker().catch(error => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Ошибка при запуске проверки платежей: ${errorMessage}`, { error });
  });

  // Сразу запускаем задачи при старте
  logger.info('Запуск начальных задач...');

  // Обновление статусов подписок
  subscriptionService.updateSubscriptionStatuses()
      .then(() => {
        logger.info('Начальное обновление статусов подписок выполнено');
      })
      .catch(error => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Ошибка при начальном обновлении статусов подписок: ${errorMessage}`, { error });
      });

  // Отправка напоминаний и автопродление, если включено
  if (config.enableAutoRenewal) {
    // Напоминания
    subscriptionService.sendSubscriptionReminders()
        .then(() => {
          logger.info('Начальная отправка напоминаний выполнена');
        })
        .catch(error => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`Ошибка при начальной отправке напоминаний: ${errorMessage}`, { error });
        });

    // Автопродления
    subscriptionService.processAutoRenewals()
        .then(() => {
          logger.info('Начальная обработка автопродлений выполнена');
        })
        .catch(error => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`Ошибка при начальной обработке автопродлений: ${errorMessage}`, { error });
        });
  }

  logger.info('Фоновые задачи настроены успешно');
}

async function startServer() {
  try {
    logger.info('Запуск сервера...');

    // Инициализируем Express
    const app = express();
    app.use(express.json({
      verify: (req, res, buf) => {
        // Сохраняем оригинальное тело запроса для проверки подписи
        (req as any).rawBody = buf.toString();
      }
    }));
    app.use(cors()); // Добавляем поддержку CORS для API

    // Инициализируем Telegram бота
    await startBot();

    // Настройка обработчика вебхуков от ЮKassa
    app.post('/payment/webhook', validateYookassaWebhook, async (req, res) => {
      try {
        logger.info(`Получен webhook на /payment/webhook`);
        logger.debug(`Данные webhook: ${JSON.stringify(req.body)}`);

        await handlePaymentWebhook(req.body);
        res.status(200).send('OK');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : 'Стек недоступен';

        logger.error(`Ошибка в обработке webhook: ${errorMessage}`, {
          error,
          stack: errorStack
        });
        res.status(500).send('Internal Server Error');
      }
    });

    // Добавляем альтернативный маршрут для обратной совместимости
    app.post('/webhooks/payment', validateYookassaWebhook, async (req, res) => {
      try {
        logger.info(`Получен webhook на /webhooks/payment`);
        logger.debug(`Данные webhook: ${JSON.stringify(req.body)}`);

        await handlePaymentWebhook(req.body);
        res.status(200).send('OK');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : 'Стек недоступен';

        logger.error(`Ошибка в обработке webhook по альтернативному URL: ${errorMessage}`, {
          error,
          stack: errorStack
        });
        res.status(500).send('Internal Server Error');
      }
    });

    // Убираем дублирующие обработчики платежей для Telegram бота
    // Они уже должны быть зарегистрированы в bot/handlers/index.ts
    
    // Подключаем API маршруты
    app.use('/api', apiRoutes);

    // Раздаем статические файлы админ-панели
    const adminPath = path.join(__dirname, 'admin');
    app.use('/admin', express.static(adminPath));

    // Обрабатываем все маршруты админ-панели, чтобы работал client-side роутинг
    app.get('/admin/*', (req, res) => {
      res.sendFile(path.join(adminPath, 'index.html'));
    });

    // Роут для проверки работоспособности
    app.get('/health', (req, res) => {
      res.status(200).send('OK');
    });

    // Запускаем сервер
    const server = createServer(app);
    server.listen(config.port, config.host, async () => {
      logger.info(`Сервер запущен на http://${config.host}:${config.port}`);
      logger.info(`Админ-панель доступна по адресу http://${config.host}:${config.port}/admin`);

      // Запускаем фоновые задачи
      setupBackgroundTasks();
    });

    // Обработчик завершения работы приложения
    process.on('SIGINT', async () => {
      logger.info('Получен сигнал SIGINT, завершаем работу приложения...');
      await prisma.$disconnect();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Получен сигнал SIGTERM, завершаем работу приложения...');
      await prisma.$disconnect();
      process.exit(0);
    });

  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : 'Стек недоступен';

    logger.error(`Ошибка при запуске сервера: ${errorMessage}`, {
      error,
      stack: errorStack
    });
    process.exit(1);
  }
}

// Подключаемся к базе данных и запускаем сервер
prisma.$connect()
    .then(() => {
      logger.info('Успешное подключение к базе данных');
      return startServer();
    })
    .catch(error => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : 'Стек недоступен';

      logger.error(`Ошибка при подключении к базе данных: ${errorMessage}`, {
        error,
        stack: errorStack
      });
      process.exit(1);
    });