import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger';

// Создаем экземпляр PrismaClient
const prisma = new PrismaClient({
  log: [
    {
      emit: 'event',
      level: 'query',
    },
    {
      emit: 'event',
      level: 'error',
    },
    {
      emit: 'event',
      level: 'info',
    },
    {
      emit: 'event',
      level: 'warn',
    },
  ],
});

// Добавляем логирование Prisma
prisma.$on('query', (e) => {
  logger.debug(`Prisma Query: ${e.query}`);
});

prisma.$on('error', (e) => {
  logger.error(`Prisma Error: ${e.message}`);
});

prisma.$on('info', (e) => {
  logger.info(`Prisma Info: ${e.message}`);
});

prisma.$on('warn', (e) => {
  logger.warn(`Prisma Warning: ${e.message}`);
});

// Функция для подключения к базе данных
async function connectToDatabase() {
  try {
    await prisma.$connect();
    logger.info('Успешное подключение к базе данных');
    return prisma;
  } catch (error) {
    logger.error(`Ошибка подключения к базе данных: ${error}`);
    throw error;
  }
}

// Функция для отключения от базы данных
async function disconnectFromDatabase() {
  await prisma.$disconnect();
  logger.info('Отключение от базы данных');
}

export { prisma, connectToDatabase, disconnectFromDatabase }; 