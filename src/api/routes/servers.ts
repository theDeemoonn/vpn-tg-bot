import express from 'express';
import { requireAdmin } from '../middlewares/auth';
import { 
  getServers, 
  getServerById, 
  createServer, 
  updateServer, 
  deleteServer,
  deployServer,
  getDeploymentStatus
} from '../controllers/servers.controller';

const router = express.Router();

// Все маршруты требуют прав администратора
router.use(requireAdmin);

// Получение списка серверов
router.get('/', getServers);

// Получение информации о конкретном сервере
router.get('/:id', getServerById);

// Создание нового сервера
router.post('/', createServer);

// Обновление информации о сервере
router.put('/:id', updateServer);

// Удаление сервера
router.delete('/:id', deleteServer);

// Развертывание VPN сервера
router.post('/deploy', deployServer);

// Получение статуса развертывания
router.get('/deploy/:deploymentId/status', getDeploymentStatus);

export default router; 