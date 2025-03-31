import { CronJob } from 'cron';
import logger from '../utils/logger';
import { checkAndScale } from './autoscaling';

/**
 * Задачи, которые выполняются по расписанию
 */
const scheduledJobs: CronJob[] = [];

/**
 * Инициализация и запуск задач по расписанию
 */
export function initScheduler(): void {
  logger.info('Инициализация планировщика задач...');
  
  // Проверка и автомасштабирование серверов каждые 15 минут
  const autoscalingJob = new CronJob(
    '*/15 * * * *', // Каждые 15 минут
    async () => {
      logger.info('Запуск запланированной задачи: автомасштабирование серверов');
      try {
        await checkAndScale();
      } catch (error) {
        logger.error(`Ошибка при выполнении запланированного автомасштабирования: ${error}`);
      }
    },
    null, // onComplete
    false, // start
    'Europe/Moscow' // timeZone
  );
  
  // Добавляем задачу в список и запускаем
  scheduledJobs.push(autoscalingJob);
  autoscalingJob.start();
  
  logger.info(`Планировщик задач инициализирован. Запущено ${scheduledJobs.length} задач.`);
}

/**
 * Остановка всех запланированных задач
 */
export function stopScheduler(): void {
  logger.info('Остановка планировщика задач...');
  
  for (const job of scheduledJobs) {
    job.stop();
  }
  
  logger.info(`Планировщик задач остановлен. Остановлено ${scheduledJobs.length} задач.`);
} 