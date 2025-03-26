import axios from 'axios';
import { VpnServer, Subscription, User } from '@prisma/client';
import { prisma } from './database';
import config from '../config';
import logger from '../utils/logger';

// Генерация уникального UUID для пользователя
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Создание конфигурации для клиента Xray
export async function generateClientConfig(
  subscription: Subscription & { 
    vpnServer?: VpnServer; 
    user?: User 
  }
): Promise<string> {
  try {
    // Загружаем полную информацию о подписке, если не предоставлена
    let fullSubscription = subscription;
    
    if (!subscription.vpnServer || !subscription.user) {
      const loadedSubscription = await prisma.subscription.findUnique({
        where: { id: subscription.id },
        include: {
          vpnServer: true,
          user: true
        }
      });
      
      if (!loadedSubscription || !loadedSubscription.vpnServer || !loadedSubscription.user) {
        throw new Error(`Не удалось загрузить полную информацию о подписке ${subscription.id}`);
      }
      
      fullSubscription = loadedSubscription;
    }
    
    // Теперь мы уверены, что user и vpnServer существуют
    const vpnServer = fullSubscription.vpnServer!;
    const user = fullSubscription.user!;
    
    // Генерируем UUID для пользователя, если он еще не создан
    const userId = user.telegramId.toString();
    const uuid = generateUUID();

    // Базовый шаблон конфигурации клиента
    const config = {
      "log": {
        "loglevel": "warning"
      },
      "inbounds": [
        {
          "port": 10808,
          "listen": "127.0.0.1",
          "protocol": "socks",
          "settings": {
            "udp": true
          }
        },
        {
          "port": 10809,
          "listen": "127.0.0.1",
          "protocol": "http"
        }
      ],
      "outbounds": [
        {
          "protocol": "vless",
          "settings": {
            "vnext": [
              {
                "address": vpnServer.host,
                "port": 443,
                "users": [
                  {
                    "id": uuid,
                    "encryption": "none",
                    "flow": "xtls-rprx-vision"
                  }
                ]
              }
            ]
          },
          "streamSettings": {
            "network": "tcp",
            "security": "tls",
            "tlsSettings": {
              "serverName": vpnServer.host,
              "allowInsecure": false
            },
            "tcpSettings": {
              "header": {
                "type": "http",
                "request": {
                  "version": "1.1",
                  "method": "GET",
                  "path": ["/"],
                  "headers": {
                    "Host": [vpnServer.host],
                    "User-Agent": [
                      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.131 Safari/537.36"
                    ],
                    "Accept-Encoding": ["gzip, deflate"],
                    "Connection": ["keep-alive"],
                    "Pragma": "no-cache"
                  }
                }
              }
            }
          }
        }
      ],
      "routing": {
        "rules": [
          {
            "type": "field",
            "ip": ["geoip:private"],
            "outboundTag": "direct"
          }
        ]
      }
    };

    // Если торренты запрещены, добавляем правило блокировки P2P трафика
    if (!fullSubscription.torrentsAllowed) {
      config.routing.rules.push({
        "type": "field",
        "protocol": ["bittorrent"] as any,
        "outboundTag": "block"
      } as any);

      // Добавляем outbound для блокировки
      config.outbounds.push({
        "protocol": "blackhole",
        "tag": "block"
      } as any);
    }

    // Обновляем подписку с UUID и сохраняем конфигурацию
    await prisma.subscription.update({
      where: { id: fullSubscription.id },
      data: {
        vpnConfig: JSON.stringify(config)
      }
    });

    // Обновляем конфигурацию на сервере
    await updateServerConfig(vpnServer, uuid, fullSubscription);

    return JSON.stringify(config, null, 2);
  } catch (error) {
    logger.error(`Ошибка при генерации конфигурации клиента: ${error}`);
    throw new Error(`Не удалось сгенерировать конфигурацию: ${error}`);
  }
}

// Обновление конфигурации на VPN сервере
async function updateServerConfig(
  server: VpnServer, 
  clientUuid: string, 
  subscription: Subscription
): Promise<void> {
  try {
    // В реальном приложении здесь будет код для SSH-подключения к серверу
    // и обновления конфигурации Xray
    
    // Для примера, предположим что у нас есть API на сервере
    const serverApiUrl = `https://${server.host}:${server.port}/api/config`;
    
    // Данные для обновления
    const configData = {
      clientId: clientUuid,
      downloadSpeed: subscription.downloadSpeed,
      uploadSpeed: subscription.uploadSpeed,
      torrentsAllowed: subscription.torrentsAllowed,
      expirationDate: subscription.endDate
    };
    
    // Здесь должен быть код для безопасного обновления конфигурации
    // через SSH или API
    logger.info(`Обновление конфигурации на сервере ${server.name} для клиента ${clientUuid}`);
    
    // В реальном приложении это будет заменено на SSH-команды или API-запросы
    // await axios.post(serverApiUrl, configData);
  } catch (error) {
    logger.error(`Ошибка при обновлении конфигурации на сервере: ${error}`);
    throw new Error(`Не удалось обновить конфигурацию на сервере: ${error}`);
  }
}

