import { prisma } from './database';
import logger from '../utils/logger';
import config from '../config';
import { isServerOverloaded, collectServerMetrics } from './monitoring';

/**
 * Состояние автомасштабирования
 */
let isAutoscalingEnabled = false;
let isScalingInProgress = false;

/**
 * Включение/выключение автомасштабирования
 */
export function setAutoscalingEnabled(enabled: boolean): void {
  isAutoscalingEnabled = enabled;
  logger.info(`Автомасштабирование ${enabled ? 'включено' : 'выключено'}`);
}

/**
 * Возвращает статус автомасштабирования
 */
export function getAutoscalingStatus(): { enabled: boolean; inProgress: boolean } {
  return {
    enabled: isAutoscalingEnabled,
    inProgress: isScalingInProgress
  };
}

/**
 * Проверяет нагрузку на все серверы и автоматически масштабирует при необходимости
 */
export async function checkAndScale(): Promise<void> {
  if (!isAutoscalingEnabled || isScalingInProgress) {
    return;
  }

  try {
    isScalingInProgress = true;
    logger.info('Запуск проверки автоматического масштабирования...');

    // Получаем все активные серверы и их метрики
    const servers = await prisma.vpnServer.findMany({
      where: { isActive: true }
    });

    // Проверяем перегруженные серверы
    const overloadedServers: number[] = [];
    const availableServers: number[] = [];

    for (const server of servers) {
      // Собираем свежие метрики
      await collectServerMetrics(server.id);
      
      // Проверяем загрузку сервера
      if (isServerOverloaded(server.id)) {
        overloadedServers.push(server.id);
      } else {
        // Проверяем, сколько активных подписок на сервере
        const activeSubscriptions = await prisma.subscription.count({
          where: {
            vpnServerId: server.id,
            status: 'ACTIVE'
          }
        });
        
        // Если сервер загружен менее чем на 70%, считаем его доступным
        if (activeSubscriptions < server.maxClients * 0.7) {
          availableServers.push(server.id);
        }
      }
    }

    logger.info(`Результаты проверки: перегруженных серверов: ${overloadedServers.length}, доступных серверов: ${availableServers.length}`);

    // Если есть перегруженные серверы и нет доступных, создаем новый сервер
    if (overloadedServers.length > 0 && availableServers.length === 0) {
      await scaleUp();
    }
    
    // Если есть перегруженные серверы, перераспределяем пользователей
    if (overloadedServers.length > 0 && availableServers.length > 0) {
      await rebalanceUsers(overloadedServers, availableServers);
    }

    // Проверяем, можем ли мы отключить неиспользуемые серверы
    if (servers.length > 1 && availableServers.length > 1) {
      await scaleDown(availableServers);
    }

  } catch (error) {
    logger.error(`Ошибка при автоматическом масштабировании: ${error}`);
  } finally {
    isScalingInProgress = false;
  }
}

/**
 * Создание нового сервера (масштабирование вверх)
 */
async function scaleUp(): Promise<void> {
  try {
    logger.info('Запуск масштабирования вверх (создание нового сервера)...');

    // Получаем список доступных регионов для развертывания
    const regions = config.deploymentRegions || ['amsterdam', 'frankfurt', 'london'];
    
    // Выбираем случайный регион
    const selectedRegion = regions[Math.floor(Math.random() * regions.length)];
    
    // Генерируем имя для нового сервера
    const serverCount = await prisma.vpnServer.count();
    const serverName = `${selectedRegion.charAt(0).toUpperCase() + selectedRegion.slice(1)}-${serverCount + 1}`;
    
    // Развертываем новый сервер с автоматически выбранными параметрами
    // const result = await deployVpnServer({
    //   name: serverName,
    //   host: '', // будет заполнено при автоматическом развертывании
    //   location: selectedRegion,
    //   provider: config.defaultProvider || 'DigitalOcean',
    //   maxClients: config.defaultMaxClients || 100,
    //   isAutoScaled: true
    // });


  } catch (error) {
    logger.error(`Ошибка при масштабировании вверх: ${error}`);
  }
}

/**
 * Перераспределение пользователей между серверами
 */
