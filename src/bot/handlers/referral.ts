import TelegramBot, { Message } from 'node-telegram-bot-api';
import { prisma } from '../../services/database';
import { ensureUserHasReferralCode, getUserReferrals } from '../../services/referral';
import logger from '../../utils/logger';
import { MessageHandler } from './types';

/**
 * Обработчик команды /referral
 * @param bot - экземпляр Telegram бота
 */
export const handleReferral: MessageHandler = (bot: TelegramBot) => async (message: Message): Promise<void> => {
  try {
    const chatId = message.chat.id;
    const telegramId = message.from?.id || 0;
    
    // Находим пользователя
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramId) }
    });
    
    if (!user) {
      bot.sendMessage(chatId, 'Пожалуйста, используйте /start для начала работы с ботом.');
      return;
    }
    
    // Создаем или получаем реферальный код пользователя
    const referralCode = await ensureUserHasReferralCode(user.id);
    
    // Получаем список рефералов пользователя
    const referrals = await getUserReferrals(user.id);
    
    // Получаем активную реферальную программу
    // Примечание: если таблица referralProgram не существует, нужно её создать
    const activeProgram = await prisma.$queryRaw`
      SELECT * FROM "ReferralProgram" 
      WHERE "isActive" = true AND ("endDate" IS NULL OR "endDate" > NOW())
      LIMIT 1
    `;
    
    // Формируем сообщение о реферальной программе
    let referralMessage = `
👥 *Реферальная программа*

Ваш реферальный код: \`${referralCode}\`

🔗 Поделитесь этой ссылкой с друзьями:
\`https://t.me/${(await bot.getMe()).username}?start=${referralCode}\`

`;
    
    if (activeProgram && Array.isArray(activeProgram) && activeProgram.length > 0) {
      const program = activeProgram[0];
      referralMessage += `
🎁 *Текущая программа: ${program.name}*
`;
      
      if (program.bonusType === 'DAYS') {
        referralMessage += `Вы получите ${program.bonusValue} дней VPN бесплатно за каждого приглашенного друга, который оформит подписку.`;
      } else if (program.bonusType === 'DISCOUNT') {
        referralMessage += `Вы получите скидку ${program.bonusValue}% на следующую подписку за каждого приглашенного друга.`;
      }
    }
    
    // Получаем бонусы пользователя
    const userBonus = await prisma.$queryRaw`
      SELECT "referralBonus" FROM "User" WHERE "id" = ${user.id}
    `;
    
    // Информация о накопленном бонусе
    if (userBonus && Array.isArray(userBonus) && userBonus.length > 0 && userBonus[0].referralBonus > 0) {
      referralMessage += `\n\n🔥 У вас накоплено ${userBonus[0].referralBonus} бонусных дней. Они автоматически применятся при следующей покупке!`;
    }
    
    // Информация о приглашенных пользователях
    referralMessage += `\n\n👥 Вы пригласили: ${referrals.length} пользователей`;
    
    if (referrals.length > 0) {
      referralMessage += `\n\n*Ваши рефералы:*\n`;
      
      for (let i = 0; i < Math.min(referrals.length, 5); i++) {
        const referral = referrals[i];
        referralMessage += `${i + 1}. ${referral.firstName} ${referral.lastName || ''} (${new Date(referral.createdAt).toLocaleDateString()})\n`;
      }
      
      if (referrals.length > 5) {
        referralMessage += `и еще ${referrals.length - 5} пользователей...\n`;
      }
    }
    
    // Клавиатура с кнопками для реферальной программы
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📤 Поделиться кодом', switch_inline_query: `Привет! Я использую надежный VPN сервис. Присоединяйся по моей реферальной ссылке: https://t.me/${(await bot.getMe()).username}?start=${referralCode}` }
          ],
          [
            { text: '🔙 Назад', callback_data: 'main_menu' }
          ]
        ]
      },
      parse_mode: 'Markdown' as TelegramBot.ParseMode
    };
    
    await bot.sendMessage(chatId, referralMessage, keyboard);
  } catch (error) {
    logger.error(`Ошибка при обработке команды /referral: ${error}`);
    bot.sendMessage(message.chat.id, '😞 Произошла ошибка. Пожалуйста, попробуйте позже.');
  }
}; 