#!/usr/bin/env python3
"""
Telegram-бот для ответов на вопросы по документации CRM.
Использует Notion API как базу знаний.
"""

import os
import logging
from dotenv import load_dotenv
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
import requests
from notion_client import Client

# Загрузка переменных окружения
load_dotenv()

# Настройка логирования
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# Конфигурация
TELEGRAM_TOKEN = os.getenv('TELEGRAM_TOKEN')
NOTION_TOKEN = os.getenv('NOTION_TOKEN')
NOTION_DATABASE_ID = os.getenv('NOTION_DATABASE_ID')

# Инициализация Notion клиента
notion = Client(auth=NOTION_TOKEN)

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик команды /start"""
    user = update.effective_user
    welcome_message = (
        f"👋 Привет, {user.first_name}!\n\n"
        "Я бот-помощник по документации CRM. "
        "Ты можешь задавать мне вопросы по работе с системой, "
        "а я буду искать ответы в базе знаний.\n\n"
        "Примеры вопросов:\n"
        "• Как создать сделку?\n"
        "• Где найти контакты клиента?\n"
        "• Как прикрепить файл?\n\n"
        "Просто напиши свой вопрос!"
    )
    await update.message.reply_text(welcome_message)

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик команды /help"""
    help_text = (
        "📚 Доступные команды:\n"
        "/start - Начать работу\n"
        "/help - Показать это сообщение\n"
        "/modules - Список обучающих модулей\n"
        "/progress - Мой прогресс\n\n"
        "Или просто задай вопрос обычным текстом."
    )
    await update.message.reply_text(help_text)

async def modules(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик команды /modules"""
    modules_text = (
        "📖 Обучающие модули:\n\n"
        "1. Введение в CRM\n"
        "2. Создание и ведение сделок\n"
        "3. Работа с контактами\n"
        "4. Отчеты и аналитика\n"
        "5. Интеграции\n\n"
        "Ссылка на полную документацию: https://notion.so/crm-docs"
    )
    await update.message.reply_text(modules_text)

async def search_in_notion(query: str) -> str:
    """Поиск ответа в Notion базе знаний"""
    try:
        # Поиск по базе данных Notion
        response = notion.databases.query(
            database_id=NOTION_DATABASE_ID,
            filter={
                "property": "Title",
                "rich_text": {
                    "contains": query
                }
            }
        )
        
        if response['results']:
            # Берем первый результат
            page = response['results'][0]
            title = page['properties']['Title']['title'][0]['plain_text']
            
            # Получаем содержимое страницы
            blocks = notion.blocks.children.list(page['id'])
            content = []
            for block in blocks['results']:
                if block['type'] == 'paragraph':
                    text = block['paragraph']['rich_text']
                    if text:
                        content.append(text[0]['plain_text'])
            
            if content:
                return f"📌 **{title}**\n\n" + "\n".join(content[:5]) + "\n\nПодробнее: https://notion.so/" + page['id'].replace('-', '')
        
        return None
    except Exception as e:
        logger.error(f"Notion API error: {e}")
        return None

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик текстовых сообщений (вопросов)"""
    query = update.message.text
    user = update.effective_user
    
    # Показываем, что бот печатает
    await context.bot.send_chat_action(chat_id=update.effective_chat.id, action="typing")
    
    # Ищем ответ в Notion
    answer = await search_in_notion(query)
    
    if answer:
        await update.message.reply_text(answer, parse_mode='Markdown')
    else:
        # Если не нашли, предлагаем альтернативы
        fallback_message = (
            "🤔 Не нашел точного ответа на твой вопрос.\n\n"
            "Попробуй:\n"
            "• Переформулировать вопрос\n"
            "• Посмотреть в документации: https://notion.so/crm-docs\n"
            "• Написать в поддержку: support@company.com\n\n"
            "Или задай другой вопрос!"
        )
        await update.message.reply_text(fallback_message)

async def error_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик ошибок"""
    logger.error(f"Update {update} caused error {context.error}")
    if update and update.message:
        await update.message.reply_text(
            "😔 Произошла ошибка. Попробуй позже или напиши в поддержку."
        )

def main():
    """Запуск бота"""
    if not TELEGRAM_TOKEN:
        logger.error("TELEGRAM_TOKEN not set!")
        return
    
    # Создание приложения
    app = Application.builder().token(TELEGRAM_TOKEN).build()
    
    # Регистрация обработчиков
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", help_command))
    app.add_handler(CommandHandler("modules", modules))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    
    # Обработчик ошибок
    app.add_error_handler(error_handler)
    
    # Запуск бота
    logger.info("Bot started")
    app.run_polling()

if __name__ == '__main__':
    main()