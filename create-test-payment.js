const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function createTestPayment() {
  try {
    const testPaymentId = '22e12f66-000f-5000-8000-18db351245c7'; // Используем тот же ID, что и в вебхуке
    
    // Проверяем, существует ли пользователь с ID 2 (как указано в вебхуке)
    const user = await prisma.user.findUnique({
      where: { id: 2 }
    });
    
    if (!user) {
      console.error('Пользователь с ID 2 не найден. Создаем его...');
      // Создаем пользователя, если он не существует
      await prisma.user.create({
        data: {
          id: 2,
          telegramId: 12345678n, // Пример Telegram ID
          firstName: 'Тестовый',
          lastName: 'Пользователь',
          isActive: true
        }
      });
      console.log('Создан тестовый пользователь с ID 2');
    }
    
    // Создаем тестовый платеж
    const payment = await prisma.payment.create({
      data: {
        id: testPaymentId,
        userId: 2,
        amount: 299.0,
        currency: 'RUB',
        status: 'PENDING',
        description: 'Месячная подписка на VPN сервис',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // Платеж активен 24 часа
      }
    });
    
    console.log('Создан тестовый платеж:', payment);
    
  } catch (error) {
    console.error('Ошибка при создании тестового платежа:', error);
  } finally {
    await prisma.$disconnect();
  }
}

createTestPayment(); 