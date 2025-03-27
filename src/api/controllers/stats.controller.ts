import { PaymentStatus } from "@prisma/client";
import { Request, Response } from 'express';
import { prisma } from '../../services/database';
import logger from '../../utils/logger';

/**
 * Получение статистики для дашборда администратора
 */
export const getDashboardStats = async (req: Request, res: Response) => {
  try {
    // Получаем общее количество пользователей
    const totalUsers = await prisma.user.count();
    
    // Получаем количество активных пользователей
    const activeUsers = await prisma.user.count({
      where: { isActive: true }
    });
    
    // Получаем общее количество серверов
    const totalServers = await prisma.vpnServer.count();
    
    // Получаем количество активных подписок
    const activeSubscriptions = await prisma.subscription.count({
      where: { status: 'ACTIVE' }
    });
    
    // Получаем общую сумму подтвержденных платежей (выручка)
    const paymentsTotal = await prisma.payment.aggregate({
      _sum: { amount: true },
      where: { status: PaymentStatus.SUCCEEDED}
    });
    const totalRevenue = paymentsTotal._sum.amount || 0;
    
    // Получаем сумму подтвержденных платежей за текущий месяц
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const paymentsCurrentMonth = await prisma.payment.aggregate({
      _sum: { amount: true },
      where: {
        status: PaymentStatus.SUCCEEDED,
        confirmedAt: {
          gte: startOfMonth
        }
      }
    });
    const currentMonthRevenue = paymentsCurrentMonth._sum.amount || 0;
    
    // Получаем количество ожидающих платежей
    const pendingPayments = await prisma.payment.count({
      where: { status: 'PENDING' }
    });
    
    res.json({
      totalUsers,
      activeUsers,
      totalServers,
      activeSubscriptions,
      totalRevenue,
      currentMonthRevenue,
      pendingPayments
    });
  } catch (error) {
    logger.error(`Ошибка при получении статистики для дашборда: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при получении статистики' });
  }
}; 