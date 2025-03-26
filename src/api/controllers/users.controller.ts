import { Request, Response } from 'express';
import { prisma } from '../../services/database';
import logger from '../../utils/logger';

/**
 * Получение списка пользователей с пагинацией и поиском
 */
export const getUsers = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const search = req.query.search as string;

    const skip = (page - 1) * limit;

    // Формируем условия поиска
    const where: any = {};
    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { username: { contains: search, mode: 'insensitive' } }
      ];
      
      // Если поисковая строка может быть числом, ищем также по telegramId
      const numericSearch = Number(search);
      if (!isNaN(numericSearch)) {
        where.OR.push({ telegramId: BigInt(numericSearch) });
      }
    }

    // Получаем пользователей с пагинацией
    const users = await prisma.user.findMany({
      where,
      skip,
      take: limit,
      orderBy: {
        createdAt: 'desc'
      },
      include: {
        _count: {
          select: {
            subscriptions: {
              where: {
                status: 'ACTIVE'
              }
            }
          }
        }
      }
    });

    // Получаем общее количество пользователей для пагинации
    const total = await prisma.user.count({ where });

    res.json({
      users: users.map(user => ({
        ...user,
        telegramId: user.telegramId.toString(),
        activeSubscriptions: user._count.subscriptions
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    logger.error(`Ошибка при получении списка пользователей: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при получении списка пользователей' });
  }
};

/**
 * Получение информации о конкретном пользователе
 */
export const getUserById = async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        subscriptions: {
          include: {
            vpnServer: true
          },
          orderBy: {
            createdAt: 'desc'
          }
        },
        payments: {
          orderBy: {
            createdAt: 'desc'
          },
          take: 10
        }
      }
    });

    if (!user) {
      return res.status(404).json({ error: true, message: 'Пользователь не найден' });
    }

    res.json({
      ...user,
      telegramId: user.telegramId.toString(),
      subscriptions: user.subscriptions.map(sub => ({
        ...sub,
        startDate: sub.startDate.toISOString(),
        endDate: sub.endDate.toISOString(),
        createdAt: sub.createdAt.toISOString(),
        updatedAt: sub.updatedAt.toISOString()
      })),
      payments: user.payments.map(payment => ({
        ...payment,
        createdAt: payment.createdAt.toISOString(),
        confirmedAt: payment.confirmedAt ? payment.confirmedAt.toISOString() : null,
        expiresAt: payment.expiresAt ? payment.expiresAt.toISOString() : null
      }))
    });
  } catch (error) {
    logger.error(`Ошибка при получении информации о пользователе: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при получении информации о пользователе' });
  }
};

/**
 * Обновление статуса пользователя (блокировка/разблокировка)
 */
export const updateUserStatus = async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id);
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: true, message: 'Поле isActive должно быть типа boolean' });
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: { isActive }
    });

    // Если пользователь блокируется, деактивируем все его подписки
    if (!isActive) {
      await prisma.subscription.updateMany({
        where: {
          userId,
          status: 'ACTIVE'
        },
        data: {
          status: 'CANCELLED'
        }
      });

      logger.info(`Все подписки пользователя #${userId} деактивированы`);
    }

    res.json({
      ...user,
      telegramId: user.telegramId.toString()
    });
  } catch (error) {
    logger.error(`Ошибка при обновлении статуса пользователя: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при обновлении статуса пользователя' });
  }
};

/**
 * Назначение/отзыв прав администратора
 */
export const updateUserAdminRole = async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id);
    const { isAdmin } = req.body;

    if (typeof isAdmin !== 'boolean') {
      return res.status(400).json({ error: true, message: 'Поле isAdmin должно быть типа boolean' });
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: { isAdmin }
    });

    res.json({
      ...user,
      telegramId: user.telegramId.toString()
    });
  } catch (error) {
    logger.error(`Ошибка при обновлении прав администратора: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при обновлении прав администратора' });
  }
}; 