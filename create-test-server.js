// Скрипт для создания тестового VPN сервера
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    // Проверяем, есть ли уже VPN серверы
    const existingServers = await prisma.vpnServer.findMany();
    console.log(`Найдено ${existingServers.length} VPN серверов`);
    
    if (existingServers.length > 0) {
      console.log('Существующие серверы:');
      existingServers.forEach(server => {
        console.log(`ID: ${server.id}, Имя: ${server.name}, Хост: ${server.host}`);
      });
    } else {
      // Создаем тестовый сервер
      const newServer = await prisma.vpnServer.create({
        data: {
          name: 'Test VPN Server',
          host: 'vpn.example.com',
          port: 1194,
          location: 'Default Location',
          provider: 'Default Provider',
          isActive: true,
          maxClients: 100,
          currentClients: 0
        }
      });
      
      console.log('Создан тестовый VPN сервер:', newServer);
    }
  } catch (error) {
    console.error('Ошибка при создании тестового VPN сервера:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main(); 