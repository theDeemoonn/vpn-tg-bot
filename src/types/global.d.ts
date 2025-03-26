import { SubscriptionPeriod } from '../services/payment';

declare global {
  namespace NodeJS {
    interface Global {
      /**
       * Объект для хранения состояний пользователей
       */
      userStates: {
        [chatId: number]: {
          state: string;
          data: {
            period?: SubscriptionPeriod;
            [key: string]: any;
          };
        };
      };
    }
  }
}

export {}; 