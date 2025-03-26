import { Request, Response } from 'express';
import { prisma } from '../../services/database';
import logger from '../../utils/logger';

/**
 * Получение списка подписок с пагинацией и фильтрацией
 */
export const getSubscriptions = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const status = req.query.status as string;
    const userId = req.query.userId ? parseInt(req.query.userId as string) : undefined;
    const serverId = req.query.serverId ? parseInt(req.query.serverId as string) : undefined;

    const skip = (page - 1) * limit;

    // Формируем условия фильтрации
    const where: any = {};
    if (status && status !== 'all') {
      where.status = status;
    }
    if (userId) {
      where.userId = userId;
    }
    if (serverId) {
      where.serverId = serverId;
    }

    // Получаем подписки с пагинацией
    const subscriptions = await prisma.subscription.findMany({
      where,
      skip,
      take: limit,
      orderBy: {
        createdAt: 'desc'
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            telegramId: true
          }
        },
        vpnServer: {
          select: {
            id: true,
            name: true,
            host: true
          }
        }
      }
    });

    // Получаем общее количество подписок для пагинации
    const total = await prisma.subscription.count({ where });

    res.json({
      subscriptions: subscriptions.map(subscription => ({
        ...subscription,
        startDate: subscription.startDate.toISOString(),
        endDate: subscription.endDate.toISOString(),
        createdAt: subscription.createdAt.toISOString(),
        updatedAt: subscription.updatedAt.toISOString(),
        user: {
          ...subscription.user,
          telegramId: subscription.user.telegramId.toString()
        }
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    logger.error(`Ошибка при получении списка подписок: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при получении списка подписок' });
  }
};

/**
 * Получение информации о конкретной подписке
 */
export const getSubscriptionById = async (req: Request, res: Response) => {
  try {
    const subscriptionId = parseInt(req.params.id);

    const subscription = await prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        user: true,
        vpnServer: true
      }
    });

    if (!subscription) {
      return res.status(404).json({ error: true, message: 'Подписка не найдена' });
    }

    res.json({
      ...subscription,
      startDate: subscription.startDate.toISOString(),
      endDate: subscription.endDate.toISOString(),
      createdAt: subscription.createdAt.toISOString(),
      updatedAt: subscription.updatedAt.toISOString(),
      user: {
        ...subscription.user,
        telegramId: subscription.user.telegramId.toString()
      }
    });
  } catch (error) {
    logger.error(`Ошибка при получении информации о подписке: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при получении информации о подписке' });
  }
};

/**
 * Отмена подписки
 */
export const cancelSubscription = async (req: Request, res: Response) => {
  try {
    const subscriptionId = parseInt(req.params.id);

    // Проверяем существование подписки
    const subscription = await prisma.subscription.findUnique({
      where: { id: subscriptionId }
    });

    if (!subscription) {
      return res.status(404).json({ error: true, message: 'Подписка не найдена' });
    }

    if (subscription.status !== 'ACTIVE') {
      return res.status(400).json({ error: true, message: 'Можно отменить только активную подписку' });
    }

    // Отменяем подписку
    const updatedSubscription = await prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        status: 'CANCELLED'
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            telegramId: true
          }
        },
        vpnServer: true
      }
    });

    logger.info(`Подписка #${subscriptionId} отменена администратором`);

    res.json({
      ...updatedSubscription,
      startDate: updatedSubscription.startDate.toISOString(),
      endDate: updatedSubscription.endDate.toISOString(),
      createdAt: updatedSubscription.createdAt.toISOString(),
      updatedAt: updatedSubscription.updatedAt.toISOString(),
      user: {
        ...updatedSubscription.user,
        telegramId: updatedSubscription.user.telegramId.toString()
      }
    });
  } catch (error) {
    logger.error(`Ошибка при отмене подписки: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при отмене подписки' });
  }
}; 