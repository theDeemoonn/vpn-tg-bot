import { PrismaClient } from '@prisma/client';
import { hash } from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('Начало заполнения базы данных...');
  
  // Проверяем флаг для создания тестовых данных
  const createTestData = process.env.CREATE_TEST_DATA === 'true';
  
  if (createTestData) {
    console.log('Создание тестовых данных включено (но создание тестового сервера закомментировано)...');
  } else {
    console.log('Создание тестовых данных отключено...');
  }
  
  console.log('Заполнение базы данных завершено (большая часть кода закомментирована)! Убедитесь, что это соответствует вашим ожиданиям.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  }); 