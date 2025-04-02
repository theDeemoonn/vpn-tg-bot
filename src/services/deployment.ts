// import axios from 'axios'; // Закомментируем, если не используется в других частях файла
import { prisma } from './database';
import logger from '../utils/logger';
import config from '../config';
import { v4 as uuidv4 } from 'uuid';
import { spawn, execSync, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { generateXrayConfig } from './configGenerator'; // Импортируем генератор

/* // --- Закомментировано: Логика для облачных провайдеров ---
// Интерфейс для провайдеров облачной инфраструктуры
interface CloudProvider {
  name: string;
  createServer: (options: ServerDeploymentOptions) => Promise<{ success: boolean; ip?: string; error?: string }>;
  deleteServer: (serverId: string, serverIp: string) => Promise<{ success: boolean; error?: string }>;
}

// Доступные облачные провайдеры
const cloudProviders: Record<string, CloudProvider> = {
  'DigitalOcean': {
    name: 'DigitalOcean',
    
    // Создание сервера в DigitalOcean
    createServer: async (options: ServerDeploymentOptions) => {
      // ... (код создания сервера в DO) ...
    },
    
    // Удаление сервера в DigitalOcean
    deleteServer: async (serverId: string, serverIp: string) => {
      // ... (код удаления сервера в DO) ...
    }
  },
  
  // Можно добавить другие провайдеры, например Vultr, AWS, GCP и т.д.
};
*/ // --- Конец закомментированного блока ---

// Опции для развертывания сервера (упрощаем)
export interface ServerDeploymentOptions {
  name: string;
  host: string; // IP адрес
  port?: number; // SSH порт (по умолчанию 22)
  sshUsername?: string; // Имя пользователя SSH
  sshPassword?: string; // Пароль SSH
  sshKeyPath?: string; // Путь к SSH ключу
  location?: string; // Описание локации (для информации)
  provider?: string; // Описание провайдера (для информации)
}

/* // --- Закомментировано: Функция ожидания SSH ---
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
*/ // --- Конец закомментированного блока ---

// Хранилище статусов развертывания
interface DeploymentState {
  status: 'pending' | 'installing_docker' | 'pulling_image' | 'creating_config' | 'starting_xray' | 'completed' | 'failed';
  serverId: number;
  logs: string;
  error?: string;
}
const deployments: Record<string, DeploymentState> = {};

/**
 * Получение статуса развертывания
 */
export function getDeploymentStatus(deploymentId: string): DeploymentState | null {
  return deployments[deploymentId] || null;
}

/**
 * Функция для выполнения SSH команд на удаленном сервере
 */
async function executeSshCommand(deploymentId: string, host: string, port: number, username: string, command: string, password?: string, keyPath?: string): Promise<{ code: number | null; output: string; error: string }> {
  return new Promise((resolve) => {
    const serverLogId = deployments[deploymentId]?.serverId ? `(Server ID: ${deployments[deploymentId].serverId})` : '';
    const sshOptions = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-p', port.toString(),
      `${username}@${host}`,
      command
    ];
    let sshProcess: ChildProcessWithoutNullStreams;
    let args: string[];
    let processName: string;

    const logOutput = (data: any, stream: 'stdout' | 'stderr') => {
      const outputStr = data.toString();
      // Проверяем, существует ли еще запись о развертывании
      if (!deployments[deploymentId]) return; 
      deployments[deploymentId].logs += outputStr;
      if (stream === 'stderr') {
          logger.warn(`[Deployment ${deploymentId}] SSH STDERR: ${outputStr.trim()} ${serverLogId}`);
      } else {
           logger.info(`[Deployment ${deploymentId}] SSH STDOUT: ${outputStr.trim()} ${serverLogId}`);
      }
    };

    if (password) {
      processName = '/usr/bin/sshpass';
      args = ['-p', password, '/usr/bin/ssh', ...sshOptions];
    } else if (keyPath) {
      processName = '/usr/bin/ssh';
      args = ['-i', keyPath, ...sshOptions];
    } else {
      resolve({ code: -1, output: '', error: 'Не указан пароль или путь к ключу SSH' });
      return;
    }

    try {
      sshProcess = spawn(processName, args);
      let stdout = '';
      let stderr = '';

      sshProcess.stdout.on('data', (data) => {
        stdout += data.toString();
        logOutput(data, 'stdout');
      });

      sshProcess.stderr.on('data', (data) => {
        stderr += data.toString();
        logOutput(data, 'stderr');
      });

      sshProcess.on('close', (code) => {
        resolve({ code, output: stdout, error: stderr });
      });

      sshProcess.on('error', (err) => {
        const errorMsg = `Ошибка запуска ${processName}: ${err.message}`;
        if (deployments[deploymentId]) {
            deployments[deploymentId].logs += `\n${errorMsg}\n`;
        }
        logger.error(`[Deployment ${deploymentId}] ${errorMsg} ${serverLogId}`);
        resolve({ code: -1, output: stdout, error: `${stderr}\n${errorMsg}` });
      });

    } catch (spawnError: any) {
      const errorMsg = `Исключение при запуске ${processName}: ${spawnError.message}`;
      if (deployments[deploymentId]) {
          deployments[deploymentId].logs += `\n${errorMsg}\n`;
      }
      logger.error(`[Deployment ${deploymentId}] ${errorMsg} ${serverLogId}`);
      resolve({ code: -1, output: '', error: errorMsg });
    }
  });
}

/**
 * Функция для копирования файлов на удаленный сервер через SCP
 */
async function copyFileScp(deploymentId: string, host: string, port: number, username: string, localPath: string, remotePath: string, password?: string, keyPath?: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const serverLogId = deployments[deploymentId]?.serverId ? `(Server ID: ${deployments[deploymentId].serverId})` : '';
    const scpOptions = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-P', port.toString()
    ];
    let scpProcess: ChildProcessWithoutNullStreams;
    let args: string[];
    let processName: string;

    const logOutput = (data: any, stream: 'stdout' | 'stderr') => {
      const outputStr = data.toString();
      // Проверяем, существует ли еще запись о развертывании
      if (!deployments[deploymentId]) return; 
      deployments[deploymentId].logs += outputStr;
      if (stream === 'stderr') {
          logger.warn(`[Deployment ${deploymentId}] SCP STDERR: ${outputStr.trim()} ${serverLogId}`);
      } else {
           logger.info(`[Deployment ${deploymentId}] SCP STDOUT: ${outputStr.trim()} ${serverLogId}`);
      }
    };

    if (password) {
      processName = '/usr/bin/sshpass';
      args = ['-p', password, '/usr/bin/scp', ...scpOptions, localPath, `${username}@${host}:${remotePath}`];
    } else if (keyPath) {
      processName = '/usr/bin/scp';
      args = ['-i', keyPath, ...scpOptions, localPath, `${username}@${host}:${remotePath}`];
    } else {
      resolve({ success: false, error: 'Не указан пароль или путь к ключу SSH для SCP' });
      return;
    }

    try {
      scpProcess = spawn(processName, args);
      let stderr = '';

      scpProcess.stderr.on('data', (data) => {
        stderr += data.toString();
        logOutput(data, 'stderr');
      });

      scpProcess.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true });
        } else {
          resolve({ success: false, error: `Ошибка SCP (код: ${code}): ${stderr.trim()}` });
        }
      });

      scpProcess.on('error', (err) => {
        const errorMsg = `Ошибка запуска ${processName} для SCP: ${err.message}`;
        if (deployments[deploymentId]) {
            deployments[deploymentId].logs += `\n${errorMsg}\n`;
        }
        logger.error(`[Deployment ${deploymentId}] ${errorMsg} ${serverLogId}`);
        resolve({ success: false, error: errorMsg });
      });
    } catch (spawnError: any) {
      const errorMsg = `Исключение при запуске ${processName} для SCP: ${spawnError.message}`;
       if (deployments[deploymentId]) {
           deployments[deploymentId].logs += `\n${errorMsg}\n`;
       }
      logger.error(`[Deployment ${deploymentId}] ${errorMsg} ${serverLogId}`);
      resolve({ success: false, error: errorMsg });
    }
  });
}

/**
 * Новая функция развертывания с использованием Docker-образа Xray
 */
export async function deployVpnServerDocker(options: ServerDeploymentOptions): Promise<{ success: boolean; serverId?: number; deploymentId?: string; error?: string }> {
  const deploymentId = uuidv4();
  let serverId: number | undefined = undefined;
  // Создаем директорию install, если ее нет
  const installDir = path.join(process.cwd(), 'install');
  if (!fs.existsSync(installDir)) {
    try {
      fs.mkdirSync(installDir, { recursive: true });
      logger.info(`Создана директория: ${installDir}`);
    } catch (mkdirError: any) {
        logger.error(`Не удалось создать директорию ${installDir}: ${mkdirError.message}`);
        return { success: false, error: `Ошибка создания директории install: ${mkdirError.message}` };
    }
  }
  const tempConfigPath = path.join(installDir, `xray_config_${deploymentId}.json`);
  const xrayImage = 'teddysun/xray:latest';
  const xrayContainerName = 'xray_vpn';
  const remoteConfigDir = '/etc/xray';
  // const remoteCertDir = '/etc/letsencrypt'; // Для варианта с Certbot (не используем с Reality)
  const remoteLogDir = '/var/log/xray';

  try {
    // 1. Создаем запись о сервере в базе данных
    const server = await prisma.vpnServer.create({
      data: {
        name: options.name,
        host: options.host,
        port: 443, // Xray будет слушать 443 порт
        location: options.location || 'N/A',
        provider: options.provider || 'N/A',
        isActive: false, // Активируем после успешного развертывания
        currentClients: 0,
        maxClients: 50, // Можно сделать настраиваемым
        configData: 'docker' // Указываем, что используется Docker
      }
    });
    serverId = server.id;
    logger.info(`Сервер ${options.name} (${options.host}) добавлен в базу данных с ID: ${serverId}`);

    // 2. Инициализируем статус развертывания
    deployments[deploymentId] = {
      status: 'pending',
      serverId: serverId,
      logs: `Начало развертывания Xray через Docker на ${options.host} (ID: ${serverId})...\n`,
    };

    // 3. Запускаем фоновый процесс развертывания
    deployVpnServerDockerBackground(deploymentId, options, tempConfigPath, xrayImage, xrayContainerName, remoteConfigDir, remoteLogDir);

    return { success: true, serverId, deploymentId };

  } catch (error: any) {
    logger.error(`Ошибка при запуске процесса развертывания Docker: ${error.message}`);
    if (deploymentId && deployments[deploymentId]) {
      deployments[deploymentId].status = 'failed';
      deployments[deploymentId].error = `Ошибка инициации: ${error.message}`;
    }
    // Удаляем временный файл конфига, если он был создан до ошибки
    if (fs.existsSync(tempConfigPath)) {
        try { fs.unlinkSync(tempConfigPath); } catch (e) {}
    }
    return { success: false, error: `Ошибка инициации развертывания: ${error.message}` };
  }
}

