# 1. Скопировать скрипт
sudo cp scripts/backup-wordpress.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/backup-wordpress.sh

# 2. Создать конфиг
sudo mkdir -p /etc/wordpress-backup
sudo cp config/backup-config.env.example /etc/wordpress-backup/config.env
sudo nano /etc/wordpress-backup/config.env

# 3. Создать папку для бэкапов
sudo mkdir -p /backups/wordpress

# 4. Добавить в cron
sudo cp docs/cron-setup.md /etc/cron.d/wordpress-backup
# или вручную: crontab -e
# 0 3 * * * /usr/local/bin/backup-wordpress.sh