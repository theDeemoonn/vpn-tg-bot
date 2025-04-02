import { PrismaClient } from '@prisma/client';
import { hash } from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('Начало заполнения базы данных...');
  
  // Создание администратора
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123'; // Измените на более безопасный пароль
  const adminTelegramId = process.env.ADMIN_TELEGRAM_ID || '123456789'; // Замените на ваш Telegram ID

  try {
    // Проверяем, существует ли уже администратор
    const existingAdmin = await prisma.user.findFirst({
      where: {
        telegramId: BigInt(adminTelegramId)
      }
    });

    if (!existingAdmin) {
      console.log('Создание администратора...');
      
      // Хешируем пароль
      const hashedPassword = await hash(adminPassword, 10);
      
      // Создаем администратора
      const admin = await prisma.user.create({
        data: {
          telegramId: BigInt(adminTelegramId),
          username: adminUsername,
          hashedPassword: hashedPassword,
          isAdmin: true,
          firstName: 'Admin',
          lastName: 'Admin',
          
        }
      });

      console.log('Администратор успешно создан:', {
        telegramId: admin.telegramId,
        username: admin.username,
        isAdmin: admin.isAdmin
      });
    } else {
      console.log('Администратор уже существует');
    }

    // Проверяем флаг для создания тестовых данных
    const createTestData = process.env.CREATE_TEST_DATA === 'true';
    
    if (createTestData) {
      console.log('Создание тестовых данных включено...');
      // Здесь можно добавить создание тестовых данных
    } else {
      console.log('Создание тестовых данных отключено...');
    }
    
    console.log('Заполнение базы данных завершено!');
  } catch (error) {
    console.error('Ошибка при создании администратора:', error);
    throw error;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });