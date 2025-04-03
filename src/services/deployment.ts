// import axios from 'axios'; // Закомментируем, если не используется в других частях файла
import { prisma } from './database';
import logger from '../utils/logger';
import config from '../config';
import { v4 as uuidv4 } from 'uuid';
import { spawn, execSync, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Интерфейс для ключей Reality
export interface RealityKeys {
  privateKey: string;
  publicKey: string;
  shortId: string;
}

// Функция генерации ключей Reality
function generateRealityKeys(): RealityKeys | null {
    try {
        logger.info('Генерация ключей Xray Reality...');
        const output = execSync('/usr/local/bin/xray x25519', { encoding: 'utf8' });
        const privateKeyMatch = output.match(/Private key:\s*(\S+)/);
        const publicKeyMatch = output.match(/Public key:\s*(\S+)/);
        if (!privateKeyMatch || !publicKeyMatch) {
            logger.error('Не удалось распарсить вывод команды xray x25519:', output);
            return null;
        }
        const privateKey = privateKeyMatch[1];
        const publicKey = publicKeyMatch[1];
        const shortId = Array.from({ length: Math.floor(Math.random() * 9) + 8 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
        logger.info('Ключи Reality успешно сгенерированы.');
        return { privateKey, publicKey, shortId };
    } catch (error: any) {
        logger.error('Ошибка при выполнении команды xray x25519:', error.message);
        return null;
    }
}

// Импортируем функцию генерации КОНФИГАЦИИ и ее опции
import { generateXrayConfig, XrayConfigOptions } from './configGenerator'; 

// Опции для развертывания сервера
export interface ServerDeploymentOptions {
  name: string;
  host: string; 
  port?: number; 
  sshUsername?: string; 
  sshPassword?: string; 
  sshKeyPath?: string; 
  location?: string; 
  provider?: string; 
}

// Хранилище статусов развертывания
interface DeploymentState {
  status: 'pending' | 'installing_docker' | 'pulling_image' | 'creating_config' | 'starting_xray' | 'completed' | 'failed';
  serverId: number;
  logs: string;
  error?: string;
}
const deployments: Record<string, DeploymentState> = {};

export function getDeploymentStatus(deploymentId: string): DeploymentState | null {
  return deployments[deploymentId] || null;
}

async function executeSshCommand(deploymentId: string, host: string, port: number, username: string, command: string, password?: string, keyPath?: string): Promise<{ code: number | null; output: string; error: string }> {
   return new Promise((resolve) => {
    const serverLogId = deployments[deploymentId]?.serverId ? `(Server ID: ${deployments[deploymentId].serverId})` : '';
    const sshOptions = ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-p', port.toString(), `${username}@${host}`, command];
    let processName: string; let args: string[];
    if (password) { processName = '/usr/bin/sshpass'; args = ['-p', password, '/usr/bin/ssh', ...sshOptions]; }
    else if (keyPath) { processName = '/usr/bin/ssh'; args = ['-i', keyPath, ...sshOptions]; }
    else { resolve({ code: -1, output: '', error: 'Не указан пароль или путь к ключу SSH' }); return; }

    const logOutput = (data: any, stream: 'stdout' | 'stderr') => {
      if (!deployments[deploymentId]) return; 
      const outputStr = data.toString();
      deployments[deploymentId].logs += outputStr;
      logger[stream === 'stderr' ? 'warn' : 'info'](`[Deployment ${deploymentId}] SSH ${stream.toUpperCase()}: ${outputStr.trim()} ${serverLogId}`);
    };

    try {
      const sshProcess = spawn(processName, args);
      let stdout = ''; let stderr = '';
      sshProcess.stdout.on('data', d => { stdout += d; logOutput(d, 'stdout'); });
      sshProcess.stderr.on('data', d => { stderr += d; logOutput(d, 'stderr'); });
      sshProcess.on('close', code => resolve({ code, output: stdout, error: stderr }));
      sshProcess.on('error', err => {
        const errorMsg = `Ошибка запуска ${processName}: ${err.message}`;
        if (deployments[deploymentId]) deployments[deploymentId].logs += `\n${errorMsg}\n`;
        logger.error(`[Deployment ${deploymentId}] ${errorMsg} ${serverLogId}`);
        resolve({ code: -1, output: stdout, error: `${stderr}\n${errorMsg}` });
      });
    } catch (spawnError: any) {
      const errorMsg = `Исключение при запуске ${processName}: ${spawnError.message}`;
      if (deployments[deploymentId]) deployments[deploymentId].logs += `\n${errorMsg}\n`;
      logger.error(`[Deployment ${deploymentId}] ${errorMsg} ${serverLogId}`);
      resolve({ code: -1, output: '', error: errorMsg });
    }
  });
}

async function copyFileScp(deploymentId: string, host: string, port: number, username: string, localPath: string, remotePath: string, password?: string, keyPath?: string): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
    const serverLogId = deployments[deploymentId]?.serverId ? `(Server ID: ${deployments[deploymentId].serverId})` : '';
    const scpOptions = ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-P', port.toString()];
    let processName: string; let args: string[];
    if (password) { processName = '/usr/bin/sshpass'; args = ['-p', password, '/usr/bin/scp', ...scpOptions, localPath, `${username}@${host}:${remotePath}`]; }
    else if (keyPath) { processName = '/usr/bin/scp'; args = ['-i', keyPath, ...scpOptions, localPath, `${username}@${host}:${remotePath}`]; }
    else { resolve({ success: false, error: 'Не указан пароль или путь к ключу SSH для SCP' }); return; }

    const logOutput = (data: any) => {
      if (!deployments[deploymentId]) return;
      const outputStr = data.toString();
      deployments[deploymentId].logs += outputStr;
      logger.warn(`[Deployment ${deploymentId}] SCP STDERR: ${outputStr.trim()} ${serverLogId}`);
    };

    try {
      const scpProcess = spawn(processName, args);
      let stderr = '';
      scpProcess.stderr.on('data', d => { stderr += d; logOutput(d); });
      scpProcess.on('close', code => resolve({ success: code === 0, error: code !== 0 ? `Ошибка SCP (код: ${code}): ${stderr.trim()}` : undefined }));
      scpProcess.on('error', err => {
        const errorMsg = `Ошибка запуска ${processName} для SCP: ${err.message}`;
        if (deployments[deploymentId]) deployments[deploymentId].logs += `\n${errorMsg}\n`;
        logger.error(`[Deployment ${deploymentId}] ${errorMsg} ${serverLogId}`);
        resolve({ success: false, error: errorMsg });
      });
    } catch (spawnError: any) {
      const errorMsg = `Исключение при запуске ${processName} для SCP: ${spawnError.message}`;
       if (deployments[deploymentId]) deployments[deploymentId].logs += `\n${errorMsg}\n`;
      logger.error(`[Deployment ${deploymentId}] ${errorMsg} ${serverLogId}`);
      resolve({ success: false, error: errorMsg });
    }
  });
}

