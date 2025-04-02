import express from 'express';
import { requireAdmin } from '../middlewares/auth'; // Подключаем middleware для проверки прав администратора
import {
  getVpnUsers,
  addVpnUser,
  deleteVpnUser
} from '../controllers/vpnUser.controller'; // Импортируем контроллеры

const router = express.Router();

// Все маршруты требуют прав администратора
router.use(requireAdmin);

/**
 * @openapi
 * /api/servers/{serverId}/users:
 *   get:
 *     summary: Получить список пользователей на VPN сервере
 *     tags: [VPN Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID VPN сервера
 *     responses:
 *       200:
 *         description: Список пользователей
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 clients:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       email: { type: string }
 *                       flow: { type: string }
 *       400: { description: 'Некорректный запрос или ошибка валидации' }
 *       401: { description: 'Не авторизован (нет токена)' }
 *       403: { description: 'Нет прав доступа (не админ)' }
 *       404: { description: 'VPN сервер не найден в БД' }
 *       500: { description: 'Внутренняя ошибка сервера или ошибка API VPN-сервера' }
 *       503: { description: 'Не удалось подключиться к API VPN сервера' }
 *       504: { description: 'Таймаут ответа от API VPN сервера' }
 */
router.get('/servers/:serverId/users', getVpnUsers);

/**
 * @openapi
 * /api/servers/{serverId}/users:
 *   post:
 *     summary: Добавить пользователя на VPN сервер
 *     tags: [VPN Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID VPN сервера
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 description: Email нового пользователя
 *                 example: user@example.com
 *     responses:
 *       201:
 *         description: Пользователь успешно добавлен
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *                 client:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     email: { type: string }
 *                     flow: { type: string }
 *       400: { description: 'Некорректный запрос (например, неверный email) или ошибка валидации' }
 *       401: { description: 'Не авторизован' }
 *       403: { description: 'Нет прав доступа' }
 *       404: { description: 'VPN сервер не найден в БД' }
 *       409: { description: 'Пользователь с таким email уже существует на удаленном сервере' }
 *       500: { description: 'Внутренняя ошибка сервера или ошибка API VPN-сервера' }
 *       503: { description: 'Не удалось подключиться к API VPN сервера' }
 *       504: { description: 'Таймаут ответа от API VPN сервера' }
 */
router.post('/servers/:serverId/users', addVpnUser);

/**
 * @openapi
 * /api/servers/{serverId}/users/{userEmail}:
 *   delete:
 *     summary: Удалить пользователя с VPN сервера
 *     tags: [VPN Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID VPN сервера
 *       - in: path
 *         name: userEmail
 *         required: true
 *         schema:
 *           type: string
 *           format: email
 *         description: Email пользователя для удаления
 *     responses:
 *       200:
 *         description: Пользователь успешно удален
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *       400: { description: 'Некорректный запрос или ошибка валидации' }
 *       401: { description: 'Не авторизован' }
 *       403: { description: 'Нет прав доступа' }
 *       404: { description: 'VPN сервер в БД или пользователь на удаленном сервере не найден' }
 *       500: { description: 'Внутренняя ошибка сервера или ошибка API VPN-сервера' }
 *       503: { description: 'Не удалось подключиться к API VPN сервера' }
 *       504: { description: 'Таймаут ответа от API VPN сервера' }
 */
router.delete('/servers/:serverId/users/:userEmail', deleteVpnUser);

export default router;