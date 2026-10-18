# Jira Data Center — tasks, healed and asked about

One more integrations card — origin, token, ssl choice — and the same
read-only promise: issue view, search and every page behind them is a GET,
the token never leaving the server. Upstream speaks to GitHub, GitLab and
Linear; the Jira DC surface is this fork's.

[Русская версия](#русская-версия)

## The issues surface

- Paste an issue URL or key, search the project, read one issue whole:
  **overview**, **description**, **comments** with replies, **history**,
  **links**, **attachments**.
- The instance's noise is healed: sprints show names, not Greenhopper
  serialization; Development answers dev-summary counts; rank keys stay
  hidden.
- The description renders the way Jira drew it — headings, lists, tables,
  code — purified to the tags a viewer may mount.
- **Ask** pins the issue to the composer as a context chip; issue keys
  typed in chat turn into chips themselves.
- The search field reads prefix words: `assignee:`, `reporter:`,
  `status:`, `project:` beside the plain text.

## The spec card

The issue body grows a **spec card**: a session reads the task and writes
the development spec — essence, a plan bound to your repository, testable
acceptance, open questions, out of scope — the card following the answer
live. The answering methodology is yours to edit; see
[the analysis article](pull-analysis.md).

## The security shape

<img src="../references/fork/integrations-readonly-flow.svg" alt="Diagram: the browser talks only to the local Chamberlain server; the server holds the PAT and makes GETs to Jira">

The token lands in the server's config on save and never travels to the
UI; every page behind the surface is a GET.

---

# Русская версия

# Jira Data Center — задачи, вылеченные и о которых спрашивают

Ещё одна карточка интеграций — origin, токен, выбор ssl — и то же обещание
read-only: просмотр, поиск и все страницы за ними — GET, токен не покидает
сервер. Апстрим говорит с GitHub, GitLab и Linear; поверхность Jira DC —
работа этого форка.

[English](#jira-data-center--tasks-healed-and-asked-about)

## Поверхность задач

- Вставьте URL или ключ задачи, поищите по проекту, прочитайте одну задачу
  целиком: **обзор**, **описание**, **комментарии** с ответами, **история**,
  **связи**, **вложения**.
- Шум инстанса вылечен: спринты показывают имена, а не сериализацию
  Greenhopper; Development показывает счётчики dev-summary; ключи
  ранжирования спрятаны.
- Описание рендерится так, как его нарисовала Jira — заголовки, списки,
  таблицы, код — очищенное до тегов, которые может смонтировать вьюер.
- **Спросить** пришпиливает задачу к композеру чипом контекста; ключи
  задач, напечатанные в чате, сами превращаются в чипы.
- Поле поиска понимает префиксные слова: `assignee:`, `reporter:`,
  `status:`, `project:` рядом с обычным текстом.

## Карточка спецификации

Тело задачи отращивает **карточку спецификации**: сессия читает задачу и
пишет спецификацию разработки — суть, план, привязанный к вашему
репозиторию, проверяемую приёмку, открытые вопросы, вне охвата — карточка
следует за ответом живьём. Методологию ответа можно править; см.
[статью об анализе](pull-analysis.md#русская-версия).

## Модель безопасности

<img src="../references/fork/integrations-readonly-flow.svg" alt="Схема: браузер говорит только с локальным сервером Chamberlain; сервер держит PAT и делает GET-ы в Jira">

Токен при сохранении оседает в конфиге сервера и никогда не уезжает в
интерфейс; каждая страница за поверхностью — GET.
