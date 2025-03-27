import { Request, Response } from 'express';
import { prisma } from '../../services/database';
import logger from '../../utils/logger';

/**
 * Получение списка серверов
 */
export const getServers = async (req: Request, res: Response) => {
  try {
    const servers = await prisma.vpnServer.findMany({
      orderBy: { id: 'asc' }
    });
    
    // Получаем количество активных пользователей для каждого сервера
    const serversWithUsers = await Promise.all(
      servers.map(async (server) => {
        const activeUsers = await prisma.subscription.count({
          where: {
            vpnServerId: server.id,
            status: 'ACTIVE'
          }
        });
        
        return {
          ...server,
          currentUsers: activeUsers
        };
      })
    );
    
    res.json({ servers: serversWithUsers });
  } catch (error) {
    logger.error(`Ошибка при получении списка серверов: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при получении списка серверов' });
  }
};

/**
 * Получение информации о конкретном сервере
 */
export const getServerById = async (req: Request, res: Response) => {
  try {
    const serverId = parseInt(req.params.id);
    
    const server = await prisma.vpnServer.findUnique({
      where: { id: serverId }
    });
    
    if (!server) {
      return res.status(404).json({ error: true, message: 'Сервер не найден' });
    }
    
    // Получаем количество активных пользователей
    const activeUsers = await prisma.subscription.count({
      where: {
        vpnServerId: serverId,
        status: 'ACTIVE'
      }
    });
    
    // Получаем конфигурацию сервера
    const serverConfig = "# Конфигурация сервера\n# Это пример конфигурации\nserver {\n  listen 80;\n  server_name example.com;\n}";
    
    res.json({
      ...server,
      currentUsers: activeUsers,
      config: serverConfig
    });
  } catch (error) {
    logger.error(`Ошибка при получении информации о сервере: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при получении информации о сервере' });
  }
};

/**
 * Создание нового сервера
 */
export const createServer = async (req: Request, res: Response) => {
  try {
    const { name, host, port, maxUsers, isActive } = req.body;
    
    // Проверка обязательных полей
    if (!name || !host || !port) {
      return res.status(400).json({ 
        error: true, 
        message: 'Необходимо указать название, хост и порт сервера' 
      });
    }

    const location = req.body.location;
    const provider = req.body.provider;
    
    // Создаем новый сервер
    const server = await prisma.vpnServer.create({
      data: {
        name,
        host,
        port: parseInt(port),
        location,
        provider,
        maxClients: maxUsers ? parseInt(maxUsers) : 100,
        isActive: typeof isActive === 'boolean' ? isActive : true
      }
    });
    
    res.status(201).json({ server });
  } catch (error) {
    logger.error(`Ошибка при создании сервера: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при создании сервера' });
  }
};

/**
 * Обновление информации о сервере
 */
export const updateServer = async (req: Request, res: Response) => {
  try {
    const serverId = parseInt(req.params.id);
    const { name, host, port, maxUsers, isActive } = req.body;
    
    // Проверяем существование сервера
    const existingServer = await prisma.vpnServer.findUnique({
      where: { id: serverId }
    });
    
    if (!existingServer) {
      return res.status(404).json({ error: true, message: 'Сервер не найден' });
    }
    
    // Обновляем информацию о сервере
    const server = await prisma.vpnServer.update({
      where: { id: serverId },
      data: {
        name: name !== undefined ? name : undefined,
        host: host !== undefined ? host : undefined,
        port: port !== undefined ? parseInt(port) : undefined,
        maxClients: maxUsers !== undefined ? parseInt(maxUsers) : undefined,
        isActive: isActive !== undefined ? isActive : undefined
      }
    });
    
    res.json({ server });
  } catch (error) {
    logger.error(`Ошибка при обновлении сервера: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при обновлении сервера' });
  }
};

/**
 * Удаление сервера
 */
export const deleteServer = async (req: Request, res: Response) => {
  try {
    const serverId = parseInt(req.params.id);
    
    // Проверяем существование сервера
    const existingServer = await prisma.vpnServer.findUnique({
      where: { id: serverId }
    });
    
    if (!existingServer) {
      return res.status(404).json({ error: true, message: 'Сервер не найден' });
    }
    
    // Проверяем, есть ли активные подписки на этот сервер
    const activeSubscriptions = await prisma.subscription.count({
      where: {
        vpnServerId: serverId,
        status: 'ACTIVE'
      }
    });
    
    if (activeSubscriptions > 0) {
      return res.status(400).json({
        error: true,
        message: `Невозможно удалить сервер, так как на нем ${activeSubscriptions} активных подписок`
      });
    }
    
    // Удаляем сервер
    await prisma.vpnServer.delete({
      where: { id: serverId }
    });
    
    res.json({ 
      success: true, 
      message: `Сервер ${existingServer.name} успешно удален` 
    });
  } catch (error) {
    logger.error(`Ошибка при удалении сервера: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при удалении сервера' });
  }
}; 