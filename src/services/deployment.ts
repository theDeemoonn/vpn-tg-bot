import axios from 'axios';
import { prisma } from './database';
import logger from '../utils/logger';
import config from '../config';
import { v4 as uuidv4 } from 'uuid';
import { spawn, execSync, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Интерфейс для провайдеров облачной инфраструктуры
interface CloudProvider {
  name: string;
  createServer: (options: ServerDeploymentOptions) => Promise<{ success: boolean; ip?: string; error?: string }>;
  deleteServer: (serverId: string, serverIp: string) => Promise<{ success: boolean; error?: string }>;
}

// Опции для развертывания сервера
export interface ServerDeploymentOptions {
  name: string;
  host?: string;      // Если пустой, будет создан новый сервер в облаке
  port?: number;      // По умолчанию 22
  location: string;   // Регион для развертывания
  provider: string;   // Облачный провайдер
  maxClients?: number;// Максимальное количество клиентов
  isAutoScaled?: boolean; // Флаг, что сервер создан автоматически
  sshUsername?: string; // Имя пользователя SSH
  sshPassword?: string; // Пароль SSH
}

// Доступные облачные провайдеры
const cloudProviders: Record<string, CloudProvider> = {
  'DigitalOcean': {
    name: 'DigitalOcean',
    
    // Создание сервера в DigitalOcean
    createServer: async (options: ServerDeploymentOptions) => {
      try {
        logger.info(`Создание нового сервера в DigitalOcean (${options.name}, регион: ${options.location})`);
        
        // Проверяем наличие API ключа DigitalOcean
        const doApiKey = config.doApiKey;
        if (!doApiKey) {
          return { success: false, error: 'DigitalOcean API ключ не найден в конфигурации' };
        }
        
        // Получаем доступные регионы или используем соответствие из конфигурации
        const regionMap: Record<string, string> = {
          'amsterdam': 'ams3',
          'frankfurt': 'fra1',
          'london': 'lon1',
          'new-york': 'nyc3',
          'singapore': 'sgp1'
        };
        
        const regionSlug = regionMap[options.location.toLowerCase()] || 'ams3';
        
        // Создаем новый дроплет через API DigitalOcean
        const response = await axios.post('https://api.digitalocean.com/v2/droplets', {
          name: options.name,
          region: regionSlug, 
          size: 's-1vcpu-1gb',  // Наименьший размер дроплета
          image: 'ubuntu-20-04-x64',
          ssh_keys: [config.doSshKeyId], // ID SSH ключа в DigitalOcean
          backups: false,
          ipv6: false,
          monitoring: true,
          tags: ['vpn', 'auto-deployed']
        }, {
          headers: {
            'Authorization': `Bearer ${doApiKey}`,
            'Content-Type': 'application/json'
          }
        });
        
        if (response.status !== 202) {
          return { success: false, error: `Ошибка API DigitalOcean: ${response.statusText}` };
        }
        
        const dropletId = response.data.droplet.id;
        logger.info(`Дроплет ${options.name} (ID: ${dropletId}) создан в DigitalOcean`);
        
        // Ждем, пока дроплет получит IP адрес
        let dropletIp = '';
        let attempts = 0;
        
        while (!dropletIp && attempts < 30) {
          await new Promise(resolve => setTimeout(resolve, 5000)); // Ждем 5 секунд
          attempts++;
          
          const statusResponse = await axios.get(`https://api.digitalocean.com/v2/droplets/${dropletId}`, {
            headers: {
              'Authorization': `Bearer ${doApiKey}`
            }
          });
          
          const networks = statusResponse.data.droplet.networks.v4;
          if (networks && networks.length > 0) {
            for (const network of networks) {
              if (network.type === 'public') {
                dropletIp = network.ip_address;
                break;
              }
            }
          }
        }
        
        if (!dropletIp) {
          return { success: false, error: 'Не удалось получить IP адрес нового сервера' };
        }
        
        logger.info(`Сервер ${options.name} готов, IP адрес: ${dropletIp}`);
        
        // Ждем, пока сервер станет доступен по SSH
        await waitForSsh(dropletIp);
        
        return { success: true, ip: dropletIp };
      } catch (error: any) {
        logger.error(`Ошибка при создании сервера в DigitalOcean: ${error.message}`);
        return { success: false, error: `Ошибка при создании сервера: ${error.message}` };
      }
    },
    
    // Удаление сервера в DigitalOcean
    deleteServer: async (serverId: string, serverIp: string) => {
      try {
        logger.info(`Удаление сервера ${serverId} (${serverIp}) из DigitalOcean`);
        
        // Проверяем наличие API ключа DigitalOcean
        const doApiKey = config.doApiKey;
        if (!doApiKey) {
          return { success: false, error: 'DigitalOcean API ключ не найден в конфигурации' };
        }
        
        // Сначала находим ID дроплета по IP адресу
        const response = await axios.get('https://api.digitalocean.com/v2/droplets', {
          headers: {
            'Authorization': `Bearer ${doApiKey}`
          }
        });
        
        let dropletId = '';
        
        for (const droplet of response.data.droplets) {
          const networks = droplet.networks.v4;
          if (networks) {
            for (const network of networks) {
              if (network.type === 'public' && network.ip_address === serverIp) {
                dropletId = droplet.id;
                break;
              }
            }
          }
          
          if (dropletId) break;
        }
        
        if (!dropletId) {
          return { success: false, error: `Не найден дроплет с IP адресом ${serverIp}` };
        }
        
        // Удаляем дроплет
        const deleteResponse = await axios.delete(`https://api.digitalocean.com/v2/droplets/${dropletId}`, {
          headers: {
            'Authorization': `Bearer ${doApiKey}`
          }
        });
        
        if (deleteResponse.status !== 204) {
          return { success: false, error: `Ошибка API DigitalOcean: ${deleteResponse.statusText}` };
        }
        
        logger.info(`Дроплет ${dropletId} (${serverIp}) успешно удален из DigitalOcean`);
        return { success: true };
      } catch (error: any) {
        logger.error(`Ошибка при удалении сервера из DigitalOcean: ${error.message}`);
        return { success: false, error: `Ошибка при удалении сервера: ${error.message}` };
      }
    }
  },
  
  // Можно добавить другие провайдеры, например Vultr, AWS, GCP и т.д.
};

/**
 * Ожидание доступности сервера по SSH
 */
async function waitForSsh(host: string, port: number = 22, timeout: number = 180): Promise<boolean> {
  logger.info(`Ожидание доступности SSH на сервере ${host}:${port}...`);
  
  const startTime = Date.now();
  let isReady = false;
  
  while (!isReady && (Date.now() - startTime) / 1000 < timeout) {
    try {
      execSync(`ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -i ${config.sshPrivateKeyPath} -p ${port} ${config.sshUser}@${host} echo "SSH connection test"`, {
        timeout: 5000
      });
      isReady = true;
      logger.info(`SSH на сервере ${host}:${port} доступен`);
    } catch (error) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // Ждем 5 секунд между попытками
    }
  }
  
  if (!isReady) {
    logger.error(`Таймаут ожидания SSH соединения с ${host}:${port}`);
  }
  
  return isReady;
}