export async function deployVpnServerDocker(options: ServerDeploymentOptions): Promise<{ success: boolean; serverId?: number; deploymentId?: string; error?: string }> {
  const deploymentId = uuidv4();
  let serverId: number | undefined = undefined;
  const installDir = path.join(process.cwd(), 'install');
  if (!fs.existsSync(installDir)) {
    try { fs.mkdirSync(installDir, { recursive: true }); logger.info(`Создана директория: ${installDir}`); }
    catch (mkdirError: any) { logger.error(`Не удалось создать директорию ${installDir}: ${mkdirError.message}`); return { success: false, error: `Ошибка создания директории install: ${mkdirError.message}` }; }
  }
  const tempConfigPath = path.join(installDir, `xray_config_${deploymentId}.json`);

  try {
    logger.info('Предварительная генерация ключей Xray Reality...');
    const realityKeys = generateRealityKeys();
    if (!realityKeys) throw new Error("Не удалось сгенерировать ключи Reality.");
    logger.info('Ключи Reality сгенерированы.');

    // Используем VpnServerUncheckedCreateInput для обхода строгой типизации при необходимости
    const serverData = {
        name: options.name,
        host: options.host,
        port: 443, 
        location: options.location || 'N/A',
        provider: options.provider || 'N/A',
        isActive: false,
        configData: 'docker',
        realityPublicKey: realityKeys.publicKey,
        realityShortId: realityKeys.shortId,
        // Явно указываем значения по умолчанию для всех обязательных полей
        maxClients: 100, 
        currentClients: 0,
        isAutoScaled: false
    };

    // Prisma Client теперь должен знать о новых полях после миграции
    const server = await prisma.vpnServer.create({ data: serverData }); 
    serverId = server.id;
    logger.info(`Сервер ${options.name} (${options.host}) добавлен в базу данных с ID: ${serverId}`);

    deployments[deploymentId] = { status: 'pending', serverId, logs: `Начало развертывания Xray Docker на ${options.host} (ID: ${serverId})...\n` };

    deployVpnServerDockerBackground(deploymentId, options, tempConfigPath, realityKeys);

    return { success: true, serverId, deploymentId };

  } catch (error: any) {
    logger.error(`Ошибка при запуске развертывания Docker: ${error.message}`);
    if (deploymentId && deployments[deploymentId]) { deployments[deploymentId].status = 'failed'; deployments[deploymentId].error = `Ошибка инициации: ${error.message}`; }
    if (fs.existsSync(tempConfigPath)) { try { fs.unlinkSync(tempConfigPath); } catch (e) {} }
    return { success: false, error: `Ошибка инициации развертывания: ${error.message}` };
  }
}

