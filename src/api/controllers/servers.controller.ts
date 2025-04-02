import { Request, Response } from 'express';
import { prisma } from '../../services/database';
import logger from '../../utils/logger';
import * as fs from 'fs';
import config from '../../config';
import {
  deployVpnServerDocker,
  getDeploymentStatus as getDeploymentStatusService,
  ServerDeploymentOptions 
} from '../../services/deployment';
import { 
  checkAndScale, 
  setAutoscalingEnabled, 
  getAutoscalingStatus 
} from '../../services/autoscaling';
import { 
  getServerMetricsHistory,
} from '../../services/monitoring';

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
    
    // Получаем конфигурацию сервера (можно расширить)
    const serverConfig = server.configData === 'docker' 
      ? `Dockerized Xray on ${server.host}`
      : `# Manual configuration data for ${server.host}`; // Placeholder
    
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
 * Создание нового сервера (ручное, не развертывание)
 */
export const createServer = async (req: Request, res: Response) => {
  try {
    const { name, host, port, maxUsers, isActive, location, provider } = req.body;
    
    // Проверка обязательных полей
    if (!name || !host || !port) {
      return res.status(400).json({ 
        error: true, 
        message: 'Необходимо указать название, хост и порт сервера' 
      });
    }
    
    // Создаем новый сервер
    const server = await prisma.vpnServer.create({
      data: {
        name,
        host,
        port: parseInt(port),
        location: location || 'N/A',
        provider: provider || 'N/A',
        maxClients: maxUsers ? parseInt(maxUsers) : 100,
        isActive: typeof isActive === 'boolean' ? isActive : true,
        configData: 'manual' // Помечаем как ручной
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
    const { name, host, port, maxClients, isActive, location, provider } = req.body;
    
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
        location: location !== undefined ? location : undefined,
        provider: provider !== undefined ? provider : undefined,
        maxClients: maxClients !== undefined ? parseInt(maxClients) : undefined,
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
    
    // TODO: Добавить логику остановки и удаления Docker-контейнера Xray при удалении сервера
    if (existingServer.configData === 'docker') {
      logger.warn(`Удаление Docker-сервера ${serverId} пока не реализовано (нужно остановить контейнер)`);
      // Здесь нужно будет добавить SSH команду для остановки/удаления контейнера
      // const stopCommand = `docker stop xray_vpn && docker rm xray_vpn`;
      // await executeSshCommand(...);
    }
    
    // Удаляем сервер из базы
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

/**
 * Запуск процесса развертывания Xray через Docker
 */
export const deployServer = async (req: Request, res: Response) => {
  try {
    // Получаем данные из запроса
    const { 
      name, 
      ip, // Теперь это ip, а не host
      sshPort, 
      sshUsername, 
      sshPassword, 
      location, // Опционально
      provider // Опционально
    } = req.body;
    
    // Проверка обязательных полей для развертывания
    if (!name || !ip || !sshUsername ) {
      return res.status(400).json({ 
        error: true, 
        message: 'Необходимо указать название сервера, IP-адрес и имя пользователя SSH' 
      });
    }
    // Пароль или ключ должен быть указан (ключ по умолчанию из config)
    if (!sshPassword && !fs.existsSync(config.sshPrivateKeyPath)) {
        return res.status(400).json({
            error: true,
            message: 'Необходимо указать пароль SSH или убедиться, что ключ SSH существует по пути, указанному в конфигурации'
        });
    }

    // Создаем опции для развертывания
    const deployOptions: ServerDeploymentOptions = {
      name,
      host: ip, // Передаем ip как host
      port: sshPort ? parseInt(sshPort) : 22,
      sshUsername,
      sshPassword: sshPassword || undefined,
      sshKeyPath: config.sshPrivateKeyPath,
      location: location || 'N/A',
      provider: provider || 'User Provided'
    };
    
    // Запускаем процесс развертывания Docker
    const result = await deployVpnServerDocker(deployOptions);

    if (result.success) {
      res.status(202).json({
        message: 'Процесс развертывания Docker запущен',
        deploymentId: result.deploymentId,
        serverId: result.serverId
      });
    } else {
      res.status(500).json({ 
        error: true, 
        message: result.error || 'Не удалось запустить развертывание Docker' 
      });
    }
    
  } catch (error: any) {
    logger.error(`Ошибка при запуске развертывания Docker: ${error.message}`);
    res.status(500).json({ 
      error: true, 
      message: `Внутренняя ошибка сервера: ${error.message}` 
    });
  }
};

/**
 * Получение статуса развертывания
 */
export const getDeploymentStatus = async (req: Request, res: Response) => {
  try {
    const deploymentId = req.params.deploymentId;
    const status = getDeploymentStatusService(deploymentId);
    
    if (status) {
      res.json(status);
    } else {
      res.status(404).json({ error: true, message: 'Статус развертывания не найден' });
    }
  } catch (error) {
    logger.error(`Ошибка при получении статуса развертывания: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при получении статуса' });
  }
};

/**
 * Управление автомасштабированием
 */
export const toggleAutoscaling = async (req: Request, res: Response) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: true, message: 'Параметр enabled должен быть boolean' });
    }
    await setAutoscalingEnabled(enabled);
    res.json({ success: true, message: `Автомасштабирование ${enabled ? 'включено' : 'выключено'}` });
  } catch (error) {
    logger.error(`Ошибка при изменении статуса автомасштабирования: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка сервера' });
  }
};

/**
 * Получение статуса автомасштабирования
 */
export const getAutoScalingStatus = async (req: Request, res: Response) => {
  try {
    const status = await getAutoscalingStatus();
    res.json({ status });
  } catch (error) {
    logger.error(`Ошибка при получении статуса автомасштабирования: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка сервера' });
  }
};

/**
 * Запуск ручного автомасштабирования
 */
export const runManualScaling = async (req: Request, res: Response) => {
  try {
    const { direction } = req.body; // 'up' или 'down'
    if (direction !== 'up' && direction !== 'down') {
      return res.status(400).json({ error: true, message: 'Параметр direction должен быть up или down' });
    }
    await checkAndScale(); // Запускаем принудительно
    res.json({ success: true, message: `Запущено ручное масштабирование (${direction})` });
  } catch (error) {
    logger.error(`Ошибка при ручном масштабировании: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка сервера' });
  }
};

/**
 * Получение метрик сервера
 */
export const getServerMetrics = async (req: Request, res: Response) => {
  try {
    const serverId = parseInt(req.params.id);
    const metrics = await getServerMetricsHistory(serverId);
    res.json({ metrics });
  } catch (error) {
    logger.error(`Ошибка при получении метрик сервера: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка получения метрик' });
  }
}; 