/**
 * Развертывание VPN сервера (автоматическое или на существующем сервере)
 */
export async function deployVpnServer(options: ServerDeploymentOptions): Promise<{ success: boolean; serverId?: number; deploymentId?: string; error?: string }> {
  try {
    // Проверяем обязательные поля
    if (!options.name || !options.location || !options.provider) {
      return { success: false, error: 'Необходимо указать название, регион и провайдер' };
    }
    
    let serverHost = options.host;
    let sshUsername = options.sshUsername;
    let sshPassword = options.sshPassword;
    
    if (!serverHost) {
      // Проверяем, поддерживается ли указанный провайдер
      const provider = cloudProviders[options.provider];
      if (!provider) {
        return { success: false, error: `Провайдер ${options.provider} не поддерживается` };
      }
      
      // Создаем новый сервер в облаке
      const createResult = await provider.createServer(options);
      if (!createResult.success || !createResult.ip) {
        return { success: false, error: createResult.error || 'Не удалось создать сервер' };
      }
      
      serverHost = createResult.ip;
      sshUsername = config.sshUser; // Используем пользователя из конфига для созданных серверов
      sshPassword = undefined; // Пароль не используется
    } else {
      // Если используется существующий хост, проверяем наличие SSH данных
      if (!sshUsername || !sshPassword) {
        // Эта проверка уже есть в контроллере, но добавим и сюда для надежности
        return { success: false, error: 'Для существующего сервера необходимы SSH имя пользователя и пароль' };
      }
    }
    
    // Создаем запись о сервере в базе данных
    const server = await prisma.vpnServer.create({
      data: {
        name: options.name,
        host: serverHost,
        port: options.port || 22,
        location: options.location,
        provider: options.provider,
        maxClients: options.maxClients || 50,
        isActive: true,
        currentClients: 0,
        isAutoScaled: options.isAutoScaled || false
      }
    });
    
    logger.info(`Сервер ${options.name} (${serverHost}) добавлен в базу данных с ID: ${server.id}`);
    
    const deploymentId = uuidv4();
    
    // Передаем SSH данные в фоновый процесс
    deployVpnServerBackground(deploymentId, server, sshUsername, sshPassword);
    
    return { 
      success: true, 
      serverId: server.id,
      deploymentId
    };
  } catch (error: any) {
    logger.error(`Ошибка при запуске процесса развертывания: ${error.message}`);
    return { success: false, error: `Ошибка при развертывании: ${error.message}` };
  }
}

