import { Request, Response } from 'express';
import { prisma } from '../../services/database';
import logger from '../../utils/logger';

/**
 * Получение списка платежей с пагинацией и фильтрацией
 */
export const getPayments = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const status = req.query.status as string;
    const userId = req.query.userId ? parseInt(req.query.userId as string) : undefined;

    const skip = (page - 1) * limit;

    // Формируем условия фильтрации
    const where: any = {};
    if (status && status !== 'all') {
      where.status = status;
    }
    if (userId) {
      where.userId = userId;
    }

    // Получаем платежи с пагинацией
    const payments = await prisma.payment.findMany({
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
            lastName: true
          }
        }
      }
    });

    // Получаем общее количество платежей для пагинации
    const total = await prisma.payment.count({ where });

    res.json({
      payments: payments.map(payment => ({
        ...payment,
        createdAt: payment.createdAt.toISOString(),
        confirmedAt: payment.confirmedAt ? payment.confirmedAt.toISOString() : null,
        expiresAt: payment.expiresAt ? payment.expiresAt.toISOString() : null
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    logger.error(`Ошибка при получении списка платежей: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при получении списка платежей' });
  }
};

/**
 * Получение информации о конкретном платеже
 */
export const getPaymentById = async (req: Request, res: Response) => {
  try {
    const paymentId = parseInt(req.params.id);

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        user: true,
        subscription: {
          include: {
            vpnServer: true
          }
        }
      }
    });

    if (!payment) {
      return res.status(404).json({ error: true, message: 'Платеж не найден' });
    }

    res.json({
      ...payment,
      createdAt: payment.createdAt.toISOString(),
      confirmedAt: payment.confirmedAt ? payment.confirmedAt.toISOString() : null,
      expiresAt: payment.expiresAt ? payment.expiresAt.toISOString() : null,
      user: {
        ...payment.user,
        telegramId: payment.user.telegramId.toString()
      }
    });
  } catch (error) {
    logger.error(`Ошибка при получении информации о платеже: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при получении информации о платеже' });
  }
}; 