import { PrismaClient } from '@prisma/client';
import { hash } from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('Начало заполнения базы данных...');
  
  // Создаем администратора
  const admin = await prisma.admin.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      password: await hash('admin', 10),
      email: 'admin@example.com',
      isActive: true
    }
  });
  
  console.log(`Создан администратор: ${admin.username}`);
  
  // Проверяем флаг для создания тестовых данных
  const createTestData = process.env.CREATE_TEST_DATA === 'true';
  
  if (createTestData) {
    console.log('Создание тестовых данных включено, добавляем тестовый сервер...');
    
    // Создаем тестовый VPN сервер только если указан флаг CREATE_TEST_DATA
    const testServer = await prisma.vpnServer.upsert({
      where: { id: 1 },
      update: {},
      create: {
        name: 'Test VPN Server',
        host: 'vpn.example.com',
        port: 1194,
        maxClients: 100,
        isActive: true,
        configData: `# Конфигурация сервера
# Это пример конфигурации
server {
  listen 80;
  server_name example.com;
}`,
        location: 'amsterdam',
        provider: 'test'
      }
    });
    
    console.log(`Создан тестовый VPN сервер: ${testServer.name}`);
    
    // Создаем тестовые тарифные планы
    const monthlyPlan = await prisma.plan.upsert({
      where: { id: 1 },
      update: {},
      create: {
        name: 'Месячный',
        description: 'Доступ к VPN на 1 месяц',
        price: 299,
        durationDays: 30,
        isActive: true
      }
    });
    
    const quarterlyPlan = await prisma.plan.upsert({
      where: { id: 2 },
      update: {},
      create: {
        name: 'Квартальный',
        description: 'Доступ к VPN на 3 месяца',
        price: 799,
        durationDays: 90,
        isActive: true
      }
    });
    
    const annualPlan = await prisma.plan.upsert({
      where: { id: 3 },
      update: {},
      create: {
        name: 'Годовой',
        description: 'Доступ к VPN на 12 месяцев',
        price: 2999,
        durationDays: 365,
        isActive: true
      }
    });
    
    console.log(`Созданы тарифные планы: ${monthlyPlan.name}, ${quarterlyPlan.name}, ${annualPlan.name}`);
  } else {
    console.log('Создание тестовых данных отключено, пропускаем создание тестового сервера...');
    
    // Создаем только тарифные планы без тестового сервера
    const monthlyPlan = await prisma.plan.upsert({
      where: { id: 1 },
      update: {},
      create: {
        name: 'Месячный',
        description: 'Доступ к VPN на 1 месяц',
        price: 299,
        durationDays: 30,
        isActive: true
      }
    });
    
    const quarterlyPlan = await prisma.plan.upsert({
      where: { id: 2 },
      update: {},
      create: {
        name: 'Квартальный',
        description: 'Доступ к VPN на 3 месяца',
        price: 799,
        durationDays: 90,
        isActive: true
      }
    });
    
    const annualPlan = await prisma.plan.upsert({
      where: { id: 3 },
      update: {},
      create: {
        name: 'Годовой',
        description: 'Доступ к VPN на 12 месяцев',
        price: 2999,
        durationDays: 365,
        isActive: true
      }
    });
    
    console.log(`Созданы тарифные планы: ${monthlyPlan.name}, ${quarterlyPlan.name}, ${annualPlan.name}`);
  }
  
  console.log('Заполнение базы данных завершено!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  }); 