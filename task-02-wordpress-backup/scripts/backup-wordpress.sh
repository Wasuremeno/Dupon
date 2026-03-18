
---
`

```bash
#!/bin/bash
# backup-wordpress.sh - Автоматический бэкап WordPress с уведомлением в Telegram
# Версия: 1.0
# Дата: 2024

set -e  # Выход при ошибке
set -u  # Ошибка если переменная не задана

# Цвета для вывода (опционально)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Загрузка конфигурации
CONFIG_FILE="/etc/wordpress-backup/config.env"
if [ -f "$CONFIG_FILE" ]; then
    source "$CONFIG_FILE"
else
    echo "❌ Конфиг не найден: $CONFIG_FILE"
    exit 1
fi

# Проверка обязательных переменных
REQUIRED_VARS=("SITE_PATH" "DB_NAME" "DB_USER" "DB_PASS" "BACKUP_DIR" "TELEGRAM_TOKEN" "CHAT_ID")
for var in "${REQUIRED_VARS[@]}"; do
    if [ -z "${!var:-}" ]; then
        echo "❌ Переменная $var не задана в конфиге"
        exit 1
    fi
done

# Создание директории для бэкапов если нет
mkdir -p "$BACKUP_DIR"

# Переменные
DATE=$(date +%Y-%m-%d)
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="wp_backup_${DATE}_${TIMESTAMP}"
BACKUP_PATH="$BACKUP_DIR/$BACKUP_NAME"
BACKUP_ARCHIVE="$BACKUP_DIR/${BACKUP_NAME}.tar.gz"
TEMP_DIR="/tmp/backup_$$"
LOG_FILE="/var/log/wordpress-backup.log"
START_TIME=$(date +%s)

# Функция логирования
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# Функция отправки в Telegram
send_telegram() {
    local message="$1"
    local parse_mode="${2:-HTML}"
    local chat="${3:-$CHAT_ID}"
    
    curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_TOKEN/sendMessage" \
        -d chat_id="$chat" \
        -d text="$message" \
        -d parse_mode="$parse_mode" > /dev/null
}

# Функция проверки свободного места
check_disk_space() {
    local required_space=$((5 * 1024 * 1024))  # 5GB в KB
    local available_space=$(df "$BACKUP_DIR" | awk 'NR==2 {print $4}')
    
    if [ "$available_space" -lt "$required_space" ]; then
        local available_gb=$((available_space / 1024 / 1024))
        local warning="⚠️ <b>Внимание: мало места на диске</b>\n"
        warning+="Доступно: ${available_gb} GB\n"
        warning+="Требуется минимум: 5 GB\n"
        warning+="Бэкап продолжен, но может не завершиться"
        
        log "WARNING: Мало места ($available_gb GB)"
        send_telegram "$warning" "HTML" "${ERROR_CHAT_ID:-$CHAT_ID}"
    fi
}

# Функция очистки старых бэкапов
cleanup_old_backups() {
    local days="${BACKUP_RETENTION_DAYS:-7}"
    log "Очистка бэкапов старше $days дней"
    
    find "$BACKUP_DIR" -type f -name "*.tar.gz" -mtime +"$days" -delete
    find "$BACKUP_DIR" -type f -name "*.log" -mtime +"$days" -delete
}

# Начало бэкапа
log "=== Начало бэкапа WordPress ==="
log "Сайт: $SITE_PATH"
log "База данных: $DB_NAME"

# Проверка свободного места
check_disk_space

# Создание временной директории
mkdir -p "$TEMP_DIR"/{db,files}
log "Создана временная директория: $TEMP_DIR"

# 1. Бэкап базы данных
log "Бэкап базы данных..."
if mysqldump --opt -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" > "$TEMP_DIR/db/database.sql" 2>> "$LOG_FILE"; then
    DB_SIZE=$(du -h "$TEMP_DIR/db/database.sql" | cut -f1)
    DB_TABLES=$(grep -c "CREATE TABLE" "$TEMP_DIR/db/database.sql" 2>/dev/null || echo "unknown")
    log "✅ База данных сохранена. Размер: $DB_SIZE, таблиц: $DB_TABLES"
