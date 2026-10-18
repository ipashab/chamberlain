# Bitbucket Data Center — pull requests, read whole

Connect your self-hosted **Bitbucket Data Center** with a PAT in settings.
Everything is read-only: the token stays on the server, and every call the
fork makes is a GET — the viewer observes, it never writes. Upstream speaks
to GitHub, GitLab and Linear; the Bitbucket DC surface is this fork's.

[Русская версия](#русская-версия)

## The pulls surface

One instance config — origin, token, ssl choice — on the settings'
integrations card. The panel grows a **pull requests surface**:

- Paste a pull URL or pick from the open list; search by id, title, author
  or repo. A recently-read section remembers where you were.
- A pull reads whole into tabs: **overview**, **comments** with replies,
  **commits**, **changes**.
- **Changes is an interactive diff**: line-number gutters, added and
  removed tint bands, hover, click-select. The ask button on a line
  attaches the file's ±12-line window as a draft quote — a context chip in
  the composer, sent only by your hand.
- **People carry their avatars**: the server proxies
  `/users/<slug>/avatar.png`, so real photos arrive while the token never
  leaves the server; a name-stable initials circle stands in whenever the
  photo cannot.
- The team task dialog reuses the reader: **View** on a task's Bitbucket
  pull opens the same body in a dialog.

The [analysis story](pull-analysis.md) — how a pull is judged, reading by
reading.

## The security shape

<img src="../references/fork/integrations-readonly-flow.svg" alt="Diagram: the browser talks only to the local Chamberlain server; the server holds the PAT and makes GETs to Bitbucket">

- The PAT is entered once in settings and lands in the server's config; the
  UI receives pages, never the token.
- Every route is a GET — activity, comments, diffs, avatars. There is no
  write path to the instance anywhere in the fork.
- The ssl choice accepts internal certificate arrangements without
  turning verification off globally.

---

# Русская версия

# Bitbucket Data Center — пул-реквесты, прочитанные целиком

Подключите свой **Bitbucket Data Center** с PAT в настройках. Всё только для
чтения: токен остаётся на сервере, и каждый вызов форка — это GET:
наблюдатель наблюдает и никогда не пишет. Апстрим говорит с GitHub, GitLab
и Linear; поверхность Bitbucket DC — работа этого форка.

[English](#bitbucket-data-center--pull-requests-read-whole)

## Поверхность пул-реквестов

Одна конфигурация инстанса — origin, токен, выбор ssl — на карточке
интеграций в настройках. Панель отращивает **поверхность пул-реквестов**:

- Вставьте URL пулла или выберите из списка открытых; ищите по id,
  заголовку, автору или репо. Секция «недавно читанные» помнит, где вы
  были.
- Пул читается целиком в табы: **обзор**, **комментарии** с ответами,
  **коммиты**, **изменения**.
- **«Изменения» — интерактивный дифф**: гуттеры с номерами строк, полосы
  подсветки добавленного и удалённого, ховер, выбор кликом. Кнопка
  «спросить» на строке прикладывает ±12-строковое окно файла как черновик
  цитаты — чип контекста в композере, отправляемый только вашей рукой.
- **Люди носят свои аватарки**: сервер проксирует
  `/users/<slug>/avatar.png`, так что приезжают настоящие фото, и токен не
  покидает сервер; когда фото взять нельзя, встаёт устойчивая к имени
  монограмма с инициалами.
- Диалог командной задачи переиспользует читалку: **Просмотр** на
  Bitbucket-пулле задачи открывает то же тело в диалоге.

Про то, как пул оценивают, чтение за чтением —
[статья об анализе](pull-analysis.md#русская-версия).

## Модель безопасности

<img src="../references/fork/integrations-readonly-flow.svg" alt="Схема: браузер говорит только с локальным сервером Chamberlain; сервер держит PAT и делает GET-ы в Bitbucket">

- PAT вводится один раз в настройках и оседает в конфиге сервера; интерфейс
  получает страницы, но не токен.
- Каждый роут — GET: активность, комментарии, диффы, аватары. Пути записи
  на инстанс в форке нет нигде.
- Выбор ssl принимает внутренние сертификатные договорённости, не выключая
  проверку глобально.
