import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../../services/database';
import logger from '../../utils/logger';

// Расширяем тип Request для TypeScript
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: number;
        isAdmin: boolean;
      };
    }
  }
}

// JWT секрет
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';

// Middleware для проверки JWT токена
export const authenticateJWT = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ error: true, message: 'Отсутствует токен авторизации' });
    }

    const tokenParts = authHeader.split(' ');
    
    if (tokenParts.length !== 2 || tokenParts[0] !== 'Bearer') {
      return res.status(401).json({ error: true, message: 'Неверный формат токена' });
    }

    const token = tokenParts[1];

    jwt.verify(token, JWT_SECRET, async (err, decoded: any) => {
      if (err) {
        return res.status(403).json({ error: true, message: 'Недействительный или просроченный токен' });
      }

      // Проверяем существование пользователя в базе данных
      const user = await prisma.user.findUnique({
        where: { id: decoded.id }
      });

      if (!user || !user.isActive) {
        return res.status(403).json({ error: true, message: 'Пользователь не найден или заблокирован' });
      }

      // Добавляем информацию о пользователе в запрос
      req.user = {
        id: user.id,
        isAdmin: user.isAdmin
      };

      next();
    });
  } catch (error) {
    logger.error(`Ошибка аутентификации: ${error}`);
    return res.status(500).json({ error: true, message: 'Ошибка аутентификации' });
  }
};

// Middleware для проверки прав администратора
export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: true, message: 'Доступ запрещен. Требуются права администратора' });
  }
  next();
}; 