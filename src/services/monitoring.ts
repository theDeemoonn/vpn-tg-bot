import axios from 'axios';
import { prisma } from './database';
import logger from '../utils/logger';
import config from '../config';
import { spawn } from 'child_process';

interface ServerMetrics {
  cpuUsage: number;         // Процент использования CPU
  memoryUsage: number;      // Процент использования памяти
  bandwidth: number;        // Мбит/с текущей пропускной способности
  connections: number;      // Количество активных VPN соединений
  latency: number;          // Задержка до сервера в мс
  timestamp: Date;          // Время замера
}

const serverMetricsCache: Map<number, ServerMetrics[]> = new Map();
const METRICS_HISTORY_LENGTH = 24; // Хранить историю за 24 часа

/**
 * Собирает метрики производительности для указанного сервера
 */
export async function collectServerMetrics(serverId: number): Promise<ServerMetrics | null> {
  try {
    const server = await prisma.vpnServer.findUnique({
      where: { id: serverId }
    });

    if (!server || !server.isActive) {
      return null;
    }

    // Проверка доступности сервера
    const pingResult = await checkServerLatency(server.host);
    if (pingResult === null) {
      logger.warn(`Сервер ${server.name} (${server.host}) недоступен`);
      return null;
    }

    // Получение метрик через SSH
    const metrics = await collectMetricsViaSsh(server);
    if (!metrics) {
      return null;
    }

    // Обновляем кэш метрик
    if (!serverMetricsCache.has(serverId)) {
      serverMetricsCache.set(serverId, []);
    }
    
    const metricsHistory = serverMetricsCache.get(serverId)!;
    metricsHistory.push(metrics);
    
    // Ограничиваем историю
    if (metricsHistory.length > METRICS_HISTORY_LENGTH) {
      metricsHistory.shift();
    }
    
    serverMetricsCache.set(serverId, metricsHistory);

    // Логируем результаты
    logger.info(`Собраны метрики для сервера ${server.name}: CPU: ${metrics.cpuUsage}%, RAM: ${metrics.memoryUsage}%, Соединений: ${metrics.connections}`);

    // Возвращаем метрики
    return metrics;
  } catch (error) {
    logger.error(`Ошибка при сборе метрик для сервера ${serverId}: ${error}`);
    return null;
  }
}

/**
 * Измеряет задержку до сервера
 */
async function checkServerLatency(host: string): Promise<number | null> {
  return new Promise((resolve) => {
    const ping = spawn('ping', ['-c', '3', host]);
    let output = '';

    ping.stdout.on('data', (data) => {
      output += data.toString();
    });

    ping.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }

      // Парсим результат ping
      const matches = output.match(/time=(\d+\.?\d*)/g);
      if (matches && matches.length > 0) {
        const times = matches.map(m => parseFloat(m.split('=')[1]));
        const avgTime = times.reduce((sum, time) => sum + time, 0) / times.length;
        resolve(avgTime);
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * Собирает метрики через SSH
 */
async function collectMetricsViaSsh(server: any): Promise<ServerMetrics | null> {
  return new Promise((resolve) => {
    const sshProcess = spawn('ssh', [
      '-i', config.sshPrivateKeyPath,
      '-p', server.port.toString(),
      `${config.sshUser}@${server.host}`,
      // Запускаем команды для сбора метрик 
      `echo "=====CPU====="; top -bn1 | grep "Cpu(s)" | awk '{print $2 + $4}'; ` +
      `echo "=====MEMORY====="; free -m | grep Mem | awk '{print $3/$2 * 100.0}'; ` +
      `echo "=====CONNECTIONS====="; netstat -ant | grep ESTABLISHED | wc -l; ` +
      `echo "=====BANDWIDTH====="; vnstat -tr 2 | grep "rx" | tail -n1 | awk '{print $2}'`
    ]);

    let output = '';
    let error = '';

    sshProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    sshProcess.stderr.on('data', (data) => {
      error += data.toString();
    });

    sshProcess.on('close', (code) => {
      if (code !== 0) {
        logger.error(`Ошибка SSH (${code}): ${error}`);
        resolve(null);
        return;
      }

      try {
        const sections = output.split('=====');
        const cpuSection = sections.find(s => s.includes('CPU'));
        const memorySection = sections.find(s => s.includes('MEMORY'));
        const connectionsSection = sections.find(s => s.includes('CONNECTIONS'));
        const bandwidthSection = sections.find(s => s.includes('BANDWIDTH'));

        const cpuUsage = cpuSection ? parseFloat(cpuSection.split('\n')[1]) : 0;
        const memoryUsage = memorySection ? parseFloat(memorySection.split('\n')[1]) : 0;
        const connections = connectionsSection ? parseInt(connectionsSection.split('\n')[1]) : 0;
        const bandwidth = bandwidthSection ? parseFloat(bandwidthSection.split('\n')[1]) : 0;
        
        const metrics: ServerMetrics = {
          cpuUsage,
          memoryUsage, 
          connections,
          bandwidth,
          latency: 0, // Будет заполнено позже
          timestamp: new Date()
        };

        resolve(metrics);
      } catch (error) {
        logger.error(`Ошибка при разборе метрик: ${error}`);
        resolve(null);
      }
    });
  });
}

/**
 * Возвращает историю метрик для сервера
 */
export function getServerMetricsHistory(serverId: number): ServerMetrics[] {
  return serverMetricsCache.get(serverId) || [];
}

/**
 * Проверяет перегруженность сервера на основе текущих метрик
 */
export function isServerOverloaded(serverId: number): boolean {
  const metrics = getServerMetricsHistory(serverId);
  if (metrics.length === 0) {
    return false;
  }
  
  const latestMetrics = metrics[metrics.length - 1];
  
  // Сервер считается перегруженным, если CPU > 80% или память > 85%
  return latestMetrics.cpuUsage > 80 || latestMetrics.memoryUsage > 85;
}

/**
 * Запускает процесс автомасштабирования при необходимости
 */
export async function checkAndAutoScale(): Promise<void> {
  try {
    logger.info('Запуск проверки автомасштабирования...');
    
    // Получаем все активные серверы
    const servers = await prisma.vpnServer.findMany({
      where: { isActive: true }
    });
    
    // Собираем метрики для всех серверов
    for (const server of servers) {
      await collectServerMetrics(server.id);
    }
    
    // Проверяем необходимость масштабирования
    let overloadedServersCount = 0;
    let availableCapacityServers = 0;
    
    for (const server of servers) {
      if (isServerOverloaded(server.id)) {
        overloadedServersCount++;
        logger.warn(`Сервер ${server.name} (ID: ${server.id}) перегружен`);
      } else {
        // Проверяем доступную ёмкость
        const subscriptionsCount = await prisma.subscription.count({
          where: {
            vpnServerId: server.id,
            status: 'ACTIVE'
          }
        });
        
        if (subscriptionsCount < server.maxClients * 0.7) {
          availableCapacityServers++;
        }
      }
    }
    
    // Если есть перегруженные серверы и нет свободных мощностей
    if (overloadedServersCount > 0 && availableCapacityServers === 0) {
      logger.info('Требуется развертывание нового сервера');
      // TODO: Реализовать автоматическое развертывание нового сервера
    }
    
    logger.info(`Проверка автомасштабирования завершена. Перегруженных серверов: ${overloadedServersCount}, Серверов со свободной ёмкостью: ${availableCapacityServers}`);
  } catch (error) {
    logger.error(`Ошибка при автомасштабировании: ${error}`);
  }
} 