// Создание подписки для пользователя
export async function createSubscription(
  userId: number,
  vpnServerId: number,
  durationInDays: number,
  downloadSpeed: number = config.defaultDownloadSpeed,
  uploadSpeed: number = config.defaultUploadSpeed,
  torrentsAllowed: boolean = config.torrentAllowed
): Promise<Subscription> {
  try {
    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + durationInDays);

    // Создаем подписку в базе данных
    const subscription = await prisma.subscription.create({
      data: {
        userId,
        vpnServerId,
        status: 'ACTIVE',
        startDate,
        endDate,
        autoRenewal: false,
        downloadSpeed,
        uploadSpeed,
        torrentsAllowed,
      },
      include: {
        user: true,
        vpnServer: true
      }
    });

    // Генерируем конфигурацию для клиента
    await generateClientConfig(subscription);

    // Увеличиваем счетчик клиентов на сервере
    await prisma.vpnServer.update({
      where: { id: vpnServerId },
      data: {
        currentClients: {
          increment: 1
        }
      }
    });

    return subscription;
  } catch (error) {
    logger.error(`Ошибка при создании подписки: ${error}`);
    throw new Error(`Не удалось создать подписку: ${error}`);
  }
}

// Выбор оптимального сервера для нового пользователя
export async function selectOptimalServer(): Promise<VpnServer> {
  try {
    // Находим активные сервера
    const activeServers = await prisma.vpnServer.findMany({
      where: {
        isActive: true
      }
    });

    if (activeServers.length === 0) {
      throw new Error('Нет доступных серверов');
    }

    // Выбираем сервер с наименьшим количеством клиентов
    const optimalServer = activeServers.reduce((min, server) => {
      return (server.currentClients / server.maxClients) < (min.currentClients / min.maxClients)
        ? server
        : min;
    }, activeServers[0]);

    // Проверяем, что сервер не переполнен
    if (optimalServer.currentClients >= optimalServer.maxClients) {
      throw new Error('Все серверы заполнены, необходимо добавить новый сервер');
    }

    return optimalServer;
  } catch (error) {
    logger.error(`Ошибка при выборе оптимального сервера: ${error}`);
    throw error;
  }
}

// Деактивация подписки
export async function deactivateSubscription(subscriptionId: number): Promise<Subscription> {
  try {
    const subscription = await prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        vpnServer: true,
        user: true
      }
    });

    if (!subscription) {
      throw new Error(`Подписка с ID ${subscriptionId} не найдена`);
    }

    // Обновляем статус подписки
    const updatedSubscription = await prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        status: 'EXPIRED'
      }
    });

    // Удаляем клиента с сервера
    await removeClientFromServer(subscription);

    // Уменьшаем счетчик клиентов на сервере
    await prisma.vpnServer.update({
      where: { id: subscription.vpnServerId },
      data: {
        currentClients: {
          decrement: 1
        }
      }
    });

    return updatedSubscription;
  } catch (error) {
    logger.error(`Ошибка при деактивации подписки: ${error}`);
    throw error;
  }
}

// Удаление клиента с сервера
async function removeClientFromServer(
  subscription: Subscription & { vpnServer: VpnServer; user: User }
): Promise<void> {
  try {
    // В реальном приложении здесь будет код для SSH-подключения к серверу
    // и удаления клиента из конфигурации Xray
    
    logger.info(`Удаление клиента с сервера ${subscription.vpnServer.name} для пользователя ${subscription.user.telegramId}`);
    
    // В реальном приложении это будет заменено на SSH-команды или API-запросы
  } catch (error) {
    logger.error(`Ошибка при удалении клиента с сервера: ${error}`);
    throw error;
  }
}

// Обновление параметров подписки
export async function updateSubscriptionParams(
  subscriptionId: number,
  params: {
    downloadSpeed?: number;
    uploadSpeed?: number;
    torrentsAllowed?: boolean;
  }
): Promise<Subscription> {
  try {
    const subscription = await prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        vpnServer: true,
        user: true
      }
    });

    if (!subscription) {
      throw new Error(`Подписка с ID ${subscriptionId} не найдена`);
    }

    // Обновляем параметры подписки
    const updatedSubscription = await prisma.subscription.update({
      where: { id: subscriptionId },
      data: params,
      include: {
        vpnServer: true,
        user: true
      }
    });

    // Получаем UUID из конфигурации
    const configObj = subscription.vpnConfig ? JSON.parse(subscription.vpnConfig) : null;
    const clientUuid = configObj?.outbounds[0]?.settings?.vnext[0]?.users[0]?.id;

    if (clientUuid) {
      // Обновляем конфигурацию на сервере
      await updateServerConfig(
        subscription.vpnServer,
        clientUuid,
        updatedSubscription
      );
    } else {
      // Если UUID не найден, генерируем новую конфигурацию
      await generateClientConfig(updatedSubscription);
    }

    return updatedSubscription;
  } catch (error) {
    logger.error(`Ошибка при обновлении параметров подписки: ${error}`);
    throw error;
  }
} 