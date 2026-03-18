#!/bin/bash
# restore-example.sh - Пример скрипта для восстановления из бэкапа WordPress
# Внимание: Это пример! Перед использованием протестируйте на тестовом сервере.
# Версия: 1.0

set -e  # Выход при ошибке

# Цвета
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Функция помощи
show_help() {
    echo -e "${BLUE}Использование:${NC} $0 <путь_к_архиву.tar.gz> [директория_назначения]"
    echo
    echo "Параметры:"
    echo "  <путь_к_архиву.tar.gz>  - Полный путь к файлу бэкапа"
    echo "  [директория_назначения] - Куда восстанавливать (опционально)"
    echo
    echo "Примеры:"
    echo "  $0 /backups/wordpress/wp_backup_2024-01-15_030001.tar.gz"
    echo "  $0 /backups/wordpress/wp_backup_2024-01-15_030001.tar.gz /tmp/restore-test"
    echo
    echo "Восстановление включает:"
    echo "  1. Распаковку архива"
    echo "  2. Восстановление файлов сайта"
    echo "  3. Восстановление базы данных (опционально)"
    exit 0
}

# Проверка параметров
if [ "$1" == "-h" ] || [ "$1" == "--help" ]; then
    show_help
fi

if [ -z "$1" ]; then
    echo -e "${RED}❌ Ошибка: Укажите путь к архиву${NC}"
    show_help
fi

BACKUP_FILE="$1"
RESTORE_DIR="${2:-./restored_$(date +%Y%m%d_%H%M%S)}"

# Проверка существования файла
if [ ! -f "$BACKUP_FILE" ]; then
    echo -e "${RED}❌ Ошибка: Файл не найден: $BACKUP_FILE${NC}"
    exit 1
fi

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Восстановление WordPress из бэкапа${NC}"
echo -e "${BLUE}========================================${NC}"
echo "Архив: $BACKUP_FILE"
echo "Директория восстановления: $RESTORE_DIR"
echo

# Создание директории для восстановления
mkdir -p "$RESTORE_DIR"
echo -e "${GREEN}✅ Создана директория: $RESTORE_DIR${NC}"

# Распаковка архива
echo -e "\n${YELLOW}Распаковка архива...${NC}"
tar -xzf "$BACKUP_FILE" -C "$RESTORE_DIR"
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Архив распакован${NC}"
else
    echo -e "${RED}❌ Ошибка распаковки архива${NC}"
    exit 1
fi

# Проверка структуры
echo -e "\n${YELLOW}Проверка структуры бэкапа...${NC}"
if [ -d "$RESTORE_DIR/db" ] && [ -d "$RESTORE_DIR/files" ]; then
    echo -e "${GREEN}✅ Структура корректна (найдены папки db/ и files/)${NC}"
else
    echo -e "${RED}❌ Ошибка: Неверная структура бэкапа${NC}"
    echo "Ожидалось:"
    echo "  ./db/database.sql - дамп БД"
    echo "  ./files/ - файлы сайта"
    echo
    echo "Найдено:"
    ls -la "$RESTORE_DIR"
    exit 1
fi

# Информация о бэкапе
DB_SIZE=$(du -h "$RESTORE_DIR/db/database.sql" 2>/dev/null | cut -f1 || echo "N/A")
FILE_COUNT=$(find "$RESTORE_DIR/files" -type f 2>/dev/null | wc -l)
FILE_SIZE=$(du -sh "$RESTORE_DIR/files" 2>/dev/null | cut -f1 || echo "N/A")

echo -e "\n${BLUE}Информация о бэкапе:${NC}"
echo "  📦 Размер дампа БД: $DB_SIZE"
echo "  📁 Файлов сайта: $FILE_COUNT ($FILE_SIZE)"

