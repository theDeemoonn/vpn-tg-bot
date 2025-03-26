import { prisma } from './database';
import { logger } from '../utils/logger';

/**
 * Сервис для работы с FAQ (часто задаваемыми вопросами)
 */

/**
 * Получение всех активных FAQ, сгруппированных по категориям
 */
export async function getAllFaqGroupedByCategory() {
  try {
    const faqItems = await prisma.faqItem.findMany({
      where: {
        isActive: true,
      },
      orderBy: [
        { category: 'asc' },
        { orderIndex: 'asc' },
      ],
    });

    // Группируем вопросы по категориям
    const groupedFaq = faqItems.reduce((acc, item) => {
      if (!acc[item.category]) {
        acc[item.category] = [];
      }
      acc[item.category].push(item);
      return acc;
    }, {});

    return { success: true, data: groupedFaq };
  } catch (error) {
    logger.error(`Ошибка при получении FAQ: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Поиск по FAQ
 */
export async function searchFaq(query: string) {
  try {
    const searchQuery = query.toLowerCase();
    
    const faqItems = await prisma.faqItem.findMany({
      where: {
        isActive: true,
        OR: [
          {
            question: {
              contains: searchQuery,
              mode: 'insensitive',
            },
          },
          {
            answer: {
              contains: searchQuery,
              mode: 'insensitive',
            },
          },
        ],
      },
      orderBy: [
        { category: 'asc' },
        { orderIndex: 'asc' },
      ],
    });

    return { success: true, data: faqItems };
  } catch (error) {
    logger.error(`Ошибка при поиске по FAQ: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Получение FAQ по категории
 */
export async function getFaqByCategory(category: string) {
  try {
    const faqItems = await prisma.faqItem.findMany({
      where: {
        isActive: true,
        category,
      },
      orderBy: {
        orderIndex: 'asc',
      },
    });

    return { success: true, data: faqItems };
  } catch (error) {
    logger.error(`Ошибка при получении FAQ по категории: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Получение всех категорий FAQ
 */
export async function getAllFaqCategories() {
  try {
    const categories = await prisma.faqItem.findMany({
      where: {
        isActive: true,
      },
      select: {
        category: true,
      },
      distinct: ['category'],
      orderBy: {
        category: 'asc',
      },
    });

    return { success: true, data: categories.map(c => c.category) };
  } catch (error) {
    logger.error(`Ошибка при получении категорий FAQ: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Создание нового FAQ
 */
export async function createFaqItem(data: {
  question: string;
  answer: string;
  category: string;
  orderIndex?: number;
}) {
  try {
    const faqItem = await prisma.faqItem.create({
      data,
    });

    return { success: true, data: faqItem };
  } catch (error) {
    logger.error(`Ошибка при создании FAQ: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Обновление FAQ
 */
export async function updateFaqItem(
  id: number,
  data: {
    question?: string;
    answer?: string;
    category?: string;
    orderIndex?: number;
    isActive?: boolean;
  }
) {
  try {
    const faqItem = await prisma.faqItem.update({
      where: { id },
      data,
    });

    return { success: true, data: faqItem };
  } catch (error) {
    logger.error(`Ошибка при обновлении FAQ (ID: ${id}): ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Удаление FAQ
 */
export async function deleteFaqItem(id: number) {
  try {
    await prisma.faqItem.delete({
      where: { id },
    });

    return { success: true };
  } catch (error) {
    logger.error(`Ошибка при удалении FAQ (ID: ${id}): ${error.message}`);
    return { success: false, error: error.message };
  }
} 