import { Controller, Get, Post, Put, Delete, Body, Param, Request, UseGuards, Query } from '@nestjs/common';
import { SubscriptionService } from '../services/subscription.service';
import { CreateSubscriptionDto, RenewSubscriptionDto, AdminCreateSubscriptionDto } from '../dto/subscription.dto';
import { AuthenticatedGuard, AdminGuard } from '../auth/auth.guard';
import { generateVlessUrl } from '../utils/generateVlessUrl'; // Импортируем генератор URL
import { prisma } from '../services/database'; // Импортируем Prisma для прямого доступа
import logger from '../utils/logger'; // Для логирования
import * as QRCode from 'qrcode'; // Импортируем библиотеку QR-кода

@Controller('subscriptions')
export class SubscriptionController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  // --- Эндпоинты для Пользователей (защищено) ---

  @UseGuards(AuthenticatedGuard)
  @Get('my')
  async getMySubscription(@Request() req) {
    const userId = req.user.id;
    return this.subscriptionService.getUserSubscription(userId);
  }
  
  @UseGuards(AuthenticatedGuard)
  @Post('create')
  async createSubscription(@Request() req, @Body() createSubscriptionDto: CreateSubscriptionDto) {
      const userId = req.user.id;
      // Добавить логику выбора сервера, если их несколько
      // Пока что выбираем первый активный сервер
      const server = await prisma.vpnServer.findFirst({ where: { isActive: true } });
      if (!server) {
          throw new Error('Нет доступных активных серверов для создания подписки.');
      }
      return this.subscriptionService.createUserSubscription(userId, createSubscriptionDto.months, server.id);
  }

  @UseGuards(AuthenticatedGuard)
  @Post('renew')
  async renewSubscription(@Request() req, @Body() renewSubscriptionDto: RenewSubscriptionDto) {
    const userId = req.user.id;
    return this.subscriptionService.renewUserSubscription(userId, renewSubscriptionDto.months);
  }
  
  @UseGuards(AuthenticatedGuard)
  @Get('my/config')
  async getMyConfig(@Request() req) {
    const userId = req.user.id;
    logger.info(`Запрос конфигурации для пользователя ${userId}`);
    
    const subscription = await prisma.subscription.findFirst({
      where: { userId: userId, isActive: true }, // Находим активную подписку
      include: { server: true }, // Включаем данные сервера
    });

    if (!subscription || !subscription.server) {
      logger.warn(`Активная подписка или сервер не найдены для пользователя ${userId}`);
      throw new Error('Активная подписка не найдена или сервер недоступен.');
    }

    const server = subscription.server;

    // Проверяем, развернут ли сервер через Docker и есть ли необходимые данные
    if (server.configData !== 'docker' || !server.initialUserId || !server.realityPublicKey || !server.realityShortId) {
      logger.error(`Сервер ${server.id} (${server.host}) не использует Docker или не имеет полных данных Reality.`);
      throw new Error('Конфигурация для данного типа сервера недоступна или неполная.');
    }

    try {
      const vlessUrl = generateVlessUrl({
        uuid: server.initialUserId, // Пока используем UUID сервера
        address: server.host,
        port: server.port, // Порт Xray (443)
        publicKey: server.realityPublicKey,
        shortId: server.realityShortId,
        serverName: 'www.google.com', // TODO: Сделать настраиваемым? 
        fingerprint: 'chrome',      // TODO: Сделать выбираемым?
        serverDescription: server.name || server.host, // Имя сервера для клиента
      });
      
      // Генерируем QR-код
      const qrCodeDataUrl = await QRCode.toDataURL(vlessUrl);
      
      logger.info(`Конфигурация VLESS URL и QR-код успешно сгенерированы для пользователя ${userId}`);
      // Возвращаем URL и QR-код
      return { configUrl: vlessUrl, qrCodeDataUrl: qrCodeDataUrl };
    } catch (error: any) {
      logger.error(`Ошибка генерации VLESS URL или QR-кода для пользователя ${userId} на сервере ${server.id}: ${error.message}`);
      throw new Error('Не удалось сгенерировать конфигурацию подключения.');
    }
  }

  // --- Эндпоинты для Администратора (защищено AdminGuard) ---

  @UseGuards(AdminGuard)
  @Get()
  async getAllSubscriptions(@Query('page') page: number = 1, @Query('limit') limit: number = 10) {
    return this.subscriptionService.getAllSubscriptions(page, limit);
  }

  @UseGuards(AdminGuard)
  @Post('admin/create')
  async adminCreateSubscription(@Body() adminCreateSubscriptionDto: AdminCreateSubscriptionDto) {
    return this.subscriptionService.adminCreateSubscription(adminCreateSubscriptionDto);
  }

  @UseGuards(AdminGuard)
  @Put(':id')
  async updateSubscription(@Param('id') id: string, @Body() data: any) {
    // Добавить DTO для обновления
    return this.subscriptionService.updateSubscription(+id, data);
  }

  @UseGuards(AdminGuard)
  @Delete(':id')
  async deleteSubscription(@Param('id') id: string) {
    return this.subscriptionService.deleteSubscription(+id);
  }
  
  @UseGuards(AdminGuard)
  @Get(':id')
  async getSubscriptionById(@Param('id') id: string) {
    return this.subscriptionService.getSubscriptionById(+id);
  }
} 