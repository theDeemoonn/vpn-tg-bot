import TelegramBot from 'node-telegram-bot-api';
import logger from '../utils/logger';
import { PrismaClient } from '@prisma/client'; // Импортируем Prisma Client
import { generateVlessUrl } from '../utils/generateVlessUrl';
import * as QRCode from 'qrcode';
import config from '../config'; // Импортируем ваш файл конфигурации

// Создаем инстанс Prisma Client (или импортируем существующий, если он есть)
// ВАЖНО: Убедитесь, что Prisma Client инициализируется только один раз в вашем приложении
const prisma = new PrismaClient(); 

// Класс можно оставить для структурирования, но без NestJS декораторов
class BotService {
  private bot: TelegramBot;

  constructor() {
    const botToken = config.telegramBotToken; // Получаем токен из конфига
    if (!botToken) {
      throw new Error('TELEGRAM_BOT_TOKEN не определен в конфигурации.');
    }
    // Опция polling: true заставляет бота опрашивать сервер Telegram на наличие новых сообщений
    this.bot = new TelegramBot(botToken, { polling: true });
    logger.info('Telegram бот инициализирован в режиме polling.');
  }

  public startListening() {
    this.registerCommands();
    this.handleErrors();
    logger.info('Бот начал прослушивать команды.');
  }

  private registerCommands() {
    // Обработчик команды /start
    this.bot.onText(/\/start/, this.handleStartCommand.bind(this));

    // Обработчик команды /getconfig
    this.bot.onText(/\/getconfig/, this.handleGetConfigCommand.bind(this));

    // Можно добавить обработчик для любых сообщений, если нужно
    // this.bot.on('message', (msg) => {
    //   // Обработка других сообщений
    // });
  }

  private handleErrors() {
      this.bot.on('polling_error', (error) => {
          logger.error('Polling error:', error.message);
          // Можно добавить логику для перезапуска или уведомления
      });
       this.bot.on('webhook_error', (error) => {
          logger.error('Webhook error:', error.message);
      });
      this.bot.on('error', (error) => {
          logger.error('General bot error:', error.message);
      });
  }

  private async handleStartCommand(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id;
    const username = msg.from?.username;
    const firstName = msg.from?.first_name || 'User';
    const lastName = msg.from?.last_name;

    if (!telegramId) {
      logger.warn(`Не удалось получить telegramId при команде /start от чата ${chatId}`);
      return this.bot.sendMessage(chatId, 'Не удалось определить ваш Telegram ID.');
    }

    try {
        let user = await prisma.user.findUnique({ where: { telegramId: BigInt(telegramId) } });

        if (!user) {
          user = await prisma.user.create({
            data: {
              telegramId: BigInt(telegramId),
              username: username,
              firstName: firstName,
              lastName: lastName,
              isAdmin: false,
              isActive: true,
            },
          });
          logger.info(`Новый пользователь зарегистрирован: ${username || firstName} (ID: ${telegramId})`);
          await this.bot.sendMessage(chatId, `Добро пожаловать, ${firstName}! Вы успешно зарегистрированы.`);
        } else {
            await prisma.user.update({
                where: { id: user.id },
                data: {
                    username: username,
                    firstName: firstName,
                    lastName: lastName,
                    isActive: true
                }
            });
          await this.bot.sendMessage(chatId, `С возвращением, ${firstName}!`);
        }
        await this.bot.sendMessage(chatId, 'Используйте команду /getconfig для получения вашей конфигурации VPN.');

    } catch (error) {
        logger.error(`Ошибка обработки команды /start для пользователя ${telegramId}:`, error);
        await this.bot.sendMessage(chatId, 'Произошла ошибка при обработке вашего запроса.');
    }
  }

