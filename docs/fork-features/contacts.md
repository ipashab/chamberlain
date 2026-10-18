# Contacts — assistants you keep like people

A **Contacts** page beside Goals: save an assistant as a persona — a name,
what it does, the prompt that defines it, optionally a model and an agent.
Upstream has no saved personas; each contact is one click away in the
sidebar of this fork.

[Русская версия](#русская-версия)

## One chat, and it stays one

Each contact keeps one chat. Open the contact and the same thread continues.
If the thread was deleted, the contact starts a fresh one seeded with its
persona: the prompt rides as the first message, so the model answers as the
saved role from the very first reply. You keep a reviewer or a planner the
way you keep a person: same face, same manner, every time.

<p>
<img src="../references/fork/contacts.jpg" width="45%" alt="Contacts page with saved assistant cards">
<img src="../references/fork/contacts-form.jpg" width="45%" alt="New contact form: name, description, prompt, model and agent">
</p>

## Under the hood

- Five routes under `/api/openchamber/assistants`; the store lives beside
  the team and mission files.
- Every write broadcasts an `openchamber:assistant-*` frame; open pages
  refetch on it.
- Address-book cards with identity colors, an inline create/edit form.

The contract: `packages/web/server/lib/assistants/DOCUMENTATION.md`.

---

# Русская версия

# Контакты — ассистенты, которых держат как людей

Страница **Контакты** рядом с «Целями»: сохраните ассистента как персонажа —
имя, чем занимается, промпт, который его определяет, при желании модель и
агента. В апстриме сохранённых персон нет; каждый контакт — в один клик из
сайдбара этого форка.

[English](#contacts--assistants-you-keep-like-people)

## Один чат, и он остаётся одним

У каждого контакта один чат. Открываете контакт — продолжается та же нить.
Если нить удалили, контакт заводит новую, засеянную его персоной: промпт
едет первым сообщением, так что модель отвечает в сохранённой роли с самого
первого ответа. Ревьюер или планировщик у вас — как человек: то же лицо, те
же манеры, каждый раз.

## Что под капотом

- Пять роутов под `/api/openchamber/assistants`; стор живёт рядом с файлами
  команды и миссий.
- Каждая запись рассылает фрейм `openchamber:assistant-*`; открытые страницы
  перечитываются по нему.
- Карточки адресной книги с цветами-идентичностями, инлайн-форма создания и
  правки.

Контракт: `packages/web/server/lib/assistants/DOCUMENTATION.md`.
