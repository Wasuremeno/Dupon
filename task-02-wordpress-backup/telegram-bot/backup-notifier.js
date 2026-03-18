/**
 * WordPress Backup Notifier - Telegram Bot
 * Уведомления о статусе бэкапов и управление удаленными серверами
 * 
 * @author Dmitry Vlaskin
 * @version 1.0.0
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const winston = require('winston');
const axios = require('axios');
const { Client } = require('ssh2');

const execPromise = util.promisify(exec);

// ==================== Настройка логирования ====================
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console({
            format: winston.format.simple()
        })
    ]
});

// ==================== Конфигурация ====================
const config = {
    telegramToken: process.env.TELEGRAM_TOKEN,
    allowedChatIds: (process.env.ALLOWED_CHAT_IDS || '').split(',').map(id => id.trim()),
    adminChatIds: (process.env.ADMIN_CHAT_IDS || '').split(',').map(id => id.trim()),
    backupDir: process.env.BACKUP_DIR || '/backups/wordpress',
    checkInterval: process.env.CHECK_INTERVAL || '0 */6 * * *', // Каждые 6 часов
    servers: process.env.SERVERS ? JSON.parse(process.env.SERVERS) : []
};

// ==================== Инициализация бота ====================
if (!config.telegramToken) {
    logger.error('TELEGRAM_TOKEN не задан в .env файле');
    process.exit(1);
}

const bot = new TelegramBot(config.telegramToken, { polling: true });

// ==================== Вспомогательные функции ====================

/**
 * Проверка, авторизован ли пользователь
 */
function isAuthorized(chatId) {
    return config.allowedChatIds.includes(chatId.toString());
}

/**
 * Проверка, является ли пользователь администратором
 */
function isAdmin(chatId) {
    return config.adminChatIds.includes(chatId.toString());
}

/**
 * Форматирование размера файла
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Получение списка бэкапов
 */
async function getBackupsList() {
    try {
        const files = await fs.readdir(config.backupDir);
        const backups = files
            .filter(file => file.endsWith('.tar.gz'))
            .map(file => {
                const stat = fs.statSync(path.join(config.backupDir, file));
                return {
                    name: file,
                    size: stat.size,
                    sizeFormatted: formatFileSize(stat.size),
                    modified: stat.mtime,
                    age: Math.floor((Date.now() - stat.mtime) / (1000 * 60 * 60 * 24)) // в днях
                };
            })
            .sort((a, b) => b.modified - a.modified);
        
        return backups;
    } catch (error) {
        logger.error('Ошибка при получении списка бэкапов:', error);
        return [];
    }
}

/**
 * Проверка свежести бэкапа (не старше 2 дней)
 */
async function checkBackupFreshness() {
    const backups = await getBackupsList();
    if (backups.length === 0) {
        return { status: 'error', message: '❌ Бэкапы не найдены' };
    }
    
    const latest = backups[0];
    if (latest.age > 2) {
        return { 
            status: 'warning', 
            message: `⚠️ Последний бэкап устарел: ${latest.age} дней назад\nФайл: ${latest.name}\nРазмер: ${latest.sizeFormatted}` 
        };
    }
    
    return { 
        status: 'ok', 
        message: `✅ Свежий бэкап: ${latest.age} дней назад\nФайл: ${latest.name}\nРазмер: ${latest.sizeFormatted}` 
    };
}

/**
 * Выполнение команды на удаленном сервере через SSH
 */
async function executeRemoteCommand(server, command) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        
        conn.on('ready', () => {
            conn.exec(command, (err, stream) => {
                if (err) {
                    conn.end();
                    reject(err);
                    return;
                }
                
                let output = '';
                let error = '';
                
                stream.on('close', (code, signal) => {
                    conn.end();
                    if (code === 0) {
                        resolve({ success: true, output });
                    } else {
                        resolve({ success: false, output: error || output });
                    }
                }).on('data', (data) => {
                    output += data.toString();
                }).stderr.on('data', (data) => {
                    error += data.toString();
                });
            });
        }).on('error', (err) => {
            reject(err);
        }).connect({
            host: server.host,
            port: server.port || 22,
            username: server.username,
            privateKey: server.privateKey ? fs.readFileSync(server.privateKey) : undefined,
            password: server.password
        });
    });
}