  // --- Обработчик команды /getconfig ---
  private async handleGetConfigCommand(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id;

    if (!telegramId) {
       logger.warn(`Не удалось получить telegramId при команде /getconfig от чата ${chatId}`);
      return this.bot.sendMessage(chatId, 'Не удалось определить ваш Telegram ID.');
    }

    logger.info(`Пользователь ${telegramId} запросил конфигурацию (/getconfig)`);

    try {
      // 1. Найти пользователя в БД
      const user = await prisma.user.findUnique({
        where: { telegramId: BigInt(telegramId) },
      });

      if (!user) {
        logger.warn(`Пользователь ${telegramId} не найден в БД при запросе /getconfig`);
        return this.bot.sendMessage(chatId, 'Вы не зарегистрированы. Пожалуйста, используйте команду /start.');
      }

      if (!user.isActive) {
          logger.warn(`Неактивный пользователь ${telegramId} запросил /getconfig`);
          return this.bot.sendMessage(chatId, 'Ваш аккаунт неактивен.');
      }

      // 2. Найти активную подписку пользователя и связанный сервер
      // !!! ВАЖНО: Проверьте имя поля статуса подписки ('status' или 'isActive')
       const subscription = await prisma.subscription.findFirst({
           where: { userId: user.id, status: 'ACTIVE' }, // Или isActive: true 
           include: { vpnServer: true },
       });

       if (!subscription) {
           logger.info(`Активная подписка не найдена для пользователя ${user.id} (${telegramId})`);
           return this.bot.sendMessage(chatId, 'У вас нет активной подписки. Пожалуйста, оформите или продлите подписку.');
       }

       const server = subscription.vpnServer;

       // 3. Проверка данных сервера
       if (!server || !server.isActive) {
           logger.error(`Сервер ${subscription.vpnServerId} для подписки ${subscription.id} не найден или неактивен`);
           return this.bot.sendMessage(chatId, 'Возникла проблема с назначенным вам сервером. Обратитесь в поддержку.');
       }
       if (server.configData !== 'docker' || !server.initialUserId || !server.realityPublicKey || !server.realityShortId) {
           logger.error(`Сервер ${server.id} (${server.host}) не использует Docker или не имеет полных данных Reality.`);
           return this.bot.sendMessage(chatId, 'Конфигурация для вашего сервера еще не готова или неполная. Обратитесь в поддержку.');
       }

      // 4. Сгенерировать VLESS URL и QR-код
      const vlessUrl = generateVlessUrl({
          uuid: server.initialUserId, 
          address: server.host,
          port: server.port, // Убедитесь, что это порт Xray (443)
          publicKey: server.realityPublicKey,
          shortId: server.realityShortId,
          serverName: 'www.google.com', // TODO: Вынести в настройки
          fingerprint: 'chrome', // TODO: Вынести в настройки
          serverDescription: server.name || server.host,
      });

      const qrCodeDataUrl = await QRCode.toDataURL(vlessUrl);

      // 5. Отправить конфигурацию пользователю
      await this.bot.sendMessage(chatId, `Ваша ссылка для подключения (скопируйте):\n<code>${vlessUrl}</code>`, { parse_mode: 'HTML' }); 

      // Отправка QR-кода как фото
      const base64Data = qrCodeDataUrl.replace(/^data:image\/png;base64,/, "");
      const qrCodeBuffer = Buffer.from(base64Data, 'base64');
      // Отправляем буфер как фото
      await this.bot.sendPhoto(chatId, qrCodeBuffer, {
        caption: `QR-код для подключения к серверу "${server.name || server.host}" (отсканируйте в приложении).`,
      });

      logger.info(`Конфигурация успешно отправлена пользователю ${telegramId}`);

    } catch (error: any) {
      logger.error(`Ошибка обработки команды /getconfig для пользователя ${telegramId}:`, error);
      await this.bot.sendMessage(chatId, 'Произошла ошибка при получении вашей конфигурации. Попробуйте позже или обратитесь в поддержку.');
    }
  }
}

// Экспортируем инстанс сервиса, чтобы его можно было запустить из главного файла приложения
export const botService = new BotService();

// Пример запуска в главном файле (например, src/index.ts):
// import { botService } from './bot/bot.service';
// botService.startListening(); 