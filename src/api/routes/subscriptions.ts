import express from 'express';
import { requireAdmin } from '../middlewares/auth';
import { 
  getSubscriptions, 
  getSubscriptionById, 
  cancelSubscription 
} from '../controllers/subscriptions.controller';

const router = express.Router();

// Все маршруты требуют прав администратора
router.use(requireAdmin);

// Получение списка подписок
router.get('/', getSubscriptions);

// Получение информации о конкретной подписке
router.get('/:id', getSubscriptionById);

// Отмена подписки
router.patch('/:id/cancel', cancelSubscription);

export default router; 