// ==================== Обработчики команд Telegram ====================

/**
 * Команда /start
 */
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const firstName = msg.from.first_name || 'пользователь';
    
    if (!isAuthorized(chatId)) {
        bot.sendMessage(chatId, '❌ У вас нет доступа к этому боту.');
        logger.warn(`Неавторизованный доступ: ${chatId} (${msg.from.username})`);
        return;
    }
    
    const welcomeMessage = `
👋 Привет, ${firstName}!

Я бот для мониторинга бэкапов WordPress.

📋 *Доступные команды:*
/status - Проверить статус последнего бэкапа
/list [N] - Показать последние N бэкапов (по умолчанию 5)
/check - Проверить свежесть бэкапов
/space - Показать свободное место на диске
/logs [N] - Показать последние N строк лога
/help - Показать эту справку

${isAdmin(chatId) ? '👑 *Команды администратора:*\n/run_backup - Запустить бэкап вручную\n/clean [days] - Очистить бэкапы старше N дней\n/config - Показать конфигурацию\n' : ''}
    `;
    
    bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
    logger.info(`Авторизованный доступ: ${chatId} (${msg.from.username})`);
});

/**
 * Команда /help
 */
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    
    bot.sendMessage(chatId, 'Используйте /start для просмотра доступных команд.');
});

/**
 * Команда /status - статус последнего бэкапа
 */
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    
    const statusMsg = await bot.sendMessage(chatId, '🔍 Проверяю статус бэкапов...');
    
    try {
        const backups = await getBackupsList();
        
        if (backups.length === 0) {
            await bot.editMessageText('❌ Бэкапы не найдены', {
                chat_id: chatId,
                message_id: statusMsg.message_id
            });
            return;
        }
        
        const latest = backups[0];
        const totalSize = backups.reduce((sum, b) => sum + b.size, 0);
        const totalFormatted = formatFileSize(totalSize);
        
        let status = '✅ *Актуальный бэкап*\n\n';
        status += `📦 *Последний:* ${latest.name}\n`;
        status += `📊 *Размер:* ${latest.sizeFormatted}\n`;
        status += `⏱️ *Создан:* ${latest.modified.toLocaleString('ru-RU')}\n`;
        status += `📅 *Возраст:* ${latest.age} ${pluralize(latest.age, ['день', 'дня', 'дней'])}\n\n`;
        status += `📚 *Всего бэкапов:* ${backups.length}\n`;
        status += `💾 *Общий размер:* ${totalFormatted}\n`;
        
        if (latest.age <= 2) {
            status += `\n🟢 *Статус:* OK`;
        } else if (latest.age <= 5) {
            status += `\n🟡 *Статус:* Требуется внимание`;
        } else {
            status += `\n🔴 *Статус:* Критический`;
        }
        
        await bot.editMessageText(status, {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            parse_mode: 'Markdown'
        });
        
    } catch (error) {
        logger.error('Ошибка в /status:', error);
        await bot.editMessageText('❌ Ошибка при получении статуса', {
            chat_id: chatId,
            message_id: statusMsg.message_id
        });
    }
});

/**
 * Команда /list [N] - список последних N бэкапов
 */
bot.onText(/\/list(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    
    const count = match[1] ? parseInt(match[1]) : 5;
    if (count > 20) {
        bot.sendMessage(chatId, '❌ Максимум 20 бэкапов за раз');
        return;
    }
    
    const statusMsg = await bot.sendMessage(chatId, `🔍 Получаю список последних ${count} бэкапов...`);
    
    try {
        const backups = await getBackupsList();
        
        if (backups.length === 0) {
            await bot.editMessageText('❌ Бэкапы не найдены', {
                chat_id: chatId,
                message_id: statusMsg.message_id
            });
            return;
        }
        
        const recent = backups.slice(0, count);
        
        let message = `📋 *Последние ${recent.length} бэкапов:*\n\n`;
        
        recent.forEach((backup, index) => {
            const ageEmoji = backup.age <= 2 ? '🟢' : (backup.age <= 5 ? '🟡' : '🔴');
            message += `${ageEmoji} *${index + 1}.* ${backup.name}\n`;
            message += `   └ 📦 ${backup.sizeFormatted} | 📅 ${backup.modified.toLocaleDateString('ru-RU')} (${backup.age} дн.)\n`;
        });
        
        message += `\n📊 *Всего:* ${backups.length} бэкапов, общий размер: ${formatFileSize(backups.reduce((sum, b) => sum + b.size, 0))}`;
        
        await bot.editMessageText(message, {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            parse_mode: 'Markdown'
        });
        
    } catch (error) {
        logger.error('Ошибка в /list:', error);
        await bot.editMessageText('❌ Ошибка при получении списка', {
            chat_id: chatId,
            message_id: statusMsg.message_id
        });
    }
});

