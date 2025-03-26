import express from 'express';
import { requireAdmin } from '../middlewares/auth';
import { getAllSettings, updateSetting, bulkUpdateSettings } from '../controllers/settings.controller';

const router = express.Router();

// Все маршруты требуют прав администратора
router.use(requireAdmin);

// Получение всех настроек
router.get('/', getAllSettings);

// Обновление конкретной настройки
router.put('/:key', updateSetting);

// Массовое обновление настроек
router.put('/bulk', bulkUpdateSettings);

export default router; 