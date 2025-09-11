# Mood Tracker

Простой муд‑трекер с сеткой как у GitHub (каждый день — плитка).

## Стек
- Backend: Express + mysql2
- Frontend: HTML + Bootstrap + чистый JS

## Быстрый старт
1. Создайте базу данных MySQL (пример: `mood_tracker`).
2. Установите переменные окружения (или создайте `.env`):
```
PORT=3000
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=mood_tracker
```
3. Установка и запуск:
```
npm install
npm run dev
```
Откройте `http://localhost:3000`.

## API
- GET `/api/moods?from=YYYY-MM-DD&to=YYYY-MM-DD` — получить настроения по диапазону дат.
- POST `/api/moods` `{ date: 'YYYY-MM-DD', mood: 1..5 }` — сохранить/обновить настроение.

Таблица `moods` создаётся автоматически при старте.
