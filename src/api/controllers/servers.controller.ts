import { Request, Response } from 'express';
import { prisma } from '../../services/database';
import logger from '../../utils/logger';
import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import config from '../../config';
import { v4 as uuidv4 } from 'uuid';
import { 
  deployVpnServer, 
  getDeploymentStatus as getDeploymentStatusService,
  ServerDeploymentOptions 
} from '../../services/deployment';
import { 
  checkAndScale, 
  setAutoscalingEnabled, 
  getAutoscalingStatus 
} from '../../services/autoscaling';
import { 
  collectServerMetrics, 
  getServerMetricsHistory, 
  isServerOverloaded 
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

/**
 * Запуск процесса развертывания VPN сервера (обновленная версия)
 */
export const deployServer = async (req: Request, res: Response) => {
  try {
    const { name, host, port, location, provider, maxClients } = req.body;
    
    // Проверка обязательных полей
    if (!name || (!host && !location) || !provider) {
      return res.status(400).json({ 
        error: true, 
        message: 'Необходимо указать название, хост/локацию и провайдер сервера' 
      });
    }

    // Создаем опции для развертывания
    const deployOptions: ServerDeploymentOptions = {
      name,
      host,
      port: port ? parseInt(port) : undefined,
      location: location || '',
      provider,
      maxClients: maxClients ? parseInt(maxClients) : undefined
    };
    
    // Запускаем процесс развертывания через новый сервис
    const result = await deployVpnServer(deployOptions);
    
    if (!result.success) {
      logger.error(`Ошибка при развертывании сервера: ${result.error}`);
      return res.status(400).json({ 
        error: true, 
        message: result.error || 'Ошибка при запуске процесса развертывания' 
      });
    }
    
    // Отправляем ответ клиенту
    res.status(201).json({ 
      success: true, 
      message: 'Процесс развертывания запущен', 
      serverId: result.serverId,
      deploymentId: result.deploymentId
    });
  } catch (error: any) {
    logger.error(`Ошибка при запуске процесса развертывания: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при запуске процесса развертывания' });
  }
};

/**
 * Получение статуса развертывания (обновленная версия)
 */
export const getDeploymentStatus = async (req: Request, res: Response) => {
  try {
    const deploymentId = req.params.deploymentId;
    
    const status = getDeploymentStatusService(deploymentId);
    
    if (!status) {
      return res.status(404).json({ error: true, message: 'Процесс развертывания не найден' });
    }
    
    res.json({
      status: status.status,
      serverId: status.serverId,
      logs: status.logs,
      error: status.error
    });
  } catch (error) {
    logger.error(`Ошибка при получении статуса развертывания: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при получении статуса развертывания' });
  }
};

/**
 * Включение/выключение автомасштабирования
 */
export const toggleAutoscaling = async (req: Request, res: Response) => {
  try {
    const { enabled } = req.body;
    
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ 
        error: true, 
        message: 'Необходимо указать параметр enabled (true/false)' 
      });
    }
    
    setAutoscalingEnabled(enabled);
    
    res.json({ 
      success: true, 
      autoscaling: getAutoscalingStatus()
    });
  } catch (error) {
    logger.error(`Ошибка при изменении статуса автомасштабирования: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при изменении статуса автомасштабирования' });
  }
};

/**
 * Получение статуса автомасштабирования
 */
export const getAutoScalingStatus = async (req: Request, res: Response) => {
  try {
    res.json({ 
      success: true, 
      autoscaling: getAutoscalingStatus()
    });
  } catch (error) {
    logger.error(`Ошибка при получении статуса автомасштабирования: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при получении статуса автомасштабирования' });
  }
};

/**
 * Запуск ручного масштабирования
 */
export const runManualScaling = async (req: Request, res: Response) => {
  try {
    // Запускаем процесс проверки и масштабирования
    const scalingResult = await checkAndScale();
    
    res.json({ 
      success: true, 
      message: 'Процесс масштабирования запущен'
    });
  } catch (error) {
    logger.error(`Ошибка при запуске ручного масштабирования: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при запуске ручного масштабирования' });
  }
};

/**
 * Получение метрик сервера
 */
export const getServerMetrics = async (req: Request, res: Response) => {
  try {
    const serverId = parseInt(req.params.id);
    
    // Проверяем существование сервера
    const server = await prisma.vpnServer.findUnique({
      where: { id: serverId }
    });
    
    if (!server) {
      return res.status(404).json({ error: true, message: 'Сервер не найден' });
    }
    
    // Запрашиваем свежие метрики
    await collectServerMetrics(serverId);
    
    // Получаем историю метрик
    const metrics = getServerMetricsHistory(serverId);
    
    // Определяем, перегружен ли сервер
    const overloaded = isServerOverloaded(serverId);
    
    res.json({ 
      success: true,
      serverId,
      metrics,
      overloaded,
      lastUpdate: metrics.length > 0 ? metrics[metrics.length - 1].timestamp : null
    });
  } catch (error) {
    logger.error(`Ошибка при получении метрик сервера: ${error}`);
    res.status(500).json({ error: true, message: 'Ошибка при получении метрик сервера' });
  }
}; 