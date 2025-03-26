import express from 'express';
import { requireAdmin } from '../middlewares/auth';
import { getPayments, getPaymentById } from '../controllers/payments.controller';

const router = express.Router();

// Все маршруты требуют прав администратора
router.use(requireAdmin);

// Получение списка платежей
router.get('/', getPayments);

// Получение информации о конкретном платеже
router.get('/:id', getPaymentById);

export default router; 