import QRCode from 'qrcode';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import config from '../config';

/**
 * Сервис для работы с QR-кодами
 */

/**
 * Генерирует QR-код для строки
 * @param text Текст/данные для кодирования в QR-код
 * @returns Буфер с изображением QR-кода
 */
export async function generateQRCode(text: string): Promise<Buffer> {
  try {
    // Опции для QR-кода
    const options = {
      errorCorrectionLevel: 'H', // High - максимальная коррекция ошибок
      type: 'png',
      quality: 0.92,
      margin: 1,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      },
      width: config.qrCodeSize,
    };

    // Генерируем QR-код в виде буфера
    return await QRCode.toBuffer(text, options);
  } catch (error: any) {
    logger.error(`Ошибка при генерации QR-кода: ${error.message}`);
    throw new Error(`Не удалось сгенерировать QR-код: ${error.message}`);
  }
}

/**
 * Генерирует QR-код для VPN конфигурации и сохраняет его во временный файл
 * @param configData Данные конфигурации VPN
 * @param userId ID пользователя (для уникальности имени файла)
 * @param subscriptionId ID подписки (для уникальности имени файла)
 * @returns Путь к сгенерированному QR-коду
 */
export async function generateVpnConfigQrCode(
  configData: string,
  userId: number,
  subscriptionId: number
): Promise<string> {
  try {
    // Создаем директорию для временных QR-кодов, если она не существует
    const tempDir = path.join(__dirname, '../../temp/qrcodes');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Генерируем уникальное имя файла
    const filename = `qrcode_${userId}_${subscriptionId}_${Date.now()}.png`;
    const filePath = path.join(tempDir, filename);

    // Генерируем QR-код и сохраняем его в файл
    const qrBuffer = await generateQRCode(configData);
    fs.writeFileSync(filePath, qrBuffer);

    return filePath;
  } catch (error: any) {
    logger.error(`Ошибка при генерации QR-кода для VPN: ${error.message}`);
    throw new Error(`Не удалось сгенерировать QR-код для VPN: ${error.message}`);
  }
}

/**
 * Удаляет временный файл QR-кода
 * @param filePath Путь к файлу QR-кода
 */
export function removeQrCodeFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logger.info(`Временный QR-код удален: ${filePath}`);
    }
  } catch (error: any) {
    logger.error(`Ошибка при удалении QR-кода: ${error.message}`);
  }
} 