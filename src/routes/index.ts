import express from 'express';
import { createHash, randomBytes } from 'crypto';
import { prisma } from '../services/database';
import { logger } from '../utils/logger';
import { handlePaymentWebhook } from '../services/payment';
import config from '../config';

const router = express.Router();

/**
 * Главная страница
 */
router.get('/', (req, res) => {
  res.send('VPN Bot API');
});

/**
 * Webhook для обработки уведомлений о платежах от ЮKassa
 */
router.post('/payment/webhook', express.json(), async (req, res) => {
  try {
    logger.info('Получен webhook от ЮKassa');
    
    // Проверка наличия данных
    if (!req.body) {
      logger.error('Webhook без данных');
      return res.status(400).send('Bad Request: No data');
    }
    
    // Обработка webhook
    await handlePaymentWebhook(req.body);
    
    res.status(200).send('OK');
  } catch (error) {
    logger.error(`Ошибка обработки webhook: ${error}`);
    res.status(500).send('Internal Server Error');
  }
});

/**
 * Обработчик успешного возврата с платежной страницы ЮKassa
 */
router.get('/payment/return', async (req, res) => {
  try {
    logger.info('Обработка возврата с платежной страницы ЮKassa');
    
    // Проверяем, есть ли данные о платеже в query параметрах
    const paymentId = req.query.payment_id;
    
    if (paymentId) {
      logger.info(`Получен возврат для платежа: ${paymentId}`);
      
      // Записываем информацию о возврате пользователя с платежной страницы
      await prisma.paymentLog.create({
        data: {
          type: 'RETURN_URL_VISIT',
          paymentId: paymentId.toString(),
          data: JSON.stringify({
            query: req.query,
            headers: req.headers,
            timestamp: new Date().toISOString()
          })
        }
      });
      
      // Подготавливаем телеграм-ссылку для возврата пользователя
      const botUsername = config.telegramBotUsername || 'your_bot_username';
      
      // Создаем параметр для идентификации возврата с платежа
      const returnParam = `payment_return_${paymentId}`;
      
      // Формируем URL для перенаправления пользователя обратно в бот
      const telegramUrl = `https://t.me/${botUsername}?start=${returnParam}`;
      
      // Перенаправляем на страницу благодарности
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>Оплата успешно завершена</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
              background-color: #f5f5f5;
              color: #333;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              height: 100vh;
              margin: 0;
              padding: 15px;
              text-align: center;
            }
            .container {
              background-color: white;
              border-radius: 10px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
              padding: 30px;
              max-width: 500px;
              width: 100%;
            }
            h1 {
              color: #4CAF50;
              margin-bottom: 20px;
            }
            p {
              margin: 15px 0;
              line-height: 1.5;
            }
            .button {
              display: inline-block;
              background-color: #0088cc;
              color: white;
              padding: 12px 24px;
              border-radius: 5px;
              text-decoration: none;
              font-weight: bold;
              margin-top: 20px;
              transition: background-color 0.3s;
            }
            .button:hover {
              background-color: #006699;
            }
            .loader {
              border: 4px solid #f3f3f3;
              border-top: 4px solid #0088cc;
              border-radius: 50%;
              width: 30px;
              height: 30px;
              animation: spin 1s linear infinite;
              margin: 20px auto;
            }
            @keyframes spin {
              0% { transform: rotate(0deg); }
              100% { transform: rotate(360deg); }
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>✅ Оплата успешно завершена!</h1>
            <p>Ваша подписка будет активирована в течение нескольких секунд.</p>
            <p>Сейчас вы будете перенаправлены обратно в Telegram бот.</p>
            <div class="loader"></div>
            <a href="${telegramUrl}" class="button">Вернуться в бот</a>
          </div>
          <script>
            // Автоматический редирект через 3 секунды
            setTimeout(function() {
              window.location.href = "${telegramUrl}";
            }, 3000);
          </script>
        </body>
        </html>
      `);
    } else {
      // Если нет параметра payment_id, то просто показываем общее сообщение
      const botUsername = config.telegramBotUsername || 'your_bot_username';
      const telegramUrl = `https://t.me/${botUsername}`;
      
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>Операция завершена</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
              background-color: #f5f5f5;
              color: #333;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              height: 100vh;
              margin: 0;
              padding: 15px;
              text-align: center;
            }
            .container {
              background-color: white;
              border-radius: 10px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
              padding: 30px;
              max-width: 500px;
              width: 100%;
            }
            h1 {
              color: #0088cc;
              margin-bottom: 20px;
            }
            p {
              margin: 15px 0;
              line-height: 1.5;
            }
            .button {
              display: inline-block;
              background-color: #0088cc;
              color: white;
              padding: 12px 24px;
              border-radius: 5px;
              text-decoration: none;
              font-weight: bold;
              margin-top: 20px;
              transition: background-color 0.3s;
            }
            .button:hover {
              background-color: #006699;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Операция завершена</h1>
            <p>Спасибо за использование нашего сервиса.</p>
            <p>Вернитесь в бот для проверки статуса вашей подписки.</p>
            <a href="${telegramUrl}" class="button">Открыть бот</a>
          </div>
        </body>
        </html>
      `);
    }
  } catch (error) {
    logger.error(`Ошибка при обработке возврата с платежной страницы: ${error}`);
    res.status(500).send('Произошла ошибка. Пожалуйста, вернитесь в бот.');
  }
});

export default router; 