async function rebalanceUsers(overloadedServers: number[], availableServers: number[]): Promise<void> {
  try {
    logger.info('Запуск перераспределения пользователей...');

    for (const overloadedServerId of overloadedServers) {
      // Получаем список пользователей для перемещения
      const subscriptions = await prisma.subscription.findMany({
        where: {
          vpnServerId: overloadedServerId,
          status: 'ACTIVE'
        },
        orderBy: {
          createdAt: 'desc'  // Сначала перемещаем самых новых пользователей
        },
        take: 10  // Перемещаем по 10 пользователей за раз
      });

      if (subscriptions.length === 0) continue;

      // Находим наименее загруженный доступный сервер
      let targetServerId = availableServers[0];
      let minLoad = Number.MAX_SAFE_INTEGER;

      for (const serverId of availableServers) {
        const subscriptionCount = await prisma.subscription.count({
          where: {
            vpnServerId: serverId,
            status: 'ACTIVE'
          }
        });
        
        const server = await prisma.vpnServer.findUnique({
          where: { id: serverId }
        });
        
        if (server && subscriptionCount < minLoad) {
          minLoad = subscriptionCount;
          targetServerId = serverId;
        }
      }

      // Перемещаем пользователей
      for (const subscription of subscriptions) {
        await prisma.subscription.update({
          where: { id: subscription.id },
          data: { vpnServerId: targetServerId }
        });
        
        logger.info(`Подписка ${subscription.id} перемещена с сервера ${overloadedServerId} на сервер ${targetServerId}`);
        
        // TODO: Обновить VPN конфигурацию для пользователя
      }

      logger.info(`Перемещено ${subscriptions.length} пользователей с сервера ${overloadedServerId} на сервер ${targetServerId}`);
    }
  } catch (error) {
    logger.error(`Ошибка при перераспределении пользователей: ${error}`);
  }
}

/**
 * Отключение неиспользуемых серверов (масштабирование вниз)
 */
async function scaleDown(availableServers: number[]): Promise<void> {
  try {
    logger.info('Проверка необходимости масштабирования вниз...');

    // Находим серверы с самой низкой нагрузкой
    const serversWithLoad: { id: number; load: number }[] = [];

    for (const serverId of availableServers) {
      const subscriptionCount = await prisma.subscription.count({
        where: {
          vpnServerId: serverId,
          status: 'ACTIVE'
        }
      });
      
      const server = await prisma.vpnServer.findUnique({
        where: { id: serverId }
      });
      
      if (server) {
        serversWithLoad.push({
          id: serverId,
          load: subscriptionCount / server.maxClients
        });
      }
    }

    // Сортируем серверы по нагрузке (от самых малонагруженных к самым загруженным)
    serversWithLoad.sort((a, b) => a.load - b.load);

    // Если есть серверы с нагрузкой менее 10% и имеется более одного доступного сервера
    if (serversWithLoad.length > 1 && serversWithLoad[0].load < 0.1) {
      const serverToShutDown = serversWithLoad[0].id;
      
      // Проверяем, что у сервера есть пометка auto-scaled
      const server = await prisma.vpnServer.findUnique({
        where: { id: serverToShutDown }
      });
      
      if (server && server.isAutoScaled) {
        // Перемещаем всех пользователей на другие серверы
        const subscriptions = await prisma.subscription.findMany({
          where: {
            vpnServerId: serverToShutDown,
            status: 'ACTIVE'
          }
        });
        
        // Перемещаем пользователей на второй наименее загруженный сервер
        if (subscriptions.length > 0 && serversWithLoad.length > 1) {
          const targetServerId = serversWithLoad[1].id;
          
          for (const subscription of subscriptions) {
            await prisma.subscription.update({
              where: { id: subscription.id },
              data: { vpnServerId: targetServerId }
            });
            
            logger.info(`Подписка ${subscription.id} перемещена с сервера ${serverToShutDown} на сервер ${targetServerId} при масштабировании вниз`);
            
            // TODO: Обновить VPN конфигурацию для пользователя
          }
        }
        
        // Отключаем сервер
        await prisma.vpnServer.update({
          where: { id: serverToShutDown },
          data: { isActive: false }
        });
        
        logger.info(`Сервер ${server.name} (ID: ${serverToShutDown}) отключен при масштабировании вниз`);
        
        // TODO: Реализовать фактическое отключение/уничтожение серверной инфраструктуры
      }
    }
  } catch (error) {
    logger.error(`Ошибка при масштабировании вниз: ${error}`);
  }
} 