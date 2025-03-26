// Temporary fix file
const TelegramBot = require("node-telegram-bot-api");
const { PrismaClient } = require("@prisma/client");
const config = require("../../config").default;
const logger = require("../../utils/logger").default;
const { SubscriptionPeriod, getPaymentAmount } = require("../../services/payment");

/**
 * Fixed handler for payment method selection to avoid Telegram Payment errors
 */
async function handleSelectPaymentMethod(bot, chatId, messageId, period) {
  try {
    const prisma = new PrismaClient();
    
    // Find user
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(chatId) }
    });
    
    if (!user) {
      await bot.sendMessage(chatId, "Пожалуйста, используйте /start для начала работы с ботом.");
      return;
    }
    
    // Create message with payment method selection
    const amount = getPaymentAmount(period);
    const periodName = period === SubscriptionPeriod.MONTHLY 
      ? "Месячный" 
      : period === SubscriptionPeriod.QUARTERLY 
        ? "Квартальный" 
        : "Годовой";
    
    const message = `
💳 *Выберите способ оплаты*

Тариф: ${periodName}
Сумма: ${amount} ₽

Выберите удобный способ оплаты:
    `;
    
    // Prepare keyboard with bank card only, disable Telegram Payments
    const keyboard = {
      inline_keyboard: [
        [{ text: "💳 Банковская карта", callback_data: `pay_card_${period}` }],
        [{ text: "⬅️ Назад", callback_data: "buy" }]
      ]
    };
    
    // Send message with payment method selection
    await bot.editMessageText(message, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "Markdown",
      reply_markup: keyboard
    });
    
    await prisma.$disconnect();
  } catch (error) {
    console.error(`Ошибка при выборе метода оплаты: ${error.message}`);
    await bot.sendMessage(chatId, "Произошла ошибка. Пожалуйста, попробуйте позже.");
  }
}

module.exports = { handleSelectPaymentMethod };
