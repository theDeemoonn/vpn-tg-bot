import winston from 'winston';
import path from 'path';
import fs from 'fs';

// Создаем директории для логов, если они не существуют
const logDir = path.resolve(process.cwd(), 'logs');

// Проверяем существование директории и создаем, если нужно
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Настройка форматирования логов
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    return `[${timestamp}] [${level.toUpperCase()}]: ${message} ${
      Object.keys(meta).length ? JSON.stringify(meta, null, 2) : ''
    }`;
  })
);

// Создаем логгер
const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: logFormat,
  transports: [
    // Вывод в консоль
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        logFormat
      ),
    }),
    // Вывод в файл info.log
    new winston.transports.File({ 
      filename: path.join(logDir, 'info.log'),
      level: 'info'
    }),
    // Вывод в файл error.log
    new winston.transports.File({ 
      filename: path.join(logDir, 'error.log'),
      level: 'error'
    }),
    // Отдельный файл для отладки
    new winston.transports.File({ 
      filename: path.join(logDir, 'debug.log'),
      level: 'debug'
    }),
  ],
});

// Исправляем экспорт, чтобы был совместим с обоими способами импорта
export default logger;
export { logger }; 