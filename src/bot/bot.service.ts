const qrCodeDataUrl = await QRCode.toDataURL(vlessUrl);

// 5. Отправить конфигурацию пользователю
// Исправляем: используем vlessUrl вместо неопределенной configUrl
await ctx.replyWithHTML(`Ваша ссылка для подключения (скопируйте):
<code>${vlessUrl}</code>`);

// Отправка QR-кода как фото
const base64Data = qrCodeDataUrl.replace(/^data:image\/png;base64,/, ""); 