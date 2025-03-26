const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    // Создаем запись для администратора в User
    const admin = await prisma.user.upsert({
      where: { telegramId: BigInt(1) },
      update: {
        isAdmin: true,
        isActive: true,
      },
      create: {
        telegramId: BigInt(1),
        firstName: 'Admin',
        lastName: 'User',
        isAdmin: true,
        isActive: true,
      },
    });

    console.log('Создан администратор:', admin.firstName, admin.lastName);

    // Создаем настройки с учетными данными для входа
    const adminUsername = await prisma.setting.upsert({
      where: { key: 'ADMIN_USERNAME' },
      update: { value: 'admin' },
      create: {
        key: 'ADMIN_USERNAME',
        value: 'admin',
        description: 'Имя пользователя для входа в админ-панель',
      },
    });

    const adminPassword = await prisma.setting.upsert({
      where: { key: 'ADMIN_PASSWORD' },
      update: { value: 'admin123' },
      create: {
        key: 'ADMIN_PASSWORD',
        value: 'admin123',
        description: 'Пароль для входа в админ-панель',
      },
    });

    console.log('Настройки для админ-панели созданы:');
    console.log('- Логин:', adminUsername.value);
    console.log('- Пароль:', adminPassword.value);
  } catch (error) {
    console.error('Ошибка:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main(); 