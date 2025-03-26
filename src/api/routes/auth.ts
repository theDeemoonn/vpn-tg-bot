import express from 'express';
import { login, verifyToken } from '../controllers/auth.controller';

const router = express.Router();

// Маршрут для входа администратора
router.post('/login', login);

// Проверка действительности токена
router.get('/verify', verifyToken);

export default router; 