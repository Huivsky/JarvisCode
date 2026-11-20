> **4.2.0-beta.2:** понятный обзор центра управления и единая настройка доступа. Полный доступ к ПК включается явно в «Центр управления → Доступ»; обычные команды больше не требуют точного правила на каждый вызов. Защитные ограничения сохранены. См. ACCESS-NOTES.ru.md. Отчёты о предыдущей сборке 4.2.0-beta.1 сохранены как исторические; текущие результаты — в BUILD-4.2.0-beta.2.txt рядом с EXE.

# 4.1.0-beta.1 — предварительная версия

Новые функции и ограничения: [FEATURE-STATUS.ru.md](FEATURE-STATUS.ru.md). Проверки: [TEST-REPORT.ru.md](TEST-REPORT.ru.md). Готовый Windows EXE в этом архиве не собран. Внешние провайдеры моделей не добавлены.

# Jarvis Code 4.0 — настольный клиент

Окно для агента из обычного чата Notion, который видит ПК пользователя и работает с ним (файлы, поиск, команды) — с подтверждениями по режимам доступа. Без Notion API, токенов и кредитов пространства: всё идёт через мост MCP. Интерфейс в стиле Claude Desktop / Claude Code. Что нового — в [CHANGELOG.md](CHANGELOG.md).

## Как устроено

