import express from 'express';
import { requireAdmin } from '../middlewares/auth';
import { getUsers, getUserById, updateUserStatus, updateUserAdminRole } from '../controllers/users.controller';

const router = express.Router();

// Все маршруты требуют прав администратора
router.use(requireAdmin);

// Получение списка пользователей
router.get('/', getUsers);

// Получение информации о конкретном пользователе
router.get('/:id', getUserById);

// Обновление статуса пользователя (блокировка/разблокировка)
router.patch('/:id/status', updateUserStatus);

// Назначение/отзыв прав администратора
router.patch('/:id/admin', updateUserAdminRole);

export default router; 