else
    log "❌ Ошибка при создании дампа БД"
    send_telegram "❌ <b>Ошибка бэкапа WordPress</b>\nТип: Не удалось создать дамп БД\nПуть: $SITE_PATH\nПроверьте логи: $LOG_FILE"
    rm -rf "$TEMP_DIR"
    exit 1
fi

# 2. Копирование файлов сайта
log "Копирование файлов сайта..."
rsync -a --delete \
    --exclude='wp-content/cache' \
    --exclude='wp-content/uploads/cache' \
    --exclude='*.log' \
    --exclude='error_log' \
    --exclude='.git' \
    --exclude='node_modules' \
    "$SITE_PATH/" "$TEMP_DIR/files/" 2>> "$LOG_FILE"

if [ $? -eq 0 ]; then
    FILE_COUNT=$(find "$TEMP_DIR/files" -type f | wc -l)
    FILE_SIZE=$(du -sh "$TEMP_DIR/files" | cut -f1)
    log "✅ Файлы скопированы. Файлов: $FILE_COUNT, размер: $FILE_SIZE"
else
    log "❌ Ошибка при копировании файлов"
    send_telegram "❌ <b>Ошибка бэкапа WordPress</b>\nТип: Не удалось скопировать файлы\nПуть: $SITE_PATH"
    rm -rf "$TEMP_DIR"
    exit 1
fi

# 3. Создание архива
log "Создание архива..."
tar -czf "$BACKUP_ARCHIVE" -C "$TEMP_DIR" . 2>> "$LOG_FILE"

if [ $? -eq 0 ] && [ -f "$BACKUP_ARCHIVE" ]; then
    ARCHIVE_SIZE=$(du -h "$BACKUP_ARCHIVE" | cut -f1)
    log "✅ Архив создан: $BACKUP_ARCHIVE ($ARCHIVE_SIZE)"
else
    log "❌ Ошибка при создании архива"
    send_telegram "❌ <b>Ошибка бэкапа WordPress</b>\nТип: Не удалось создать архив"
    rm -rf "$TEMP_DIR"
    exit 1
fi

# 4. Подсчет времени выполнения
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))
DURATION_MIN=$((DURATION / 60))
DURATION_SEC=$((DURATION % 60))

# 5. Отправка отчета
log "Отправка отчета в Telegram..."

REPORT="✅ <b>Бэкап WordPress завершен</b>\n"
REPORT+="📅 Дата: $DATE\n"
REPORT+="🕐 Время: ${DURATION_MIN} мин ${DURATION_SEC} сек\n"
REPORT+="📦 Размер архива: $ARCHIVE_SIZE\n"
REPORT+="📁 Файлов: $FILE_COUNT (${FILE_SIZE})\n"
REPORT+="🗄️ База данных: $DB_SIZE (таблиц: $DB_TABLES)\n"
REPORT+="💾 Путь: $BACKUP_ARCHIVE"

send_telegram "$REPORT" "HTML"
log "✅ Отчет отправлен"

# 6. Очистка старых бэкапов
cleanup_old_backups

# 7. Удаление временных файлов
rm -rf "$TEMP_DIR"
log "✅ Временные файлы удалены"

# 8. Опционально: проверка целостности архива
if command -v tar &> /dev/null; then
    if tar -tzf "$BACKUP_ARCHIVE" &> /dev/null; then
        log "✅ Проверка целостности архива пройдена"
    else
        log "❌ Проверка целостности архива не пройдена"
        send_telegram "⚠️ <b>Внимание!</b>\nАрхив бэкапа поврежден: $BACKUP_ARCHIVE" "HTML" "${ERROR_CHAT_ID:-$CHAT_ID}"
    fi
fi

log "✅ Бэкап успешно завершен"
exit 0