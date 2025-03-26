import { User, Subscription, BonusType } from '@prisma/client';
import { nanoid } from 'nanoid';
import { prisma } from './database';
import logger from '../utils/logger';

// Длина реферального кода
const REFERRAL_CODE_LENGTH = 8;

// Генерация уникального реферального кода
export async function generateReferralCode(): Promise<string> {
  let isUnique = false;
  let referralCode = '';

  while (!isUnique) {
    referralCode = nanoid(REFERRAL_CODE_LENGTH);
    const existingUser = await prisma.user.findUnique({
      where: { referralCode }
    });
    isUnique = !existingUser;
  }

  return referralCode;
}

// Создание реферального кода для пользователя, если его нет
export async function ensureUserHasReferralCode(userId: number): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId }
  });

  if (!user) {
    throw new Error(`Пользователь с ID ${userId} не найден`);
  }

  if (user.referralCode) {
    return user.referralCode;
  }

  const referralCode = await generateReferralCode();
  
  await prisma.user.update({
    where: { id: userId },
    data: { referralCode }
  });

  logger.info(`Создан реферальный код ${referralCode} для пользователя ${userId}`);
  return referralCode;
}

// Обработка использования реферального кода
export async function processReferralCode(telegramId: number, referralCode: string): Promise<boolean> {
  try {
    // Находим пользователя, которого пригласили
    const invitedUser = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramId) }
    });

    if (!invitedUser) {
      throw new Error(`Пользователь с Telegram ID ${telegramId} не найден`);
    }

    // Если пользователь уже имеет реферера, игнорируем
    if (invitedUser.referrerId) {
      return false;
    }

    // Находим реферера по коду
    const referrer = await prisma.user.findUnique({
      where: { referralCode }
    });

    if (!referrer) {
      throw new Error(`Реферальный код ${referralCode} не найден`);
    }

    // Проверяем, что пользователь не пытается пригласить сам себя
    if (referrer.id === invitedUser.id) {
      throw new Error('Пользователь не может использовать свой собственный реферальный код');
    }

    // Обновляем данные пользователя
    await prisma.user.update({
      where: { id: invitedUser.id },
      data: { referrerId: referrer.id }
    });

    // Получаем активную реферальную программу
    const activeProgram = await prisma.referralProgram.findFirst({
      where: {
        isActive: true,
        OR: [
          { endDate: null },
          { endDate: { gt: new Date() } }
        ]
      }
    });

    if (activeProgram) {
      // Если бонус в виде дней, добавляем их реферу
      if (activeProgram.bonusType === BonusType.DAYS) {
        await prisma.user.update({
          where: { id: referrer.id },
          data: {
            referralBonus: {
              increment: activeProgram.bonusValue
            }
          }
        });

        logger.info(`Пользователь ${referrer.id} получил ${activeProgram.bonusValue} дней бонуса за приглашение пользователя ${invitedUser.id}`);
      }
    }

    logger.info(`Пользователь ${invitedUser.id} успешно использовал реферальный код ${referralCode}`);
    return true;
  } catch (error) {
    logger.error(`Ошибка при обработке реферального кода: ${error}`);
    throw error;
  }
}

// Применение реферального бонуса к подписке
export async function applyReferralBonus(userId: number, subscriptionId: number): Promise<Subscription> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      throw new Error(`Пользователь с ID ${userId} не найден`);
    }

    // Если у пользователя есть бонусные дни
    if (user.referralBonus > 0) {
      const subscription = await prisma.subscription.findUnique({
        where: { id: subscriptionId }
      });

      if (!subscription) {
        throw new Error(`Подписка с ID ${subscriptionId} не найдена`);
      }

      // Добавляем бонусные дни к подписке
      const newEndDate = new Date(subscription.endDate);
      newEndDate.setDate(newEndDate.getDate() + user.referralBonus);

      // Обновляем подписку и сбрасываем бонус
      const updatedSubscription = await prisma.subscription.update({
        where: { id: subscriptionId },
        data: {
          endDate: newEndDate
        }
      });

      await prisma.user.update({
        where: { id: userId },
        data: {
          referralBonus: 0
        }
      });

      logger.info(`Применен реферальный бонус ${user.referralBonus} дней к подписке ${subscriptionId}`);
      return updatedSubscription;
    }

    // Если бонуса нет, просто возвращаем подписку
    const subscription = await prisma.subscription.findUnique({
      where: { id: subscriptionId }
    });
    
    if (!subscription) {
      throw new Error(`Подписка с ID ${subscriptionId} не найдена`);
    }
    
    return subscription;
  } catch (error) {
    logger.error(`Ошибка при применении реферального бонуса: ${error}`);
    throw error;
  }
}

// Получение списка рефералов пользователя
export async function getUserReferrals(userId: number): Promise<User[]> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        referrals: true
      }
    });

    if (!user) {
      throw new Error(`Пользователь с ID ${userId} не найден`);
    }

    return user.referrals;
  } catch (error) {
    logger.error(`Ошибка при получении рефералов пользователя: ${error}`);
    throw error;
  }
}

// Управление реферальной программой
export async function createReferralProgram(
  name: string,
  bonusType: BonusType,
  bonusValue: number,
  endDate?: Date
): Promise<void> {
  try {
    await prisma.referralProgram.create({
      data: {
        name,
        bonusType,
        bonusValue,
        isActive: true,
        endDate
      }
    });

    logger.info(`Создана новая реферальная программа: ${name}`);
  } catch (error) {
    logger.error(`Ошибка при создании реферальной программы: ${error}`);
    throw error;
  }
}

// Деактивация реферальной программы
export async function deactivateReferralProgram(programId: number): Promise<void> {
  try {
    await prisma.referralProgram.update({
      where: { id: programId },
      data: {
        isActive: false
      }
    });

    logger.info(`Деактивирована реферальная программа: ${programId}`);
  } catch (error) {
    logger.error(`Ошибка при деактивации реферальной программы: ${error}`);
    throw error;
  }
} 