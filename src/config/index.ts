import dotenv from 'dotenv';
import path from 'path';

// Загружаем .env файл
dotenv.config();

// Определяем конфигурацию приложения
interface Config {
  // Telegram Bot
  telegramBotToken: string;
  telegramBotUsername: string;
  adminChatId: string;
  
  // Database
  databaseUrl: string;
  
  // YooKassa API
  yookassaShopId: string;
  yookassaSecretKey: string;
  yookassaAutoPaymentMethodId: string;
  
  // Server
  port: number;
  host: string;
  
  // VPN Configuration
  defaultDownloadSpeed: number;
  defaultUploadSpeed: number;
  torrentAllowed: boolean;
  
  // Subscription plans
  monthlySubscriptionPrice: number;
  quarterlySubscriptionPrice: number;
  annualSubscriptionPrice: number;
  
  // VPN Server Deployment
  sshPrivateKeyPath: string;
  sshUser: string;
  doApiKey: string;       // DigitalOcean API ключ
  doSshKeyId: string;     // ID SSH ключа в DigitalOcean
  defaultProvider: string; // Провайдер по умолчанию
  defaultMaxClients: number; // Максимальное кол-во клиентов по умолчанию
  deploymentRegions: string[]; // Регионы для развертывания
  
  // Auto Renewal Settings
  enableAutoRenewal: boolean;
  reminderDays: number[];
  
  // Payment Systems
  enableTelegramPayments: boolean;
  telegramPaymentToken: string;
  paymentReturnUrl: string;
  
  // QR Code Settings
  qrCodeSize: number;
  
  // ЮKassa Telegram интеграция
  yookassaTelegramEnabled: boolean;
  yookassaTelegramWebhookUrl: string;
  
  // Fisсalization (чеки)
  enableFiscalization: boolean;
  fiscalizationDefaultEmail: string;
  fiscalizationVatCode: string;
}

// Проверка наличия обязательных переменных окружения
const requiredEnvVars = [
  'TELEGRAM_BOT_TOKEN',
  'DATABASE_URL',
  'YOOKASSA_SHOP_ID',
  'YOOKASSA_SECRET_KEY'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Отсутствует обязательная переменная окружения: ${envVar}`);
  }
}

// Создаем конфигурацию на основе переменных окружения
const config: Config = {
  // Telegram Bot
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN!,
  telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME || '',
  adminChatId: process.env.ADMIN_CHAT_ID || '',
  
  // Database
  databaseUrl: process.env.DATABASE_URL!,
  
  // YooKassa API
  yookassaShopId: process.env.YOOKASSA_SHOP_ID!,
  yookassaSecretKey: process.env.YOOKASSA_SECRET_KEY!,
  yookassaAutoPaymentMethodId: process.env.YOOKASSA_AUTO_PAYMENT_METHOD_ID || '',
  
  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || 'localhost',
  
  // VPN Configuration
  defaultDownloadSpeed: parseInt(process.env.DEFAULT_DOWNLOAD_SPEED || '10', 10),
  defaultUploadSpeed: parseInt(process.env.DEFAULT_UPLOAD_SPEED || '10', 10),
  torrentAllowed: process.env.TORRENT_ALLOWED === 'true',
  
  // Subscription plans
  monthlySubscriptionPrice: parseInt(process.env.MONTHLY_SUBSCRIPTION_PRICE || '299', 10),
  quarterlySubscriptionPrice: parseInt(process.env.QUARTERLY_SUBSCRIPTION_PRICE || '799', 10),
  annualSubscriptionPrice: parseInt(process.env.ANNUAL_SUBSCRIPTION_PRICE || '2999', 10),
  
  // VPN Server Deployment
  sshPrivateKeyPath: process.env.SSH_PRIVATE_KEY_PATH || path.resolve(process.cwd(), 'keys', 'id_rsa'),
  sshUser: process.env.SSH_USER || 'root',
  doApiKey: process.env.DO_API_KEY || '',
  doSshKeyId: process.env.DO_SSH_KEY_ID || '',
  defaultProvider: process.env.DEFAULT_PROVIDER || 'DigitalOcean',
  defaultMaxClients: parseInt(process.env.DEFAULT_MAX_CLIENTS || '100', 10),
  deploymentRegions: (process.env.DEPLOYMENT_REGIONS || 'amsterdam,frankfurt,london').split(','),
  
  // Auto Renewal Settings
  enableAutoRenewal: process.env.ENABLE_AUTO_RENEWAL === 'true',
  reminderDays: (process.env.REMINDER_DAYS || '7,3,1').split(',').map(day => parseInt(day, 10)),
  
  // Payment Systems
  enableTelegramPayments: process.env.ENABLE_TELEGRAM_PAYMENTS === 'true',
  telegramPaymentToken: process.env.TELEGRAM_PAYMENT_TOKEN || '',
  paymentReturnUrl: process.env.PAYMENT_RETURN_URL || 'http://localhost:3000/payment/return',
  
  // QR Code Settings
  qrCodeSize: parseInt(process.env.QR_CODE_SIZE || '300', 10),
  
  // ЮKassa Telegram интеграция
  yookassaTelegramEnabled: process.env.YOOKASSA_TELEGRAM_ENABLED === 'true',
  yookassaTelegramWebhookUrl: process.env.YOOKASSA_TELEGRAM_WEBHOOK_URL || '',
  
  // Fiscalization (чеки)
  enableFiscalization: process.env.ENABLE_FISCALIZATION === 'true',
  fiscalizationDefaultEmail: process.env.FISCALIZATION_DEFAULT_EMAIL || 'client@example.com',
  fiscalizationVatCode: process.env.FISCALIZATION_VAT_CODE || '1'
};

// Экспортируем настройки SSH для удобства использования
export const sshUser = config.sshUser;
export const sshPrivateKeyPath = config.sshPrivateKeyPath;

export default config; 