/**
 * Команда /check - проверка свежести бэкапов
 */
bot.onText(/\/check/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    
    const statusMsg = await bot.sendMessage(chatId, '🔍 Проверяю свежесть бэкапов...');
    
    try {
        const result = await checkBackupFreshness();
        
        let emoji = '✅';
        if (result.status === 'warning') emoji = '⚠️';
        if (result.status === 'error') emoji = '❌';
        
        await bot.editMessageText(`${emoji} ${result.message}`, {
            chat_id: chatId,
            message_id: statusMsg.message_id
        });
        
    } catch (error) {
        logger.error('Ошибка в /check:', error);
        await bot.editMessageText('❌ Ошибка при проверке', {
            chat_id: chatId,
            message_id: statusMsg.message_id
        });
    }
});

/**
 * Команда /space - свободное место на диске
 */
bot.onText(/\/space/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    
    const statusMsg = await bot.sendMessage(chatId, '🔍 Проверяю свободное место...');
    
    try {
        const { stdout } = await execPromise(`df -h ${config.backupDir}`);
        const lines = stdout.split('\n');
        
        if (lines.length < 2) {
            throw new Error('Не удалось получить информацию о диске');
        }
        
        const parts = lines[1].split(/\s+/);
        const message = `
💾 *Информация о диске:*

📁 *Директория:* ${config.backupDir}
📊 *Всего:* ${parts[1]}
📦 *Использовано:* ${parts[2]}
🆓 *Свободно:* ${parts[3]}
📈 *Использовано %:* ${parts[4]}

${parseInt(parts[3]) < 5 ? '⚠️ *Внимание:* Мало свободного места!' : '✅ *Места достаточно*'}
        `;
        
        await bot.editMessageText(message, {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            parse_mode: 'Markdown'
        });
        
    } catch (error) {
        logger.error('Ошибка в /space:', error);
        await bot.editMessageText('❌ Ошибка при проверке места', {
            chat_id: chatId,
            message_id: statusMsg.message_id
        });
    }
});

/**
 * Команда /logs [N] - последние N строк лога
 */
bot.onText(/\/logs(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    
    const lines = match[1] ? parseInt(match[1]) : 20;
    if (lines > 100) {
        bot.sendMessage(chatId, '❌ Максимум 100 строк');
        return;
    }
    
    const statusMsg = await bot.sendMessage(chatId, `🔍 Получаю последние ${lines} строк лога...`);
    
    try {
        const logFile = '/var/log/wordpress-backup.log';
        
        if (!await fs.pathExists(logFile)) {
            await bot.editMessageText('❌ Лог-файл не найден', {
                chat_id: chatId,
                message_id: statusMsg.message_id
            });
            return;
        }
        
        const { stdout } = await execPromise(`tail -n ${lines} ${logFile}`);
        
        if (!stdout.trim()) {
            await bot.editMessageText('📝 Лог пуст', {
                chat_id: chatId,
                message_id: statusMsg.message_id
            });
            return;
        }
        
        // Обрезаем, если слишком длинное сообщение
        let logText = stdout;
        if (logText.length > 3500) {
            logText = logText.substring(0, 3500) + '...\n\n(сообщение обрезано)';
        }
        
        await bot.editMessageText(`📝 *Последние строки лога:*\n\`\`\`\n${logText}\n\`\`\``, {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            parse_mode: 'Markdown'
        });
        
    } catch (error) {
        logger.error('Ошибка в /logs:', error);
        await bot.editMessageText('❌ Ошибка при чтении лога', {
            chat_id: chatId,
            message_id: statusMsg.message_id
        });
    }
});

// ==================== Команды администратора ====================

/**
 * Команда /run_backup - ручной запуск бэкапа
 */
