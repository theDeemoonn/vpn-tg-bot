export const handleStart: CommandHandler = (bot: TelegramBot) => async (msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> => {
  try {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId) {
      logger.error('Получена команда /start без ID отправителя');
      return;
    }

    // Проверяем аргумент команды start
    const startParam = match ? match[1] : '';
    logger.info(`Получена команда /start с параметром: ${startParam || 'без параметра'}`);

    // Проверяем, является ли это возвращением после оплаты
    if (startParam && startParam.startsWith('payment_return_')) {
      const paymentId = startParam.replace('payment_return_', '');
      logger.info(`Обработка возврата после оплаты: ${paymentId}`);
      
      try {
        // Проверяем статус платежа
        const { checkPaymentStatus } = require('../../services/payment');
        const status = await checkPaymentStatus(paymentId);
        
        logger.info(`Проверен статус платежа ${paymentId} по возврату: ${status}`);
        
        // Находим платеж в базе данных
        const payment = await prisma.payment.findUnique({
          where: { id: paymentId },
          include: { user: true }
        });
        
        // Отправляем сообщение в зависимости от статуса платежа
        if (status === 'SUCCEEDED') {
          // Платеж успешный
          await bot.sendMessage(
            chatId,
            `✅ *Оплата успешно получена!*\n\nВаша подписка VPN активирована.\n\nИспользуйте команду /subscription для просмотра деталей и получения конфигурации.`,
            { 
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '📋 Моя подписка', callback_data: 'my_subscription' }]
                ]
              }
            }
          );
          
          // Пользователь вернулся в бот, отмечаем это в логах
          await prisma.paymentLog.create({
            data: {
              type: 'BOT_RETURN',
              paymentId: paymentId,
              data: JSON.stringify({
                telegramId: userId,
                timestamp: new Date().toISOString()
              })
            }
          }).catch(e => logger.warn(`Не удалось создать запись в логах: ${e}`));
          
          return;
        } else if (status === 'PENDING') {
          // Платеж ещё обрабатывается
          await bot.sendMessage(
            chatId,
            `⏱ *Платеж в обработке*\n\nВаш платеж ещё обрабатывается. Это может занять несколько минут. Мы уведомим вас, когда платеж будет подтвержден.`,
            { 
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔄 Проверить статус платежа', callback_data: `check_payment_${paymentId}` }]
                ]
              }
            }
          );
          return;
        } else {
          // Платеж не удался или отменен
          await bot.sendMessage(
            chatId,
            `❌ *Платеж не удался или был отменен*\n\nК сожалению, ваш платеж не был завершен успешно. Пожалуйста, попробуйте оплатить снова или выберите другой способ оплаты.`,
            { 
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '💳 Выбрать тариф', callback_data: 'buy' }],
                  [{ text: '🆘 Помощь', callback_data: 'help' }]
                ]
              }
            }
          );
          return;
        }
      } catch (paymentError) {
        logger.error(`Ошибка при проверке статуса платежа ${paymentId}: ${paymentError}`);
        
        // Отправляем общее сообщение об ошибке
        await bot.sendMessage(
          chatId,
          `⚠️ *Ошибка при проверке платежа*\n\nНе удалось проверить статус вашего платежа. Пожалуйста, используйте команду /subscription для проверки статуса подписки или /help для получения помощи.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }
    }

    // Далее обычная логика обработки команды /start
    // ... existing code ...
  } catch (error) {
    logger.error(`Ошибка при обработке команды /start: ${error}`);
  }
}; 