# Missions — goals that queue themselves

A **Goals** page in the sidebar: file a goal prompt, choose how to run it —
a fresh **single session** that receives it, or a lead-led **team** whose
first task it is — and walk away. The queue paces the work, watches each
run to completion, and survives restarts. Upstream has no queue of goals:
this surface is the fork's.

[Русская версия](#русская-версия)

## How the queue works

- The executor paces the file: two lanes at a time by default, the rest
  queued.
- Each mission's turn is observed and marked completed when its session
  goes idle after being busy; the watch ends after an hour, so nothing
  wedges the queue.
- Retry, cancel or delete from the list; jump straight into the working
  session.
- State lives in `missions.json` and survives restarts; every state move
  broadcasts an event frame the page refetches on.

## Queue settings

A settings card on the Goals page rules the pace:

- **Concurrent goals** — 1 to 16, default two. Raising the limit starts
  queued goals on the same pass; lowering it only stops admissions —
  running goals are never cancelled.
- **Watch window** in minutes — 1 to 1440, default one hour. A new window
  arms watches started after the change; running watches keep theirs, so a
  turn finishing right now is not judged by a window it never had.
- A stored value outside the bounds falls back to the default instead of
  refusing to boot.

<img src="../references/fork/missions-form.jpg" width="60%" alt="New mission form: title, goal, single-session or team mode, project">

The server contract: `packages/web/server/lib/missions/DOCUMENTATION.md`.

---

# Русская версия

# Миссии — цели, которые встают в очередь сами

Страница **Цели** в сайдбаре: заведите промпт-цель, выберите, как выполнять —
новая **одиночная сессия**, которая его получает, или ведомая **команда**, для
которой это первая задача, — и уходите. Очередь задаёт темп, следит за каждым
прогоном до завершения и переживает рестарты. В апстриме очереди целей нет:
эта поверхность — работа форка.

[English](#missions--goals-that-queue-themselves)

## Как работает очередь

- Исполнитель задаёт темп: по умолчанию две полосы одновременно, остальное
  в очереди.
- Ход каждой миссии наблюдается и помечается завершённым, когда её сессия
  после занятости наступает простой; наблюдение кончается через час, так
  что ничего не клинит очередь.
- Повтор, отмена, удаление из списка; прыжок прямо в рабочую сессию.
- Состояние живёт в `missions.json` и переживает рестарты; каждый переход
  рассылает фрейм события, по которому страница перечитывается.

## Настройки очереди

Карточка настроек на странице «Цели» управляет темпом:

- **Одновременных целей** — от 1 до 16, по умолчанию две. Поднятие лимита
  стартует стоящие цели тем же проходом; опускание останавливает только
  приём — работающие цели никогда не отменяются.
- **Окно наблюдения** в минутах — от 1 до 1440, по умолчанию час. Новое
  окно взводит наблюдатели, стартовавшие после изменения; уже идущие
  сохраняют свои, так что ход, заканчивающийся прямо сейчас, не судится
  окном, которого у него никогда не было.
- Сохранённое значение вне границ откатывается к дефолту, а не отказывается
  грузиться.

<img src="../references/fork/missions-form.jpg" width="60%" alt="Форма новой миссии: заголовок, цель, режим сессии или команды, проект">

Серверный контракт: `packages/web/server/lib/missions/DOCUMENTATION.md`.