- **Один exe** (Bun, `--compile`, GUI-подсистема без консоли). Внутри — локальный HTTP/WebSocket-сервер на `127.0.0.1` и встроенный интерфейс (React).
- **Окно** — Microsoft Edge (или Chrome) в режиме `--app` с отдельным профилем `%LOCALAPPDATA%\JarvisCode\WebView`: без вкладок и адресной строки. На панели задач — как отдельное приложение: свой AppUserModelID `JarvisCode.App` (как у ярлыков), имя «Jarvis Code» и свой значок, а не «Microsoft Edge». Закрыли окно — процесс завершается через ~4 с (если включён мост или запуск с `--background` — остаётся в трее).
- **Безопасность API**: случайный токен в адресе окна (`#t=…`), заголовок `x-nc-token`, проверка `Origin`, CSP, Markdown без сырого HTML.
- **Мост (MCP)**: `bridge.ts` — MCP Streamable HTTP (JSON-ответы, без сессий) на `127.0.0.1:8765/mcp/<ключ>` с инструментами `nc_*`; агент в самом Notion подключает его как Custom MCP server. Туннель (`tunnel.ts`): ngrok (скрытый процесс, переиспользует уже запущенный, authtoken/домен из настроек или ngrok.yml; если ngrok не найден — `ngrok-download.ts` скачивает официальный zip в `~/.notion-code/bin/`, проверяет CRC, подпись Authenticode и `ngrok version`), cloudflared или свой адрес. Самопроверка каждые 30 с: `GET <публичный адрес>/health` должен вернуть метку этого процесса (`INSTANCE_ID`); два провала подряд (ERR_NGROK_3200/8012, чужой сервер) → перезапуск своим ngrok, старый ngrok, держащий порт/домен моста, закрывается точечно (по PID его локального API). Первый вызов через туннель (`X-Forwarded-For`) отмечает мост «подключённым» (`bridge.connectedAt/connectedUrl`). Вызовы и подтверждения — в журнале моста (чат `bridge`).
- **Чат Notion в окне (пересылка)**: единственный способ работы. `inbox.ts` — очередь сообщений. Сообщение из окна ждёт, пока агент в обычном чате Notion вызовет `nc_inbox` (долгий опрос до 40–50 с), работает инструментами `nc_*` (их карточки и подтверждения — в этом же чате, режим и папка — чата) и отвечает `nc_reply {text, status, memory?}`. Агент «на связи», пока ждёт в `nc_inbox` или работает; без сообщений `listenIdleMin` минут → `STOP` (пауза). Запуск — кнопка «Запустить в Notion» (`/api/relay/start`: команда `START_PROMPT` с `nc_inbox {"start": true}` в буфер, без адреса моста). В заголовке каждого сообщения — уровень мышления (`effort=fast|normal|deep|max` + подсказка агенту); модель выбирается в самом чате Notion.
- **Чаты не привязаны к пространству** (`context.ts`): история и контекст хранятся на ПК. Агенту, впервые получающему чат (новая связь, другое пространство), передаются `<chat_memory>` (выжимка чата, `context/<id>/memory.md`), `<previous_conversation>` (последние ~24 тыс. символов) и `<work_so_far>`; старое — по `nc_history {query?, from?, limit?}`, выжимка — `nc_memory {text | append}` или `nc_reply.memory`. `context/<id>/chat.md` — зеркало переписки в Markdown.
- **Перенос чата** (`/api/import/prompt`, `/api/chats/import`): команда `IMPORT_PROMPT` вставляется в нужный чат Notion → агент вызывает `nc_import {messages, title, summary, import_id, part, parts}` (частями по ~30 сообщений) → чат с перенесённой перепиской и памятью появляется в окне и сразу открывается. Или текст / файл `.md`/`.txt` («Вы:» / «Notion AI:», «## User» / «## Assistant»; иначе весь текст — контекст нового чата).
- **Хранилище** (`storage.ts`, `paths.ts`): `chats/`, `context/`, `uploads/`, `screenshots/`, `history/` — в папке `config.storageDir` (по умолчанию — папка данных). Перенос на лету: `/api/storage/move {dir, mode: "move" | "use"}` — `rename` или копирование с проверкой места, пути в чатах и контексте переписываются, хранилище переключается без перезапуска; `use` — открыть уже существующее хранилище (другой ПК, переустановка). Недоступная папка (отключён диск) → временно папка данных и предупреждение в окне.
- **Рабочий стол** (`desktop.ts`): снимок экрана (System.Drawing, с учётом масштаба), буфер обмена (Windows Forms, STA), Корзина (`SHFileOperation` с `FOF_ALLOWUNDO`, только локальные диски), распознавание текста (WinRT `Windows.Media.Ocr`) — всё через встроенный PowerShell 5.1. Экран и буфер — разрешение `observe` (вопрос в любом режиме), корзина — `delete`.
- **Свои команды** (`commands.ts`): `.jarvis/commands/*.md`, `.claude/commands/*.md` (проект) и `~/.notion-code/commands/*.md` (личные); `description:` во frontmatter, `$ARGUMENTS`; текст команды подставляется на сервере (`<command name="/x">`), в ленте — то, что набрал пользователь.
- **Трей и автозапуск**: `tray.ts` (NotifyIcon через скрытый PowerShell), `HKCU\…\Run` → `JarvisCode.exe --background`; ярлык «Notion (с мостом)» → `--notion`. Старые .bat/.vbs моста находятся и отключаются (`win.ts`).
- **Данные**: `~/.notion-code/` (папка данных прежнего Notion Code — сохранена для совместимости) — `config.json` (старые поля API — токены, аккаунты, агенты — удаляются при первом запуске 4.0; authtoken ngrok — DPAPI), `audit.log`, `app.log`, `commands/` (личные «/»-команды), `updates/`, `crashes/`; хранилище (см. выше) — `chats/*.json`, `context/` (память и зеркало чатов), `history/` (копии файлов до правок, 14 дней), `uploads/` (вставленные файлы), `screenshots/` (снимки экрана и картинки из буфера, 14 дней).
- **Обновления** (`updater.ts`): источник — из настроек, иначе вшитый при сборке (`JC_UPDATE_REPO` / `JC_UPDATE_URL`); `update.repo` (последний релиз GitHub: `*Setup*.exe` + SHA-256 из digest ассета, `latest.json` или `SHA256SUMS.txt`) или `update.manifestUrl` (`{version, url, sha256, notes, size}`, url может быть относительным). Проверка через 20 с после запуска и раз в 6 ч, загрузка в `updates/` с проверкой хеша, установка по кнопке: новый exe запускается как `JarvisCodeSetup.exe update --dir … --pid …`, ждёт выхода старой версии, заменяет `JarvisCode.exe` (со страховочной копией) и запускает приложение снова. Если установленная версия подписана, у обновления должна быть та же подпись.
- **Сбои** (`crash.ts`): `uncaughtException`/`unhandledRejection` → `crashes/*.json` без токенов, ключа моста, имени пользователя, путей профиля и чатов; подсказка в окне при следующем запуске; отправка (`crash.endpoint`, POST JSON) — по кнопке или автоматически с согласия.
- **Установщик** — тот же exe с именем `*Setup*.exe`: копирование в `%LOCALAPPDATA%\Programs\JarvisCode`, ярлыки, `jarvis` в PATH, запись в «Приложения», удаление консольной версии. Удаление: `JarvisCode.exe uninstall [--quiet]`.

```
src/   main.ts (запуск, одна копия), server.ts (API + WS), engine.ts (чаты, пересылка, перенос),
       inbox.ts (очередь для агента в Notion), context.ts (память и история чатов),
       storage.ts (хранилище и его перенос), relay.ts (статусы, защита текста),
       tools.ts (инструменты ПК), permissions.ts, chats.ts, installer.ts,
       win.ts (PowerShell, диалоги, окно, автозапуск),
       bridge.ts (MCP-сервер), tunnel.ts (ngrok/cloudflared), tray.ts (значок в трее),
       secrets.ts (маскирование, DPAPI), textfile.ts (кодировки, атомарная запись, копии до правок),
       updater.ts (обновления), crash.ts (отчёты о сбоях), desktop.ts (снимок экрана, буфер обмена,
       корзина, OCR Windows), commands.ts (свои «/»-команды), mentions.ts (@-упоминания файлов),
       export.ts (чат → Markdown)
ui/    App.tsx (панель, главный экран), Chat.tsx (сообщения, шаги, разрешения, план),
       Composer.tsx (ввод, вложения, «/»-команды, мышление), Import.tsx (перенос чата),
       Settings.tsx (настройки, хранилище, поиск, папки), Bridge.tsx (мост), Installer.tsx,
       icons.tsx (иконки и знак), css/*.css
test/  smoke.ts (сквозной тест с поддельным агентом в чате Notion через MCP), context.ts,
       security.ts, files.ts, update.ts,
       desktop.ts (экран, буфер, корзина — разрешения), commands.ts, preview.ts + shots.mjs (скриншоты)
```

## Команды

```bash
bun install
bun run typecheck          # tsc
bun run test               # сборка интерфейса + все тесты (smoke, context, security, files, update, desktop, commands)
bun run dev                # сервер без окна на http://127.0.0.1:47821 (ссылка с токеном — в консоли)
bun run build:exe          # dist/JarvisCode.exe и dist/JarvisCodeSetup.exe (Windows x64, можно собирать на Linux)
bun run release            # + release/: JarvisCodeSetup.exe/.zip, latest.json, SHA256SUMS.txt, исходники
```

Переменные для отладки: `JARVIS_CODE_HOME` или `NOTION_CODE_HOME` (папка данных), `NC_GITHUB_API` (адрес API GitHub для обновлений), `NC_BROWSER` (путь к браузеру для окна), `NC_CONSOLE=1` (лог в консоль в собранном exe).

Подпись exe при сборке (необязательно): `JC_SIGN_CERT=cert.pfx JC_SIGN_PASS=…` — signtool в Windows или osslsigncode в Linux/macOS; `JC_SIGN_CMD="… {file}"` — своя команда (Azure Trusted Signing, HSM); `JC_SIGN_TIMESTAMP` — сервер меток времени; `JC_SIGN_REQUIRED=1` — остановить сборку, если подписать не удалось.

Источник обновлений «из коробки» (необязательно): `JC_UPDATE_REPO=owner/repo` (GitHub Releases) или `JC_UPDATE_URL=https://…/latest.json` — вшивается в exe, и установленные копии сами находят новые версии без настройки. Источник, указанный пользователем в настройках, важнее.

### Выпуск обновления

1. Поднимите версию в `src/version.ts` и `package.json`, допишите раздел в `CHANGELOG.md` (попадёт в заметки к обновлению).
2. `JC_UPDATE_REPO=owner/repo bun run release` (с подписью — см. выше).
3. Загрузите `release/JarvisCodeSetup.exe`, `latest.json` и `SHA256SUMS.txt` в релиз GitHub (тег `v4.x.y`) или на свой HTTPS-сервер.
4. Копии, собранные без `JC_UPDATE_REPO`, настраиваются вручную: Настройки → О программе → «Источник обновлений…» — `owner/repo` или адрес `latest.json`.

## Дизайн 3.x–4.x

- Стили — модули `ui/css/*.css`, собираются по порядку имён: `00-fonts` (Inter, Source Serif 4, JetBrains Mono — OFL, `assets/fonts`, встраиваются в CSS), `01-tokens` (палитра тёмной/светлой темы, акценты `data-accent`: ember, arc, jade, violet, graphite; радиусы, тени, кривые движения), `02-controls` (кнопки, поля, меню, окна, уведомления, анимации знака), `03-layout` (панель, главный экран), `04-chat` (сообщения, шаги, разрешения, код, таблицы), `05-composer` (поле ввода, вложения, «/»-команды), `06-screens` (настройки, установщик, мост), `07-v4` (мышление, перенос чатов, хранилище).
- Знак «Кольцо света» — `Spark`/`Brand` в `ui/icons.tsx` (кольцо со вспышкой на краю; `intro` — прорисовка при запуске, `spin` — блик бежит по кольцу, пока агент думает; цвета — переменные `--mk-*` в `01-tokens.css` для каждого акцента и темы). Геометрия и цвета для картинок — `scripts/art/ring.mjs`; иконка приложения и обложка — `node scripts/art/render.mjs [папка]` (`scripts/art/logo.mjs` → `assets/icon.ico`, `icon-128/256.png`; `scripts/art/cover.html` → обложка 1920×1080); лист-пример — `scripts/art/ring-sheet.mjs`, видео анимации — `scripts/art/ring-motion.mjs`.
- Движение: кривые `--ease`/`--ease-out`, длительности `--t-fast`/`--t`/`--t-slow`; при «уменьшении движения» в Windows анимации отключаются.
- Переход с Notion Code: установщик находит прежнюю установку (`Uninstall\NotionCode`), останавливает её, удаляет старые exe, ярлыки, автозапуск, PATH и запись в «Приложениях»; данные `~/.notion-code` остаются общими.