/**
 * Читает базовый скрипт установки из файла
 */
function getBaseInstallScript(): string {
  try {
    const scriptPath = path.resolve(process.cwd(), 'scripts', 'install_xray.sh');
    if (!fs.existsSync(scriptPath)) {
      logger.error(`Файл скрипта установки не найден: ${scriptPath}`);
      throw new Error(`Файл скрипта установки не найден: ${scriptPath}`);
    }
    return fs.readFileSync(scriptPath, 'utf8');
  } catch (error: any) {
    logger.error(`Ошибка чтения файла скрипта установки: ${error.message}`);
    throw error; // Перебрасываем ошибку дальше
  }
}

// Объект для хранения процессов развертывания и их статусов
interface DeploymentProcess {
  status: 'running' | 'completed' | 'failed' | 'completed_with_warning';
  serverId?: number;
  logs: string;
  error?: string;
  output: string[];
}

const deployments: Record<string, DeploymentProcess> = {};

/**
 * Вспомогательная функция для выполнения SSH команды и возврата Promise с результатом.
 */
function executeSshCommandPromise(
  host: string, 
  username: string, 
  command: string, 
  sshPort: number,
  usePassword?: boolean, 
  password?: string, 
  sshKeyPath?: string
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    let sshProcess: ChildProcessWithoutNullStreams;
    let outputData: string[] = [];
    const baseSshOptions = ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-p', sshPort.toString()];
    const remoteTarget = `${username}@${host}`;
    let commandArgs: string[];

    if (usePassword) {
      if (!password) {
        return reject(new Error('Пароль SSH не предоставлен для аутентификации по паролю'));
      }
      commandArgs = ['-e', 'ssh', ...baseSshOptions, remoteTarget, command];
      sshProcess = spawn('sshpass', commandArgs, { env: { ...process.env, SSHPASS: password } });
    } else {
      if (!sshKeyPath || !fs.existsSync(sshKeyPath)) {
        return reject(new Error(`SSH ключ не найден или не указан по пути: ${sshKeyPath}`));
      }
      commandArgs = [...baseSshOptions, '-i', sshKeyPath, remoteTarget, command];
      sshProcess = spawn('ssh', commandArgs);
    }

    sshProcess.stdout.on('data', (data) => {
      outputData.push(data.toString());
    });

    sshProcess.stderr.on('data', (data) => {
      outputData.push(data.toString()); // Включаем stderr в вывод для диагностики
    });

    sshProcess.on('close', (code) => {
      resolve({ code, output: outputData.join('') });
    });

    sshProcess.on('error', (error) => {
        // Не логируем ошибки sshpass, содержащие пароль
        if (!usePassword || !error.message.toLowerCase().includes('sshpass')) {
            logger.error(`Ошибка выполнения SSH команды: ${error.message}`);
        }
      reject(error); // Отклоняем промис при ошибке запуска
    });
  });
}

/**
 * Функция для запуска процесса развертывания VPN сервера в фоновом режиме
 */
