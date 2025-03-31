import { prisma } from './database';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger';
import config from '../config';
import * as deploymentService from './deployment';

/**
 * Инициализация сервера при первом запуске системы
 * Проверяет наличие серверов в базе данных и создает новый, если нет
 */
export async function initializeRealServer(): Promise<void> {
  try {
    const serversCount = await prisma.vpnServer.count();
    
    if (serversCount === 0) {
      logger.info('Серверы не найдены. Инициализация первого реального сервера...');
      
      const localIp = process.env.HOST || 'localhost';
      const serverPort = process.env.PORT || '3000';
      
      // Создаем запись о локальном сервере, который будет управлять VPN
      const localServer = await prisma.vpnServer.create({
        data: {
          name: 'Основной сервер',
          host: localIp,
          port: 1194,
          maxClients: config.defaultMaxClients,
          isActive: true,
          configData: `# Базовая конфигурация OpenVPN сервера
port 1194
proto udp
dev tun
ca ca.crt
cert server.crt
key server.key
dh dh.pem
server 10.8.0.0 255.255.255.0
ifconfig-pool-persist ipp.txt
push "redirect-gateway def1 bypass-dhcp"
push "dhcp-option DNS 8.8.8.8"
push "dhcp-option DNS 8.8.4.4"
keepalive 10 120
cipher AES-256-GCM
auth SHA256
user nobody
group nogroup
persist-key
persist-tun
status openvpn-status.log
verb 3`,
          location: 'local',
          provider: 'local'
        }
      });
      
      logger.info(`Создан локальный сервер с ID: ${localServer.id}`);
      
      // Если настроено автоматическое развертывание, создаем первый VPN-сервер
      if (config.doApiKey && config.doSshKeyId) {
        logger.info('Обнаружены настройки для автоматического развертывания. Создание первого VPN-сервера...');
        
        // Выбираем регион из доступных
        const regions = config.deploymentRegions || ['amsterdam'];
        const selectedRegion = regions[0];
        
        // Создаем первый реальный VPN-сервер
        const deploymentResult = await deploymentService.deployVpnServer({
          name: `${selectedRegion.charAt(0).toUpperCase() + selectedRegion.slice(1)}-1`,
          location: selectedRegion,
          provider: config.defaultProvider,
          maxClients: config.defaultMaxClients,
          isAutoScaled: false
        });
        
        if (deploymentResult.success) {
          logger.info(`Успешно запущено развертывание первого VPN-сервера (ID: ${deploymentResult.serverId})`);
        } else {
          logger.error(`Ошибка при развертывании первого сервера: ${deploymentResult.error}`);
        }
      } else {
        logger.warn('Настройки для автоматического развертывания не обнаружены. Необходимо вручную настроить .env файл.');
      }
    } else {
      logger.info(`Найдено серверов в базе данных: ${serversCount}. Пропускаем инициализацию.`);
    }
  } catch (error: any) {
    logger.error(`Ошибка при инициализации сервера: ${error.message}`);
  }
}

// ... existing code ... 