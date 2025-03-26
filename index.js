"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bot_1 = require("./bot");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const payment_1 = require("./services/payment");
const database_1 = require("./services/database");
const api_1 = __importDefault(require("./api"));
const config_1 = __importDefault(require("./config"));
const logger_1 = __importDefault(require("./utils/logger"));
const subscriptionService = __importStar(require("./services/subscription"));
// Обработчик необработанных исключений
process.on('uncaughtException', (error) => {
    logger_1.default.error(`Необработанное исключение: ${error}`);
});
// Обработчик необработанных отклонений промисов
process.on('unhandledRejection', (reason, promise) => {
    logger_1.default.error(`Необработанное отклонение промиса: ${reason}`);
});
// Функция для запуска фоновых задач
function setupBackgroundTasks() {
    logger_1.default.info('Настройка фоновых задач...');
    // Функция для проверки подписок и отправки напоминаний (каждый час)
    setInterval(() => {
        if (config_1.default.enableAutoRenewal) {
            subscriptionService.sendSubscriptionReminders()
                .catch(error => {
                    const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка';
                    logger_1.default.error(`Ошибка при отправке напоминаний: ${errorMessage}`);
                });
        }
    }, 60 * 60 * 1000); // Каждый час
    // Функция для обработки автопродлений (каждые 6 часов)
    setInterval(() => {
        if (config_1.default.enableAutoRenewal) {
            subscriptionService.processAutoRenewals()
                .catch(error => {
                    const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка';
                    logger_1.default.error(`Ошибка при обработке автопродлений: ${errorMessage}`);
                });
        }
    }, 6 * 60 * 60 * 1000); // Каждые 6 часов
    // Функция для обновления статусов подписок (каждые 30 минут)
    setInterval(() => {
        subscriptionService.updateSubscriptionStatuses()
            .catch(error => {
                const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка';
                logger_1.default.error(`Ошибка при обновлении статусов подписок: ${errorMessage}`);
            });
    }, 30 * 60 * 1000); // Каждые 30 минут
    // Запускаем все задачи при старте
    subscriptionService.updateSubscriptionStatuses()
        .catch(error => {
            const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка';
            logger_1.default.error(`Ошибка при обновлении статусов подписок: ${errorMessage}`);
        });
    if (config_1.default.enableAutoRenewal) {
        subscriptionService.sendSubscriptionReminders()
            .catch(error => {
                const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка';
                logger_1.default.error(`Ошибка при отправке напоминаний: ${errorMessage}`);
            });
        subscriptionService.processAutoRenewals()
            .catch(error => {
                const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка';
                logger_1.default.error(`Ошибка при обработке автопродлений: ${errorMessage}`);
            });
    }
    logger_1.default.info('Фоновые задачи настроены');
}
// Запуск приложения
function startApp() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            // Запускаем Telegram бота
            yield (0, bot_1.startBot)();
            // Настраиваем фоновые задачи
            setupBackgroundTasks();
            // Создаем Express приложение для обработки вебхуков и API
            const app = (0, express_1.default)();
            // Middleware
            app.use(express_1.default.json());
            app.use((0, cors_1.default)()); // Добавляем поддержку CORS для API
            // Роут для вебхуков от ЮKassa
            app.post('/webhooks/payment', (req, res) => __awaiter(this, void 0, void 0, function* () {
                try {
                    yield (0, payment_1.handlePaymentWebhook)(req.body);
                    res.status(200).send('OK');
                }
                catch (error) {
                    logger_1.default.error(`Ошибка при обработке вебхука: ${error}`);
                    res.status(500).send('Internal Server Error');
                }
            }));
            // Подключаем API маршруты
            app.use('/api', api_1.default);
            // Раздаем статические файлы админ-панели
            const adminPath = path_1.default.join(__dirname, 'admin');
            app.use('/admin', express_1.default.static(adminPath));
            // Обрабатываем все маршруты админ-панели, чтобы работал client-side роутинг
            app.get('/admin/*', (req, res) => {
                res.sendFile(path_1.default.join(adminPath, 'index.html'));
            });
            // Роут для проверки работоспособности
            app.get('/health', (req, res) => {
                res.status(200).send('OK');
            });
            // Запускаем сервер
            app.listen(config_1.default.port, config_1.default.host, () => {
                logger_1.default.info(`Сервер запущен на http://${config_1.default.host}:${config_1.default.port}`);
                logger_1.default.info(`Админ-панель доступна по адресу http://${config_1.default.host}:${config_1.default.port}/admin`);
            });
            // Обработчик завершения работы приложения
            process.on('SIGINT', () => __awaiter(this, void 0, void 0, function* () {
                logger_1.default.info('Получен сигнал SIGINT, завершаем работу приложения...');
                yield (0, database_1.disconnectFromDatabase)();
                process.exit(0);
            }));
            process.on('SIGTERM', () => __awaiter(this, void 0, void 0, function* () {
                logger_1.default.info('Получен сигнал SIGTERM, завершаем работу приложения...');
                yield (0, database_1.disconnectFromDatabase)();
                process.exit(0);
            }));
        }
        catch (error) {
            logger_1.default.error(`Ошибка при запуске приложения: ${error}`);
            process.exit(1);
        }
    });
}
// Запускаем приложение
startApp();
//# sourceMappingURL=index.js.map