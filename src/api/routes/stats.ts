import express from 'express';
import { requireAdmin } from '../middlewares/auth';
import { getDashboardStats } from '../controllers/stats.controller';

const router = express.Router();

// Все маршруты требуют прав администратора
router.use(requireAdmin);

// Получение статистики для дашборда
router.get('/dashboard', getDashboardStats);

export default router; 