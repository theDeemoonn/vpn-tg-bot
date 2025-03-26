import { Request, Response } from 'express';
import { prisma } from '../../services/database';
import logger from '../../utils/logger';

/**
 * Получение всех настроек системы
 */
export const getAllSettings = async (req: Request, res: Response) => {
  try {
    const settings = await prisma.setting.findMany({
      orderBy: { key: 'asc' }
    });
    
    res.json({ settings });
  } catch (error) {
    logger.error(`Ошибка при получении настроек: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при получении настроек' });
  }
};

/**
 * Обновление настройки по ключу
 */
export const updateSetting = async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    
    if (!value) {
      return res.status(400).json({ error: true, message: 'Значение настройки не может быть пустым' });
    }

    const updatedSetting = await prisma.setting.update({
      where: { key },
      data: { value }
    });
    
    res.json({ setting: updatedSetting });
  } catch (error) {
    logger.error(`Ошибка при обновлении настройки: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при обновлении настройки' });
  }
};

/**
 * Массовое обновление настроек
 */
export const bulkUpdateSettings = async (req: Request, res: Response) => {
  try {
    const { settings } = req.body;
    
    if (!Array.isArray(settings) || settings.length === 0) {
      return res.status(400).json({ error: true, message: 'Необходимо предоставить массив настроек для обновления' });
    }

    // Используем транзакцию для обновления всех настроек или ни одной
    const result = await prisma.$transaction(
      settings.map(setting => 
        prisma.setting.update({
          where: { key: setting.key },
          data: { value: setting.value }
        })
      )
    );
    
    res.json({
      success: true,
      message: `Обновлено ${result.length} настроек`,
      settings: result
    });
  } catch (error) {
    logger.error(`Ошибка при массовом обновлении настроек: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при массовом обновлении настроек' });
  }
}; 