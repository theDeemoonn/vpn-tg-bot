import { CronJob } from 'cron';
import { checkAllServerAccess } from '../services/accessControl.service';
import logger from '../utils/logger';

// Запускать каждый день в 4:05 утра по времени сервера
// Формат: Секунды Минуты Часы Дни Месяцы Дни_недели
// const cronTime = '0 5 4 * * *';
// Для тестирования можно запускать чаще, например, каждые 5 минут:
const cronTime = '0 */5 * * * *'; // Каждые 5 минут

let job: CronJob | null = null;
let isJobRunning = false; // Простой флаг для предотвращения параллельного запуска

export function startAccessControlJob(): void {
  if (job && job.running) {
    logger.warn('[CronJob AccessControl] Попытка запустить уже работающую задачу.');
    return;
  }

  job = new CronJob(
    cronTime,
    async () => {
      if (isJobRunning) {
          logger.warn('[CronJob AccessControl] Предыдущий запуск задачи еще не завершен. Пропуск текущего.');
          return;
      }
      isJobRunning = true;
      logger.info(`[CronJob AccessControl] Запуск задачи по расписанию (${cronTime})...`);
      try {
        await checkAllServerAccess();
        logger.info('[CronJob AccessControl] Задача успешно завершена.');
      } catch (error: any) {
        logger.error(`[CronJob AccessControl] Ошибка при выполнении задачи: ${error.message}`, error);
      } finally {
        isJobRunning = false; // Сбрасываем флаг после завершения (успешного или с ошибкой)
        if (job) {
            try {
                 // Логируем следующий запуск, если job все еще существует
                 logger.info(`[CronJob AccessControl] Следующий запуск: ${job.nextDate().toFormat('DD.MM.YYYY HH:mm:ss ZZZZ')}`);
            } catch(e) {
                logger.warn('[CronJob AccessControl] Не удалось определить время следующего запуска.');
            }
        }
      }
    },
    null, // onComplete
    false, // start - не запускаем сразу при создании
    'Europe/Moscow' // Timezone - !!! ВАЖНО: Установите свою таймзону !!!
    // Список таймзон: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
  );

  job.start(); // Запускаем задачу
   try {
      logger.info(`[CronJob AccessControl] Задача контроля доступа запланирована (${cronTime}). Первый запуск: ${job.nextDate().toFormat('DD.MM.YYYY HH:mm:ss ZZZZ')}`);
   } catch(e) {
       logger.error('[CronJob AccessControl] Не удалось создать или запланировать задачу.', e);
   }
}

export function stopAccessControlJob(): void {
  if (job && job.running) {
    job.stop();
    logger.info('[CronJob AccessControl] Задача контроля доступа остановлена.');
  }
   isJobRunning = false; // Сбрасываем флаг при остановке
}

// Обработка сигналов для корректного завершения
process.on('SIGINT', () => {
  logger.info('[Process] Получен SIGINT. Остановка cron задачи...');
  stopAccessControlJob();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('[Process] Получен SIGTERM. Остановка cron задачи...');
  stopAccessControlJob();
  process.exit(0);
});