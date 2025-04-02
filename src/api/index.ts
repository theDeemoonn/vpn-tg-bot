import express, { Request, Response, NextFunction } from 'express';
import { authenticateJWT } from './middlewares/auth';
import usersRouter from './routes/users';
import serversRouter from './routes/servers';
import subscriptionsRouter from './routes/subscriptions';
import paymentsRouter from './routes/payments';
import settingsRouter from './routes/settings';
import authRouter from './routes/auth';
import statsRouter from './routes/stats';
import logger from '../utils/logger';
import vpnUserRouter from './routes/vpnUser.routes'; 

// Создаем Router для API
const router = express.Router();

// Middleware для логирования запросов
router.use((req: Request, res: Response, next: NextFunction) => {
  logger.info(`API Request: ${req.method} ${req.path}`);
  next();
});

// Маршруты, не требующие аутентификации
router.use('/auth', authRouter);

// Проверка аутентификации для всех остальных маршрутов API
router.use(authenticateJWT);

// Маршруты, требующие аутентификации
router.use('/users', usersRouter);
router.use('/servers', serversRouter);
router.use('/subscriptions', subscriptionsRouter);
router.use('/payments', paymentsRouter);
router.use('/settings', settingsRouter);
router.use('/stats', statsRouter);
router.use('/api', vpnUserRouter);

// Обработка ошибок API
router.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error(`API Error: ${err.message}`);
  res.status(500).json({
    error: true,
    message: err.message || 'Произошла внутренняя ошибка сервера',
  });
});

export default router; 