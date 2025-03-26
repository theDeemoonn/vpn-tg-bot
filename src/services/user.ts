import { User, Subscription } from '@prisma/client';
import { prisma } from './database';
import logger from '../utils/logger';

// Поиск пользователя по Telegram ID или создание нового
export async function findOrCreateUser(
  telegramId: number,
  firstName: string,
  lastName?: string,
  username?: string
): Promise<User> {
  try {
    // Ищем пользователя по Telegram ID
    let user = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramId) }
    });

    // Если пользователь не найден, создаем нового
    if (!user) {
      user = await prisma.user.create({
        data: {
          telegramId: BigInt(telegramId),
          firstName,
          lastName: lastName || null,
          username: username || null
        }
      });
      logger.info(`Создан новый пользователь: ${firstName} ${lastName || ''} (Telegram ID: ${telegramId})`);
    } else {
      // Обновляем информацию о пользователе, если она изменилась
      if (
        user.firstName !== firstName ||
        user.lastName !== (lastName || null) ||
        user.username !== (username || null)
      ) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            firstName,
            lastName: lastName || null,
            username: username || null
          }
        });
        logger.info(`Обновлен пользователь: ${firstName} ${lastName || ''} (Telegram ID: ${telegramId})`);
      }
    }

    return user;
  } catch (error) {
    logger.error(`Ошибка при поиске/создании пользователя: ${error}`);
    throw error;
  }
}

// Получение активных подписок пользователя
export async function getUserActiveSubscriptions(userId: number): Promise<Subscription[]> {
  try {
    const now = new Date();
    
    // Получаем все активные подписки пользователя
    const subscriptions = await prisma.subscription.findMany({
      where: {
        userId,
        status: 'ACTIVE',
        endDate: {
          gte: now
        }
      },
      include: {
        vpnServer: true
      },
      orderBy: {
        endDate: 'asc'
      }
    });
    
    return subscriptions;
  } catch (error) {
    logger.error(`Ошибка при получении активных подписок пользователя: ${error}`);
    throw error;
  }
}

// Получение всех подписок пользователя
export async function getUserSubscriptions(userId: number): Promise<Subscription[]> {
  try {
    // Получаем все подписки пользователя
    const subscriptions = await prisma.subscription.findMany({
      where: {
        userId
      },
      include: {
        vpnServer: true
      },
      orderBy: {
        endDate: 'desc'
      }
    });
    
    return subscriptions;
  } catch (error) {
    logger.error(`Ошибка при получении подписок пользователя: ${error}`);
    throw error;
  }
}

// Назначение/удаление статуса администратора
export async function setAdminStatus(userId: number, isAdmin: boolean): Promise<User> {
  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        isAdmin
      }
    });
    
    logger.info(`${isAdmin ? 'Установлен' : 'Снят'} статус администратора для пользователя #${userId}`);
    return user;
  } catch (error) {
    logger.error(`Ошибка при изменении статуса администратора: ${error}`);
    throw error;
  }
}

// Блокировка/разблокировка пользователя
export async function setUserActiveStatus(userId: number, isActive: boolean): Promise<User> {
  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        isActive
      }
    });
    
    // Если пользователь блокируется, деактивируем все его активные подписки
    if (!isActive) {
      const activeSubscriptions = await prisma.subscription.findMany({
        where: {
          userId,
          status: 'ACTIVE'
        }
      });
      
      // Обновляем статус всех активных подписок
      for (const subscription of activeSubscriptions) {
        await prisma.subscription.update({
          where: { id: subscription.id },
          data: {
            status: 'CANCELLED'
          }
        });
      }
      
      logger.info(`Деактивированы все подписки пользователя #${userId}`);
    }
    
    logger.info(`Пользователь #${userId} ${isActive ? 'разблокирован' : 'заблокирован'}`);
    return user;
  } catch (error) {
    logger.error(`Ошибка при изменении статуса активности пользователя: ${error}`);
    throw error;
  }
}

// Обновление языка пользователя
export async function updateUserLanguage(userId: number, language: string): Promise<User> {
  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        language
      }
    });
    
    logger.info(`Обновлен язык пользователя #${userId} на ${language}`);
    return user;
  } catch (error) {
    logger.error(`Ошибка при обновлении языка пользователя: ${error}`);
    throw error;
  }
}

// Получение всех пользователей (для админа)
export async function getAllUsers(
  page: number = 1,
  limit: number = 10,
  searchTerm?: string
): Promise<{ users: User[], total: number }> {
  try {
    const skip = (page - 1) * limit;
    
    // Базовые условия поиска
    const where: any = {};
    
    // Добавляем поиск по имени или Telegram ID, если указан searchTerm
    if (searchTerm) {
      where.OR = [
        { firstName: { contains: searchTerm } },
        { lastName: { contains: searchTerm } },
        { username: { contains: searchTerm } }
      ];
      
      // Если searchTerm можно преобразовать в число, ищем также по telegramId
      const numericSearchTerm = Number(searchTerm);
      if (!isNaN(numericSearchTerm)) {
        where.OR.push({ telegramId: BigInt(numericSearchTerm) });
      }
    }
    
    // Получаем пользователей с пагинацией
    const users = await prisma.user.findMany({
      where,
      skip,
      take: limit,
      orderBy: {
        createdAt: 'desc'
      }
    });
    
    // Получаем общее количество пользователей для пагинации
    const total = await prisma.user.count({ where });
    
    return { users, total };
  } catch (error) {
    logger.error(`Ошибка при получении списка пользователей: ${error}`);
    throw error;
  }
} 