async function deployVpnServerDockerBackground(
  deploymentId: string,
  options: ServerDeploymentOptions,
  tempConfigPath: string,
  realityKeys: RealityKeys
) {
  const { host, port = 22, sshUsername = 'root', sshPassword, sshKeyPath = config.sshPrivateKeyPath } = options;
  const serverLogId = `(Server ID: ${deployments[deploymentId]?.serverId})`;
  const xrayImage = 'teddysun/xray:latest';
  const xrayContainerName = 'xray_vpn';
  const remoteConfigDir = '/etc/xray';
  const remoteLogDir = '/var/log/xray';

  const updateStatus = (status: DeploymentState['status'], logMsg: string) => {
      if (!deployments[deploymentId]) return;
      deployments[deploymentId].status = status;
      deployments[deploymentId].logs += logMsg;
      logger.info(`[Deployment ${deploymentId}] ${logMsg.trim()} ${serverLogId}`);
  }

  try {
    const usePassword = !!sshPassword;
    const useKey = !usePassword && sshKeyPath && fs.existsSync(sshKeyPath);
    if (!usePassword && !useKey) throw new Error(`Не найден SSH ключ (${sshKeyPath || 'путь не указан'}) и не указан пароль.`);
    const sshAuthProps = { password: usePassword ? sshPassword : undefined, keyPath: useKey ? sshKeyPath : undefined };

    // Шаг 1: Установка Docker
    updateStatus('installing_docker', `\n--- Установка Docker на ${host} --- \n`);
    const dockerInstallScript = `export DEBIAN_FRONTEND=noninteractive; if ! command -v docker &> /dev/null; then echo 'Установка Docker...'; apt-get update -qq > /dev/null && apt-get install -y -qq curl wget apt-transport-https ca-certificates software-properties-common gpg > /dev/null && curl -fsSL https://download.docker.com/linux/$(. /etc/os-release; echo "$ID")/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/$(. /etc/os-release; echo "$ID") $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null && apt-get update -qq > /dev/null && apt-get install -y -qq docker-ce docker-ce-cli containerd.io > /dev/null && echo 'Docker успешно установлен.' || exit 1; else echo 'Docker уже установлен.'; fi; systemctl is-active --quiet docker || systemctl start docker; systemctl is-enabled --quiet docker || systemctl enable docker; if systemctl is-active --quiet docker; then echo 'Docker активен.'; else echo 'Ошибка Docker!' && exit 1; fi`;
    const dockerResult = await executeSshCommand(deploymentId, host, port, sshUsername, dockerInstallScript, sshAuthProps.password, sshAuthProps.keyPath);
    if (dockerResult.code !== 0 && !dockerResult.output.includes('Docker уже установлен')) throw new Error(`Ошибка установки Docker: ${dockerResult.error || dockerResult.output}`);
    updateStatus('installing_docker', `Установка/проверка Docker завершена.\n`);

    // Шаг 2: Скачивание образа Xray
    updateStatus('pulling_image', `\n--- Скачивание образа ${xrayImage} --- \n`);
    const pullResult = await executeSshCommand(deploymentId, host, port, sshUsername, `docker pull ${xrayImage}`, sshAuthProps.password, sshAuthProps.keyPath);
    if (pullResult.code !== 0 && !pullResult.output.includes('Image is up to date')) logger.warn(`[Deployment ${deploymentId}] Ошибка скачивания Xray (код ${pullResult.code}): ${pullResult.error || pullResult.output}. Попытка продолжить...`);
    updateStatus('pulling_image', `Скачивание/проверка образа ${xrayImage} завершено.\n`);

    // Шаг 3: Генерация и копирование конфигурации
    updateStatus('creating_config', `\n--- Генерация и копирование конфигурации Xray --- \n`);
    const configOptions: XrayConfigOptions & { realityKeys: RealityKeys } = { 
        domain: host, 
        adminEmail: config.adminEmail || 'admin@example.com', 
        initialUserEmail: `user-${uuidv4().substring(0,8)}@${host}`,
        realityKeys: realityKeys 
    };
    const { config: xrayConfig, initialUserId } = generateXrayConfig(configOptions);
    
    // Сохраняем initialUserId в базу данных
    prisma.vpnServer.update({ 
        where: { id: deployments[deploymentId].serverId }, 
        data: { initialUserId: initialUserId } 
    }).catch(err => logger.error(`[Deployment ${deploymentId}] Не удалось сохранить initialUserId в БД: ${err.message}`));
    
    try { fs.writeFileSync(tempConfigPath, JSON.stringify(xrayConfig, null, 2)); }
    catch (writeError: any) { throw new Error(`Не удалось записать временный файл конфигурации ${tempConfigPath}: ${writeError.message}`); }
    updateStatus('creating_config', `Конфигурация сгенерирована (пользователь: ${initialUserId}).\n`);

    const mkdirResult = await executeSshCommand(deploymentId, host, port, sshUsername, `mkdir -p ${remoteConfigDir} ${remoteLogDir}`, sshAuthProps.password, sshAuthProps.keyPath);
    if (mkdirResult.code !== 0) throw new Error(`Не удалось создать директории на сервере: ${mkdirResult.error || mkdirResult.output}`);
    
    const scpResult = await copyFileScp(deploymentId, host, port, sshUsername, tempConfigPath, `${remoteConfigDir}/config.json`, sshAuthProps.password, sshAuthProps.keyPath);
    fs.unlinkSync(tempConfigPath); 
    if (!scpResult.success) throw new Error(`Ошибка копирования конфигурации: ${scpResult.error}`);
    updateStatus('creating_config', `Конфигурация скопирована на сервер.\n`);

    // Шаг 4: Запуск контейнера Xray
    updateStatus('starting_xray', `\n--- Запуск контейнера Xray (${xrayContainerName}) --- \n`);
    const runCommand = `docker stop ${xrayContainerName} >/dev/null 2>&1 && docker rm ${xrayContainerName} >/dev/null 2>&1 || true; docker run -d --name ${xrayContainerName} --network host --restart always -v ${remoteConfigDir}/config.json:/etc/xray/config.json:ro -v ${remoteLogDir}:/var/log/xray ${xrayImage}`;
    const startResult = await executeSshCommand(deploymentId, host, port, sshUsername, runCommand, sshAuthProps.password, sshAuthProps.keyPath);
    if (startResult.code !== 0) {
        const logsCmd = `docker logs ${xrayContainerName} --tail 20`;
        const logsResult = await executeSshCommand(deploymentId, host, port, sshUsername, logsCmd, sshAuthProps.password, sshAuthProps.keyPath);
        throw new Error(`Ошибка запуска контейнера Xray: ${startResult.error || startResult.output}\nDocker Logs:\n${logsResult.output}${logsResult.error}`);
    }
    await new Promise(resolve => setTimeout(resolve, 5000)); 

    const statusCmd = `docker ps -f name=${xrayContainerName} --format "{{.Status}}"`;
    const statusResult = await executeSshCommand(deploymentId, host, port, sshUsername, statusCmd, sshAuthProps.password, sshAuthProps.keyPath);
    if (statusResult.code !== 0 || !statusResult.output.includes('Up')) {
        const logsCmd = `docker logs ${xrayContainerName} --tail 50`; 
        const logsResult = await executeSshCommand(deploymentId, host, port, sshUsername, logsCmd, sshAuthProps.password, sshAuthProps.keyPath);
        throw new Error(`Контейнер Xray не запустился или работает некорректно. Статус: ${statusResult.output.trim()}\nDocker Logs:\n${logsResult.output}${logsResult.error}`);
    }
    updateStatus('starting_xray', `Контейнер ${xrayContainerName} успешно запущен и работает (${statusResult.output.trim()}).\n`);

    // --- Завершение --- 
    updateStatus('completed', `\n--- Развертывание успешно завершено! --- \n`);
    await prisma.vpnServer.update({
      where: { id: deployments[deploymentId].serverId },
      data: { isActive: true },
    });

  } catch (error: any) {
    logger.error(`[Deployment ${deploymentId}] Ошибка развертывания Docker: ${error.message} ${serverLogId}`);
    if (deployments[deploymentId]) {
    deployments[deploymentId].status = 'failed';
      deployments[deploymentId].error = error.message;
      deployments[deploymentId].logs += `\n--- Ошибка развертывания: ${error.message} --- \n`;
       try { if (deployments[deploymentId].serverId) await prisma.vpnServer.update({ where: { id: deployments[deploymentId].serverId }, data: { isActive: false } }); }
       catch (dbError) { logger.error(`[Deployment ${deploymentId}] Не удалось обновить статус сервера на неактивный: ${dbError}`); }
    }
  } finally {
    if (fs.existsSync(tempConfigPath)) { try { fs.unlinkSync(tempConfigPath); } catch (e) {} }
    setTimeout(() => { if (deployments[deploymentId]) { logger.info(`[Deployment ${deploymentId}] Очистка статуса развертывания.`); delete deployments[deploymentId]; } }, 15 * 60 * 1000);
  }
}

/* // --- Закомментировано: Старые функции ---
// ... (код закомментированных функций) ...
*/ // --- Конец закомментированного блока ---