async function deployVpnServerDockerBackground(
  deploymentId: string,
  options: ServerDeploymentOptions,
  tempConfigPath: string,
  xrayImage: string,
  xrayContainerName: string,
  remoteConfigDir: string,
  remoteLogDir: string
) {
  const { host, port = 22, sshUsername = 'root', sshPassword, sshKeyPath = config.sshPrivateKeyPath } = options;
  const serverLogId = `(Server ID: ${deployments[deploymentId].serverId})`;

  try {
    const usePassword = !!sshPassword;
    const useKey = !usePassword && sshKeyPath && fs.existsSync(sshKeyPath);

    if (!usePassword && !useKey) {
        throw new Error(`Не найден SSH ключ (${sshKeyPath || 'путь не указан'}) и не указан пароль.`);
    }

    const sshAuthProps = { password: usePassword ? sshPassword : undefined, keyPath: useKey ? sshKeyPath : undefined };

    // --- Шаг 1: Установка Docker --- 
    deployments[deploymentId].status = 'installing_docker';
    deployments[deploymentId].logs += `\n--- Установка Docker на ${host} --- \n`;
    logger.info(`[Deployment ${deploymentId}] Проверка/Установка Docker ${serverLogId}`);
    // Скрипт установки Docker, более надежный
    const dockerInstallScript = `
      export DEBIAN_FRONTEND=noninteractive
      if ! command -v docker &> /dev/null; then
        echo 'Docker не найден. Запуск установки...'
        apt-get update -qq > /dev/null || (echo 'Ошибка apt-get update' && exit 1)
        apt-get install -y -qq curl wget apt-transport-https ca-certificates software-properties-common > /dev/null || (echo 'Ошибка установки базовых пакетов' && exit 1)
        curl -fsSL https://download.docker.com/linux/$(. /etc/os-release; echo "$ID")/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
        echo \
          "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/$(. /etc/os-release; echo "$ID") \
          $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
        apt-get update -qq > /dev/null || (echo 'Ошибка apt-get update после добавления репозитория Docker' && exit 1)
        apt-get install -y -qq docker-ce docker-ce-cli containerd.io > /dev/null || (echo 'Ошибка установки Docker CE' && exit 1)
        echo 'Docker успешно установлен.'
      else
        echo 'Docker уже установлен. Версия: $(docker --version)'
      fi
      echo 'Проверка статуса Docker...'
      systemctl is-active --quiet docker || systemctl start docker
      systemctl is-enabled --quiet docker || systemctl enable docker
      if systemctl is-active --quiet docker; then
        echo 'Docker активен и включен.'
      else
        echo 'ПРЕДУПРЕЖДЕНИЕ: Не удалось активировать или включить Docker!'
        # exit 1 # Не выходим, даем шанс продолжиться
      fi
    `;
    const dockerResult = await executeSshCommand(deploymentId, host, port, sshUsername, dockerInstallScript, sshAuthProps.password, sshAuthProps.keyPath);
    if (dockerResult.code !== 0 && !dockerResult.output.includes('Docker уже установлен')) { // Не считаем ошибкой, если он уже есть
        throw new Error(`Ошибка установки Docker: ${dockerResult.error || dockerResult.output}`);
    }
    deployments[deploymentId].logs += `Установка/проверка Docker завершена.\n`;

    // --- Шаг 2: Скачивание образа Xray --- 
    deployments[deploymentId].status = 'pulling_image';
    deployments[deploymentId].logs += `\n--- Скачивание образа ${xrayImage} --- \n`;
    logger.info(`[Deployment ${deploymentId}] Скачивание образа Xray ${serverLogId}`);
    const pullResult = await executeSshCommand(deploymentId, host, port, sshUsername, `docker pull ${xrayImage}`, sshAuthProps.password, sshAuthProps.keyPath);
    // Ошибки pull часто не критичны, если образ уже есть локально
    if (pullResult.code !== 0 && !pullResult.output.includes('Image is up to date')) {
        logger.warn(`[Deployment ${deploymentId}] Ошибка скачивания образа Xray (код ${pullResult.code}): ${pullResult.error || pullResult.output}. Попытка продолжить...`);
        // throw new Error(`Ошибка скачивания образа Xray: ${pullResult.error || pullResult.output}`);
    }
    deployments[deploymentId].logs += `Скачивание/проверка образа ${xrayImage} завершено.\n`;

    // --- Шаг 3: Генерация и копирование конфигурации --- 
    deployments[deploymentId].status = 'creating_config';
    deployments[deploymentId].logs += `\n--- Генерация и копирование конфигурации Xray --- \n`;
    logger.info(`[Deployment ${deploymentId}] Генерация конфигурации Xray ${serverLogId}`);
    const { config: xrayConfig, initialUserId } = generateXrayConfig({ 
        domain: host, // Используем IP как домен для Reality
        adminEmail: config.adminEmail || 'admin@example.com', 
        initialUserEmail: `user-${uuidv4().substring(0,8)}@${host}`
    });

    // Сохраняем конфиг во временный файл
    try {
        fs.writeFileSync(tempConfigPath, JSON.stringify(xrayConfig, null, 2));
    } catch (writeError: any) {
        throw new Error(`Не удалось записать временный файл конфигурации ${tempConfigPath}: ${writeError.message}`);
    }
    deployments[deploymentId].logs += `Конфигурация сгенерирована (пользователь: ${initialUserId}).\n`;

    // Создаем директорию на удаленном сервере
    logger.info(`[Deployment ${deploymentId}] Создание директорий ${remoteConfigDir} и ${remoteLogDir} ${serverLogId}`);
    const mkdirResult = await executeSshCommand(deploymentId, host, port, sshUsername, `mkdir -p ${remoteConfigDir} ${remoteLogDir}`, sshAuthProps.password, sshAuthProps.keyPath);
    if (mkdirResult.code !== 0) {
        throw new Error(`Не удалось создать директории на сервере: ${mkdirResult.error || mkdirResult.output}`);
    }

    // Копируем конфигурацию
    logger.info(`[Deployment ${deploymentId}] Копирование конфигурации в ${remoteConfigDir}/config.json ${serverLogId}`);
    const scpResult = await copyFileScp(deploymentId, host, port, sshUsername, tempConfigPath, `${remoteConfigDir}/config.json`, sshAuthProps.password, sshAuthProps.keyPath);
    fs.unlinkSync(tempConfigPath); // Удаляем временный файл
    if (!scpResult.success) {
        throw new Error(`Ошибка копирования конфигурации: ${scpResult.error}`);
    }
    deployments[deploymentId].logs += `Конфигурация скопирована на сервер.\n`;

    // --- Шаг 4: Запуск контейнера Xray --- 
    deployments[deploymentId].status = 'starting_xray';
    deployments[deploymentId].logs += `\n--- Запуск контейнера Xray (${xrayContainerName}) --- \n`;
    logger.info(`[Deployment ${deploymentId}] Запуск контейнера Xray ${serverLogId}`);
    const runCommand = `
      docker stop ${xrayContainerName} >/dev/null 2>&1 && docker rm ${xrayContainerName} >/dev/null 2>&1 || true; 
      docker run -d --name ${xrayContainerName} \
        --network host \
        --restart always \
        -v ${remoteConfigDir}/config.json:/etc/xray/config.json:ro \
        -v ${remoteLogDir}:/var/log/xray \
        ${xrayImage}
    `; 
    // Используем --network host для простоты, т.к. Xray слушает 0.0.0.0:443
    // Если нужна изоляция, нужно использовать -p 443:443/tcp -p 443:443/udp

    const startResult = await executeSshCommand(deploymentId, host, port, sshUsername, runCommand, sshAuthProps.password, sshAuthProps.keyPath);
    if (startResult.code !== 0) {
        // Добавляем попытку посмотреть логи Docker, если запуск не удался
        const logsCmd = `docker logs ${xrayContainerName} --tail 20`;
        const logsResult = await executeSshCommand(deploymentId, host, port, sshUsername, logsCmd, sshAuthProps.password, sshAuthProps.keyPath);
        throw new Error(`Ошибка запуска контейнера Xray: ${startResult.error || startResult.output}\nDocker Logs:\n${logsResult.output}${logsResult.error}`);
    }
    // Добавим паузу перед проверкой статуса
    await new Promise(resolve => setTimeout(resolve, 5000)); // 5 секунд

    // Проверяем статус запущенного контейнера
    const statusCmd = `docker ps -f name=${xrayContainerName} --format "{{.Status}}"`;
    const statusResult = await executeSshCommand(deploymentId, host, port, sshUsername, statusCmd, sshAuthProps.password, sshAuthProps.keyPath);
    if (statusResult.code !== 0 || !statusResult.output.includes('Up')) {
        const logsCmd = `docker logs ${xrayContainerName} --tail 50`; // Больше логов
        const logsResult = await executeSshCommand(deploymentId, host, port, sshUsername, logsCmd, sshAuthProps.password, sshAuthProps.keyPath);
        throw new Error(`Контейнер Xray не запустился или работает некорректно. Статус: ${statusResult.output.trim()}\nDocker Logs:\n${logsResult.output}${logsResult.error}`);
    }
    deployments[deploymentId].logs += `Контейнер ${xrayContainerName} успешно запущен и работает (${statusResult.output.trim()}).\n`;

    // --- Завершение --- 
    deployments[deploymentId].status = 'completed';
    deployments[deploymentId].logs += `\n--- Развертывание успешно завершено! --- \n`;
    logger.info(`[Deployment ${deploymentId}] Развертывание Xray через Docker завершено успешно ${serverLogId}`);

    // Обновляем статус сервера в базе данных
    await prisma.vpnServer.update({
      where: { id: deployments[deploymentId].serverId },
      data: { isActive: true },
    });

  } catch (error: any) {
    logger.error(`[Deployment ${deploymentId}] Ошибка в процессе развертывания Docker: ${error.message} ${serverLogId}`);
    if (deployments[deploymentId]) {
      deployments[deploymentId].status = 'failed';
      deployments[deploymentId].error = error.message;
      deployments[deploymentId].logs += `\n--- Ошибка развертывания: ${error.message} --- \n`;
      // Помечаем сервер как неактивный в базе
       try {
         if (deployments[deploymentId].serverId) { // Убедимся, что ID сервера есть
           await prisma.vpnServer.update({
             where: { id: deployments[deploymentId].serverId },
             data: { isActive: false },
           });
         }
       } catch (dbError) {
         logger.error(`[Deployment ${deploymentId}] Не удалось обновить статус сервера на неактивный: ${dbError}`);
       }
    }
  } finally {
    // Удаляем временный файл конфига, если он остался
    if (fs.existsSync(tempConfigPath)) {
        try { fs.unlinkSync(tempConfigPath); } catch (e) {}
    }
    // Очищаем статус развертывания через 15 минут
    setTimeout(() => {
        if (deployments[deploymentId]) {
            logger.info(`[Deployment ${deploymentId}] Очистка статуса развертывания.`);
            delete deployments[deploymentId];
        }
    }, 15 * 60 * 1000);
  }
}

// (Остальной код файла, который не используется для Docker-развертывания, опущен для краткости)
// ...

/* // --- Закомментировано: Старая функция deployVpnServer ---
export async function deployVpnServer(options: ServerDeploymentOptions): Promise<{ success: boolean; serverId?: number; deploymentId?: string; error?: string }> {
  // ... (старый код) ...
}
*/ // --- Конец закомментированного блока ---

/* // --- Закомментировано: Старая функция deployVpnServerBackground ---
export async function deployVpnServerBackground(deploymentId: string, server: any, sshUsername: string, sshPassword?: string): Promise<void> {
  // ... (старый код) ...
}
*/ // --- Конец закомментированного блока ---

/* // --- Закомментировано: Старая функция getBaseInstallScript ---
function getBaseInstallScript(): string {
  // ... (старый код) ...
}
*/ // --- Конец закомментированного блока ---

// --- Другие функции (если есть), не относящиеся к Docker, могут остаться --- 