import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../../services/database';
import logger from '../../utils/logger';

// JWT секрет
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';
// Срок действия токена (1 день)
const TOKEN_EXPIRATION = '1d';

/**
 * Контроллер для аутентификации администратора
 */
export const login = async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: true, message: 'Необходимо указать имя пользователя и пароль' });
    }

    // Получаем учетные данные администратора из настроек
    const adminCred = await prisma.setting.findFirst({
      where: {
        key: 'ADMIN_USERNAME'
      }
    });

    const adminPass = await prisma.setting.findFirst({
      where: {
        key: 'ADMIN_PASSWORD'
      }
    });

    if (!adminCred || !adminPass || adminCred.value !== username || adminPass.value !== password) {
      return res.status(401).json({ error: true, message: 'Неверное имя пользователя или пароль' });
    }

    // Находим администратора в таблице пользователей
    const admin = await prisma.user.findFirst({
      where: {
        isAdmin: true,
        isActive: true
      }
    });

    if (!admin) {
      return res.status(500).json({ error: true, message: 'Администратор не найден в системе' });
    }

    // Создаем JWT токен
    const token = jwt.sign(
      { id: admin.id, isAdmin: true },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRATION }
    );

    // Отправляем токен
    res.json({
      token,
      user: {
        id: admin.id,
        firstName: admin.firstName,
        lastName: admin.lastName,
        isAdmin: admin.isAdmin
      }
    });
  } catch (error) {
    logger.error(`Ошибка при авторизации: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка сервера при авторизации' });
  }
};

/**
 * Контроллер для проверки действительности токена
 */
export const verifyToken = async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: true, message: 'Отсутствует токен авторизации' });
  }

  const tokenParts = authHeader.split(' ');
  
  if (tokenParts.length !== 2 || tokenParts[0] !== 'Bearer') {
    return res.status(401).json({ error: true, message: 'Неверный формат токена' });
  }

  const token = tokenParts[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number; isAdmin: boolean };
    
    // Проверяем существование пользователя
    const user = await prisma.user.findUnique({
      where: { id: decoded.id }
    });

    if (!user || !user.isActive) {
      return res.status(403).json({ error: true, message: 'Пользователь не найден или заблокирован' });
    }

    res.json({
      valid: true,
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        isAdmin: user.isAdmin
      }
    });
  } catch (error) {
    res.status(403).json({ error: true, message: 'Недействительный токен' });
  }
}; 