export async function deployVpnServerBackground(deploymentId: string, server: any, sshUsername: string, sshPassword?: string): Promise<void> {
  const serverLogId = server?.id ? `(Server ID: ${server.id})` : '';
  let apiToken: string | null = null; // Переменная для хранения полученного токена
  let installScriptPath: string | null = null; // Путь к временному скрипту

  try {
    deployments[deploymentId] = {
      status: 'running',
      serverId: server.id,
      logs: `Начало развертывания сервера ${server.name} (${server.host}) ${serverLogId}...\\n`,
      output: []
    };
    
    const sshKeyPath = config.sshPrivateKeyPath;
    const usePassword = !!sshPassword;
    
    if (!usePassword && !fs.existsSync(sshKeyPath)) {
      deployments[deploymentId].status = 'failed';
      deployments[deploymentId].error = `SSH ключ не найден по пути: ${sshKeyPath}, и пароль не предоставлен.`;
      logger.error(`[Deployment ${deploymentId}] ${deployments[deploymentId].error} ${serverLogId}`);
      return;
    }
    
    const installDir = path.resolve(process.cwd(), 'install');
    if (!fs.existsSync(installDir)) {
      fs.mkdirSync(installDir, { recursive: true });
    }
    
    installScriptPath = path.join(process.cwd(), 'install', `install_xray_${deploymentId}.sh`); // Определяем путь здесь
    
    deployments[deploymentId].logs += `Подготовка скрипта установки...\\n`;
    let installScriptContent = getBaseInstallScript();
    const serverHost = server.host || '127.0.0.1';
    const adminEmail = config.adminEmail || 'admin@example.com';
    const sshPort = server.port || 22;
    installScriptContent = installScriptContent.replace(/PLACEHOLDER_SERVER_HOST/g, serverHost);
    installScriptContent = installScriptContent.replace(/PLACEHOLDER_ADMIN_EMAIL/g, adminEmail);
    installScriptContent = installScriptContent.replace(/PLACEHOLDER_SERVER_SSH_PORT/g, sshPort.toString());
    deployments[deploymentId].logs += `Замена плейсхолдеров в скрипте...\\n`;
    fs.writeFileSync(installScriptPath, installScriptContent);
    fs.chmodSync(installScriptPath, '755');
    deployments[deploymentId].logs += `Скрипт установки создан: ${installScriptPath}\\nКопирование скрипта на сервер ${server.host}...\\n`;

    let scpCommand: string;
    let sshCommandArgs: string[];
    const baseScpOptions = `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -P ${sshPort}`;
    const baseSshOptions = ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-p', sshPort.toString()];
    const remoteScriptPath = '/tmp/install_xray.sh';
    const remoteTarget = `${sshUsername}@${serverHost}`;
    const remoteExecutionCommand = `chmod +x ${remoteScriptPath} && sudo bash ${remoteScriptPath}`;
    let sshProcess: ChildProcessWithoutNullStreams;

    // --- Копирование скрипта (Try-Catch блоки как были) ---
    if (usePassword) {
      logger.info(`[Deployment ${deploymentId}] Используется SSH пароль для подключения к ${serverHost}:${sshPort} ${serverLogId}`);
      scpCommand = `sshpass -e scp ${baseScpOptions} ${installScriptPath} ${remoteTarget}:${remoteScriptPath}`;
      
      try {
        execSync(scpCommand, { env: { ...process.env, SSHPASS: sshPassword }, stdio: 'pipe' });
        deployments[deploymentId].logs += `Скрипт успешно скопирован на сервер.\\nЗапуск установки Xray...\\n`;
      } catch (error: any) {
        deployments[deploymentId].status = 'failed';
        const stderr = error.stderr?.toString() || '';
        const errorMessage = `Ошибка при копировании скрипта (sshpass): ${stderr.split('\\n')[0] || error.message}`;
        deployments[deploymentId].error = errorMessage;
        logger.error(`[Deployment ${deploymentId}] ${errorMessage} ${serverLogId}`);
        fs.unlinkSync(installScriptPath);
        return;
      }

      sshCommandArgs = ['-e', 'ssh', ...baseSshOptions, remoteTarget, remoteExecutionCommand];
      // Присваиваем результат spawn переменной sshProcess
      sshProcess = spawn('sshpass', sshCommandArgs, { env: { ...process.env, SSHPASS: sshPassword } }); 
       
    } else {
      logger.info(`[Deployment ${deploymentId}] Используется SSH ключ ${sshKeyPath} для подключения к ${serverHost}:${sshPort} ${serverLogId}`);
      scpCommand = `scp ${baseScpOptions} -i ${sshKeyPath} ${installScriptPath} ${remoteTarget}:${remoteScriptPath}`;
      
       try {
        execSync(scpCommand, { stdio: 'pipe' });
        deployments[deploymentId].logs += `Скрипт успешно скопирован на сервер.\\nЗапуск установки Xray...\\n`;
    } catch (error: any) {
      deployments[deploymentId].status = 'failed';
        const stderr = error.stderr?.toString() || '';
        const errorMessage = `Ошибка при копировании скрипта (ключ): ${stderr.split('\\n')[0] || error.message}`;
        deployments[deploymentId].error = errorMessage;
        logger.error(`[Deployment ${deploymentId}] ${errorMessage} ${serverLogId}`);
         fs.unlinkSync(installScriptPath);
      return;
    }
    
      sshCommandArgs = [...baseSshOptions, '-i', sshKeyPath, remoteTarget, remoteExecutionCommand];
      // Присваиваем результат spawn переменной sshProcess
      sshProcess = spawn('ssh', sshCommandArgs);
    }

    // --- Запуск скрипта и обработка вывода --- 
    if (usePassword) {
       sshCommandArgs = ['-e', 'ssh', ...baseSshOptions, remoteTarget, remoteExecutionCommand]; 
       sshProcess = spawn('sshpass', sshCommandArgs, { env: { ...process.env, SSHPASS: sshPassword } });
    } else {
        sshCommandArgs = [...baseSshOptions, '-i', sshKeyPath, remoteTarget, remoteExecutionCommand];
        sshProcess = spawn('ssh', sshCommandArgs);
    }

    // Обработка stdout: ищем токен
    sshProcess.stdout.on('data', (data) => {
      const output = data.toString();
      deployments[deploymentId].logs += output; // Добавляем весь вывод в лог
      // Ищем строку с токеном
      const tokenMatch = output.match(/^API_TOKEN_OUTPUT:(.+)$/m);
      if (tokenMatch && tokenMatch[1]) {
        apiToken = tokenMatch[1].trim();
        logger.info(`[Deployment ${deploymentId}] Получен API Token для сервера ${serverLogId}: ${apiToken ? '***' : 'null'}`);
        // Можно скрыть сам токен в логах бэкенда, если нужно
      }
      // Логируем информационные строки скрипта (как было)
      output.split('\\n').forEach(line => {
        if (line.includes('[INFO]') || line.includes('[SUCCESS]') || line.includes('[WARNING]') || line.includes('[ERROR]')) {
          logger.info(`[Deployment ${deploymentId}] ${line.trim()} ${serverLogId}`);
        }
      });
    });

    // Обработка stderr (как было)
    sshProcess.stderr.on('data', (data) => {
      const output = data.toString();
      // Не логируем ошибки sshpass, содержащие пароль
       if (!usePassword || !output.toLowerCase().includes('sshpass')) {
      deployments[deploymentId].logs += output;
          logger.warn(`[Deployment ${deploymentId}] STDERR: ${output.trim()} ${serverLogId}`);
       } else {
          logger.warn(`[Deployment ${deploymentId}] Сообщение sshpass STDERR скрыто ${serverLogId}`);
       }
    });
    
    // Обработка завершения процесса
    sshProcess.on('close', async (code) => { // Делаем обработчик async
      if (installScriptPath && fs.existsSync(installScriptPath)) {
         fs.unlinkSync(installScriptPath); // Удаляем временный скрипт
      }
      if (code === 0) {
        deployments[deploymentId].status = 'completed';
        deployments[deploymentId].logs += `\\nРазвертывание VPN сервера ${server.name} (${serverHost}) успешно завершено!\\n`;
        logger.info(`[Deployment ${deploymentId}] Развертывание сервера успешно завершено ${serverLogId}`);
        
        // Сохраняем API токен в базу данных, если он был получен
        if (apiToken) {
          try {
            await prisma.vpnServer.update({
              where: { id: server.id },
              data: { apiToken: apiToken },
            });
            logger.info(`[Deployment ${deploymentId}] API Token успешно сохранен для сервера ${serverLogId}: ${apiToken ? '***' : 'null'}`);
            deployments[deploymentId].logs += `API Token сохранен в базе данных.\\n`;
          } catch (dbError: any) {
            logger.error(`[Deployment ${deploymentId}] Ошибка сохранения API Token для сервера ${serverLogId}: ${dbError.message}`);
            deployments[deploymentId].logs += `\\nОшибка: Не удалось сохранить API Token в базе данных.\\n`;
            // Отмечаем развертывание как завершенное с предупреждением
            deployments[deploymentId].status = 'completed_with_warning'; 
            deployments[deploymentId].error = 'Не удалось сохранить API Token';
          }
        } else {
           logger.warn(`[Deployment ${deploymentId}] API Token не был получен от скрипта установки для сервера ${serverLogId}.`);
           deployments[deploymentId].logs += `\\nПредупреждение: Не удалось получить API Token от сервера.\\n`;
           deployments[deploymentId].status = 'completed_with_warning';
           deployments[deploymentId].error = 'API Token не получен';
        }

        // --- Начало проверки Health Check --- 
        logger.info(`[${deploymentId}] Ожидание запуска контейнеров API...`);
        await new Promise(resolve => setTimeout(resolve, 10000)); // Пауза 10 сек

        logger.info(`[${deploymentId}] Проверка работоспособности API на ${serverHost}...`);
        const healthCheckCommand = `curl --fail --silent --max-time 5 http://localhost:3000/health || echo "API Health Check Failed"`;
        let healthCheckOk = false;
        for (let i = 0; i < 3; i++) { // Попробовать 3 раза с паузой
          try {
            // Используем новую функцию executeSshCommandPromise
            const result = await executeSshCommandPromise(
              serverHost,
              sshUsername,
              healthCheckCommand,
              server.port || 22,
              !!sshPassword, // usePassword
              sshPassword,   // password
              config.sshPrivateKeyPath // sshKeyPath
            );

            if (result.code === 0 && !result.output.includes("API Health Check Failed")) {
              logger.info(`[${deploymentId}] API Health Check успешен.`);
              healthCheckOk = true;
              break;
            }
             logger.warn(`[${deploymentId}] Попытка ${i + 1} проверки API не удалась (код: ${result.code}). Результат: ${result.output.trim()}`);
          } catch (sshError: any) {
            logger.warn(`[${deploymentId}] Ошибка при выполнении SSH команды health check (попытка ${i + 1}): ${sshError.message}`);
          }
          
          if (i < 2) {
            await new Promise(resolve => setTimeout(resolve, 5000)); // Пауза 5 сек перед следующей попыткой
          }
        }
        // --- Конец проверки Health Check --- 

        if (!healthCheckOk) {
            logger.error(`[${deploymentId}] Не удалось подтвердить работоспособность API на ${serverHost} после запуска docker-compose.`);
            if (deployments[deploymentId]) {
                deployments[deploymentId].status = 'failed';
                deployments[deploymentId].error = 'API не отвечает после запуска';
                deployments[deploymentId].output.push('Ошибка: API не отвечает после запуска docker-compose.');
            }
            return; 
        }

        logger.info(`[${deploymentId}] Развертывание API завершено успешно.`);
      } else {
        deployments[deploymentId].status = 'failed';
        const errorMsg = `Процесс установки завершился с кодом ошибки: ${code}`;
        deployments[deploymentId].error = deployments[deploymentId].error || errorMsg;
        deployments[deploymentId].logs += `\\nОшибка: ${errorMsg}\\n`;
        logger.error(`[Deployment ${deploymentId}] ${errorMsg} ${serverLogId}`);
      }
    });

    // Обработка ошибок запуска процесса (как было)
    sshProcess.on('error', (error) => {
       if (installScriptPath && fs.existsSync(installScriptPath)) {
         fs.unlinkSync(installScriptPath);
      }
      // ... (общая обработка ошибок)
    });
    
  } catch (error: any) {
     if (installScriptPath && fs.existsSync(installScriptPath)) {
        try { fs.unlinkSync(installScriptPath); } catch (e) {} // Пытаемся удалить скрипт
     }
     // ... (общая обработка ошибок)
  }
}

/**
 * Получение статуса развертывания
 */
export function getDeploymentStatus(deploymentId: string): DeploymentProcess | null {
  return deployments[deploymentId] || null;
} 