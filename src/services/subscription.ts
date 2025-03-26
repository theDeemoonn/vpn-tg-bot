import { PrismaClient, Subscription, SubscriptionStatus, ReminderStatus, Payment, PaymentStatus } from '@prisma/client';
import { logger } from '../utils/logger';
import * as paymentService from './payment';
import * as userService from './user';
import bot from '../bot';
import { prisma } from './database';

/**
 * Сервис для управления подписками и автопродлением
 */

/**
 * Проверяет подписки, которые заканчиваются в ближайшие дни и отправляет напоминания
 */
export async function sendSubscriptionReminders() {
  const now = new Date();
  
  // Проверяем подписки, которые заканчиваются через 7, 3 и 1 день
  const oneDay = 24 * 60 * 60 * 1000;
  const threeDays = 3 * oneDay;
  const sevenDays = 7 * oneDay;
  
  try {
    // Получаем активные подписки
    const activeSubscriptions = await prisma.subscription.findMany({
      where: {
        status: SubscriptionStatus.ACTIVE,
        endDate: {
          gt: now,
        },
      },
      include: {
        user: true,
      },
    });
    
    for (const subscription of activeSubscriptions) {
      const timeLeft = subscription.endDate.getTime() - now.getTime();
      
      // Подписка заканчивается через 7 дней (первое напоминание)
      if (
        timeLeft <= sevenDays && 
        timeLeft > threeDays && 
        subscription.reminderStatus !== ReminderStatus.FIRST_SENT &&
        subscription.reminderStatus !== ReminderStatus.SECOND_SENT &&
        subscription.reminderStatus !== ReminderStatus.FINAL_SENT
      ) {
        await sendReminderMessage(subscription, 7);
        await prisma.subscription.update({
          where: { id: subscription.id },
          data: { 
            reminderStatus: ReminderStatus.FIRST_SENT,
            lastReminderSent: now,
          },
        });
      }
      
      // Подписка заканчивается через 3 дня (второе напоминание)
      else if (
        timeLeft <= threeDays && 
        timeLeft > oneDay && 
        subscription.reminderStatus !== ReminderStatus.SECOND_SENT &&
        subscription.reminderStatus !== ReminderStatus.FINAL_SENT
      ) {
        await sendReminderMessage(subscription, 3);
        await prisma.subscription.update({
          where: { id: subscription.id },
          data: { 
            reminderStatus: ReminderStatus.SECOND_SENT,
            lastReminderSent: now,
          },
        });
      }
      
      // Подписка заканчивается через 1 день (финальное напоминание)
      else if (
        timeLeft <= oneDay && 
        subscription.reminderStatus !== ReminderStatus.FINAL_SENT
      ) {
        await sendReminderMessage(subscription, 1);
        await prisma.subscription.update({
          where: { id: subscription.id },
          data: { 
            reminderStatus: ReminderStatus.FINAL_SENT,
            lastReminderSent: now,
          },
        });
      }
    }
    
    logger.info(`Отправлены напоминания о продлении подписок`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка';
    logger.error(`Ошибка при отправке напоминаний о продлении: ${errorMessage}`);
  }
}

/**
 * Отправляет сообщение с напоминанием о продлении подписки
 */
async function sendReminderMessage(subscription: Subscription & { user: any }, daysLeft: number) {
  const { user } = subscription;
  
  const message = `🔄 *Напоминание о подписке*\n\n`
    + `Ваша VPN-подписка заканчивается через *${daysLeft} ${getDaysText(daysLeft)}*.\n\n`
    + (subscription.autoRenewal 
        ? `✅ У вас включено автопродление. Оплата будет списана автоматически.\n\nЕсли вы хотите отключить автопродление, перейдите в раздел "Мои подписки".` 
        : `❗️ Автопродление не включено. Чтобы продлить подписку, перейдите в раздел "Мои подписки" и нажмите кнопку "Продлить".\n\nТакже вы можете включить автопродление, чтобы не беспокоиться о продлении в будущем.`);
  
  try {
    await bot.sendMessage(user.telegramId.toString(), message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Мои подписки', callback_data: 'my_subscriptions' }
          ],
          [
            subscription.autoRenewal
              ? { text: 'Отключить автопродление', callback_data: `disable_auto_renewal_${subscription.id}` }
              : { text: 'Включить автопродление', callback_data: `enable_auto_renewal_${subscription.id}` }
          ]
        ]
      }
    });
    logger.info(`Отправлено напоминание пользователю ${user.telegramId} о подписке ${subscription.id}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка';
    logger.error(`Ошибка при отправке напоминания пользователю ${user.telegramId}: ${errorMessage}`);
  }
}

/**
 * Склонение дней в зависимости от числа
 */
function getDaysText(days: number): string {
  if (days === 1) return 'день';
  if (days >= 2 && days <= 4) return 'дня';
  return 'дней';
}

/**
 * Процесс автоматического продления подписок
 */
export async function processAutoRenewals() {
  const now = new Date();
  
  try {
    // Получаем подписки для автопродления, которые заканчиваются в течение 24 часов
    const subscriptionsToRenew = await prisma.subscription.findMany({
      where: {
        status: SubscriptionStatus.ACTIVE,
        autoRenewal: true,
        autoRenewalFailed: false,
        endDate: {
          lt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          gt: now,
        },
      },
      include: {
        user: true,
      },
    });
    
    logger.info(`Найдено ${subscriptionsToRenew.length} подписок для автопродления`);
    
    for (const subscription of subscriptionsToRenew) {
      // Создаем новый платеж для автопродления
      try {
        // Находим предыдущий успешный платеж для определения суммы
        const lastPayment = await prisma.payment.findFirst({
          where: {
            subscriptionId: subscription.id,
            status: PaymentStatus.SUCCEEDED,
          },
          orderBy: {
            createdAt: 'desc',
          },
        });
        
        if (!lastPayment) {
          logger.error(`Не найден предыдущий платеж для подписки ${subscription.id}`);
          continue;
        }
        
        // Создаем новый платеж с той же суммой
        const paymentResult = await paymentService.createAutoRenewalPayment(
          subscription.userId,
          subscription.id,
          lastPayment.amount,
          `Автопродление VPN-подписки`
        );
        
        if (paymentResult.success) {
          // Обновляем ID платежа для автопродления
          await prisma.subscription.update({
            where: { id: subscription.id },
            data: { renewalPaymentId: paymentResult.paymentId },
          });
          
          logger.info(`Создан платеж для автопродления подписки ${subscription.id}: ${paymentResult.paymentId}`);
          
          // Отправляем уведомление об успешном автопродлении
          await bot.sendMessage(
            subscription.user.telegramId.toString(),
            `✅ *Автопродление подписки*\n\n`
            + `Мы создали платеж для автоматического продления вашей VPN-подписки.\n`
            + `Сумма: ${lastPayment.amount} ${lastPayment.currency}\n\n`
            + `Спасибо, что пользуетесь нашим сервисом!`,
            { parse_mode: 'Markdown' }
          );
        } else {
          // Помечаем подписку как с неудачным автопродлением
          await prisma.subscription.update({
            where: { id: subscription.id },
            data: { autoRenewalFailed: true },
          });
          
          logger.error(`Ошибка создания платежа для автопродления подписки ${subscription.id}: ${paymentResult.error}`);
          
          // Отправляем уведомление о неудачном автопродлении
          await bot.sendMessage(
            subscription.user.telegramId.toString(),
            `❌ *Ошибка автопродления*\n\n`
            + `К сожалению, мы не смогли создать платеж для автоматического продления вашей VPN-подписки.\n\n`
            + `Пожалуйста, продлите подписку вручную в разделе "Мои подписки".`,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: 'Мои подписки', callback_data: 'my_subscriptions' }]
                ]
              }
            }
          );
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка';
        logger.error(`Ошибка при автопродлении подписки ${subscription.id}: ${errorMessage}`);
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка';
    logger.error(`Ошибка при обработке автопродлений: ${errorMessage}`);
  }
}

/**
 * Обновляет статус подписок (активные/истекшие)
 */
export async function updateSubscriptionStatuses() {
  const now = new Date();
  
  try {
    // Помечаем истекшие подписки
    const expiredSubscriptions = await prisma.subscription.updateMany({
      where: {
        status: SubscriptionStatus.ACTIVE,
        endDate: {
          lt: now,
        },
      },
      data: {
        status: SubscriptionStatus.EXPIRED,
      },
    });
    
    logger.info(`Обновлено ${expiredSubscriptions.count} истекших подписок`);
    
    // Получаем данные об истекших подписках для отправки уведомлений
    const newlyExpiredSubscriptions = await prisma.subscription.findMany({
      where: {
        status: SubscriptionStatus.EXPIRED,
        updatedAt: {
          gte: new Date(now.getTime() - 60 * 60 * 1000), // Истекшие за последний час
        },
      },
      include: {
        user: true,
      },
    });
    
    // Отправляем уведомления об истечении подписки
    for (const subscription of newlyExpiredSubscriptions) {
      try {
        await bot.sendMessage(
          subscription.user.telegramId.toString(),
          `⚠️ *Ваша VPN-подписка истекла*\n\n`
          + `Для продолжения использования VPN, пожалуйста, продлите вашу подписку.`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: 'Продлить подписку', callback_data: `renew_subscription_${subscription.id}` }]
              ]
            }
          }
        );
      } catch (error: any) {
        logger.error(`Ошибка при отправке уведомления об истечении подписки ${subscription.id}: ${error.message}`);
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка';
    logger.error(`Ошибка при обновлении статусов подписок: ${errorMessage}`);
  }
}

/**
 * Включает автопродление для подписки
 */
export async function enableAutoRenewal(subscriptionId: number) {
  try {
    await prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        autoRenewal: true,
        autoRenewalFailed: false, // Сбрасываем флаг неудачного автопродления
      },
    });
    return { success: true };
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Ошибка при включении автопродления для подписки ${subscriptionId}: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

/**
 * Отключает автопродление для подписки
 */
export async function disableAutoRenewal(subscriptionId: number) {
  try {
    await prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        autoRenewal: false,
      },
    });
    return { success: true };
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Ошибка при отключении автопродления для подписки ${subscriptionId}: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
} 