bot.onText(/\/run_backup/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) {
        bot.sendMessage(chatId, '❌ Эта команда только для администраторов');
        return;
    }
    
    const statusMsg = await bot.sendMessage(chatId, '🔄 Запускаю бэкап...');
    
    try {
        const { stdout, stderr } = await execPromise('/usr/local/bin/backup-wordpress.sh');
        
        if (stderr) {
            logger.error('Ошибка при запуске бэкапа:', stderr);
        }
        
        await bot.editMessageText('✅ Бэкап запущен. Результат придет в уведомлении.', {
            chat_id: chatId,
            message_id: statusMsg.message_id
        });
        
    } catch (error) {
        logger.error('Ошибка в /run_backup:', error);
        await bot.editMessageText(`❌ Ошибка при запуске бэкапа: ${error.message}`, {
            chat_id: chatId,
            message_id: statusMsg.message_id
        });
    }
});

/**
 * Команда /clean [days] - очистка старых бэкапов
 */
bot.onText(/\/clean(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    
    const days = match[1] ? parseInt(match[1]) : 7;
    
    const statusMsg = await bot.sendMessage(chatId, `🧹 Удаляю бэкапы старше ${days} дней...`);
    
    try {
        const { stdout } = await execPromise(`find ${config.backupDir} -type f -name "*.tar.gz" -mtime +${days} -delete -print`);
        
        const deletedCount = stdout.split('\n').filter(line => line.trim()).length;
        
        await bot.editMessageText(`✅ Удалено бэкапов: ${deletedCount}`, {
            chat_id: chatId,
            message_id: statusMsg.message_id
        });
        
    } catch (error) {
        logger.error('Ошибка в /clean:', error);
        await bot.editMessageText(`❌ Ошибка при очистке: ${error.message}`, {
            chat_id: chatId,
            message_id: statusMsg.message_id
        });
    }
});

/**
 * Команда /config - показать конфигурацию
 */
bot.onText(/\/config/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    
    const configMessage = `
⚙️ *Текущая конфигурация:*

📁 *Директория бэкапов:* ${config.backupDir}
⏱️ *Интервал проверки:* ${config.checkInterval}
👥 *Авторизованные чаты:* ${config.allowedChatIds.length}
👑 *Администраторы:* ${config.adminChatIds.length}
🖥️ *Серверов в мониторинге:* ${config.servers.length}

*Переменные окружения:*
${Object.keys(process.env)
    .filter(key => key.startsWith('BACKUP_') || key.startsWith('TELEGRAM_') || key.includes('TOKEN'))
    .map(key => `  • ${key}=${key.includes('TOKEN') ? '***' : process.env[key]}`)
    .join('\n')}
    `;
    
    bot.sendMessage(chatId, configMessage, { parse_mode: 'Markdown' });
});

// ==================== Плановые проверки ====================

/**
 * Плановая проверка статуса бэкапов
 */
cron.schedule(config.checkInterval, async () => {
    logger.info('Запуск плановой проверки бэкапов');
    
    try {
        const result = await checkBackupFreshness();
        
        // Отправляем уведомление только если есть проблемы
        if (result.status !== 'ok') {
            for (const chatId of config.adminChatIds) {
                await bot.sendMessage(chatId, result.message);
            }
            logger.warn(`Плановая проверка: ${result.status} - ${result.message}`);
        } else {
            logger.info(`Плановая проверка: OK`);
        }
        
    } catch (error) {
        logger.error('Ошибка в плановой проверке:', error);
        for (const chatId of config.adminChatIds) {
            await bot.sendMessage(chatId, `❌ Ошибка при плановой проверке: ${error.message}`);
        }
    }
});

// ==================== Вспомогательные функции ====================

/**
 * Склонение существительных
 */
function pluralize(count, words) {
    const cases = [2, 0, 1, 1, 1, 2];
    return words[
        count % 100 > 4 && count % 100 < 20
            ? 2
            : cases[Math.min(count % 10, 5)]
    ];
}

// ==================== Обработка ошибок ====================

bot.on('polling_error', (error) => {
    logger.error('Polling error:', error);
});

process.on('unhandledRejection', (error) => {
    logger.error('Unhandled rejection:', error);
});

logger.info('Telegram bot started');
console.log('🤖 Бот запущен. Нажмите Ctrl+C для остановки.');