# Запрос на восстановление БД
echo -e "\n${YELLOW}Восстановление базы данных${NC}"
read -p "Хотите восстановить базу данных? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    # Запрос параметров БД
    read -p "Хост БД [localhost]: " DB_HOST
    DB_HOST=${DB_HOST:-localhost}
    
    read -p "Порт БД [3306]: " DB_PORT
    DB_PORT=${DB_PORT:-3306}
    
    read -p "Имя базы данных: " DB_NAME
    if [ -z "$DB_NAME" ]; then
        echo -e "${RED}❌ Имя БД обязательно${NC}"
        exit 1
    fi
    
    read -p "Пользователь БД: " DB_USER
    if [ -z "$DB_USER" ]; then
        echo -e "${RED}❌ Пользователь БД обязателен${NC}"
        exit 1
    fi
    
    read -s -p "Пароль БД: " DB_PASS
    echo
    
    # Проверка подключения
    echo -e "\n${YELLOW}Проверка подключения к БД...${NC}"
    if mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" -e "USE $DB_NAME" 2>/dev/null; then
        echo -e "${GREEN}✅ Подключение успешно${NC}"
        
        # Создание бэкапа текущей БД перед восстановлением
        BACKUP_BEFORE_RESTORE="$RESTORE_DIR/db_before_restore_$(date +%Y%m%d_%H%M%S).sql"
        echo -e "\n${YELLOW}Создание бэкапа текущей БД перед восстановлением...${NC}"
        mysqldump -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" > "$BACKUP_BEFORE_RESTORE"
        echo -e "${GREEN}✅ Бэкап создан: $BACKUP_BEFORE_RESTORE${NC}"
        
        # Восстановление
        echo -e "\n${YELLOW}Восстановление базы данных...${NC}"
        mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" < "$RESTORE_DIR/db/database.sql"
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}✅ База данных восстановлена${NC}"
        else
            echo -e "${RED}❌ Ошибка восстановления БД${NC}"
            exit 1
        fi
    else
        echo -e "${RED}❌ Ошибка подключения к БД${NC}"
        echo "Проверьте параметры и права доступа"
    fi
else
    echo -e "${YELLOW}Восстановление БД пропущено${NC}"
fi

# Запрос на восстановление файлов
echo -e "\n${YELLOW}Восстановление файлов сайта${NC}"
read -p "Хотите восстановить файлы? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    read -p "Целевая директория для файлов [/var/www/wordpress]: " TARGET_DIR
    TARGET_DIR=${TARGET_DIR:-/var/www/wordpress}
    
    if [ ! -d "$TARGET_DIR" ]; then
        read -p "Директория $TARGET_DIR не существует. Создать? (y/N) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            mkdir -p "$TARGET_DIR"
        else
            echo -e "${RED}❌ Восстановление файлов отменено${NC}"
            exit 1
        fi
    fi
    
    # Создание бэкапа текущих файлов
    BACKUP_FILES_BEFORE="$RESTORE_DIR/files_before_restore_$(date +%Y%m%d_%H%M%S).tar.gz"
    echo -e "\n${YELLOW}Создание бэкапа текущих файлов...${NC}"
    tar -czf "$BACKUP_FILES_BEFORE" -C "$TARGET_DIR" . 2>/dev/null || true
    echo -e "${GREEN}✅ Бэкап создан: $BACKUP_FILES_BEFORE${NC}"
    
    # Копирование файлов
    echo -e "\n${YELLOW}Копирование файлов в $TARGET_DIR...${NC}"
    cp -rf "$RESTORE_DIR/files/"* "$TARGET_DIR/" 2>/dev/null || true
    echo -e "${GREEN}✅ Файлы восстановлены${NC}"
    
    # Проверка прав
    echo -e "\n${YELLOW}Проверка прав доступа...${NC}"
    if [ -f "$TARGET_DIR/wp-config.php" ]; then
        WEB_USER=$(ps aux | grep -E '[a]pache|[h]ttpd|www-data' | head -1 | awk '{print $1}' || echo "www-data")
        echo "Владелец веб-сервера предположительно: $WEB_USER"
        read -p "Изменить владельца файлов на $WEB_USER? (y/N) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            chown -R "$WEB_USER":"$WEB_USER" "$TARGET_DIR"
            echo -e "${GREEN}✅ Права изменены${NC}"
        fi
    fi
else
    echo -e "${YELLOW}Восстановление файлов пропущено${NC}"
fi

echo -e "\n${GREEN}✅ Восстановление завершено${NC}"
echo -e "${BLUE}========================================${NC}"
echo "Файлы восстановлены в: $RESTORE_DIR"
echo "Лог операции: $RESTORE_DIR/restore.log"
echo -e "${BLUE}========================================${NC}"

# Сохранение лога
{
    echo "=== Восстановление $(date) ==="
    echo "Архив: $BACKUP_FILE"
    echo "Директория: $RESTORE_DIR"
    echo "БД: ${DB_NAME:-не восстановлена}"
    echo "Файлы: ${TARGET_DIR:-не восстановлены}"
} > "$RESTORE_DIR/restore.log"

exit 0