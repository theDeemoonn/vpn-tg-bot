declare module 'yookassa' {
  export interface YooKassaOptions {
    shopId: string;
    secretKey: string;
  }

  export interface YooKassaPaymentOptions {
    amount: {
      value: string | number;
      currency: string;
    };
    confirmation: {
      type: string;
      return_url: string;
    };
    description?: string;
    metadata?: Record<string, any>;
    capture?: boolean;
    receipt?: {
      customer?: {
        email?: string;
        phone?: string;
      };
      items: Array<{
        description: string;
        quantity: string | number;
        amount: {
          value: string | number;
          currency: string;
        };
        vat_code?: string | number;
      }>;
    };
  }

  export interface YooKassaPaymentResponse {
    id: string;
    status: string;
    paid: boolean;
    amount: {
      value: string;
      currency: string;
    };
    confirmation: {
      type: string;
      confirmation_url: string;
      return_url?: string;
    };
    created_at: string;
    description?: string;
    metadata?: Record<string, any>;
    recipient: {
      account_id: string;
      gateway_id: string;
    };
    refundable: boolean;
    test: boolean;
  }

  export interface YooKassaPaymentStatus {
    id: string;
    status: string;
    paid: boolean;
    amount: {
      value: string;
      currency: string;
    };
    created_at: string;
    description?: string;
    metadata?: Record<string, any>;
  }

  export class YooKassa {
    constructor(options: YooKassaOptions);
    createPayment(paymentOptions: YooKassaPaymentOptions): Promise<YooKassaPaymentResponse>;
    getPaymentInfo(paymentId: string): Promise<YooKassaPaymentStatus>;
  }

  export default YooKassa;
} 