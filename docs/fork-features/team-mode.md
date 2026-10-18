# Team Mode — run a team of agents, watch it from one panel

Team Mode turns sessions into a staffed team: a **lead** you chat with, plus
teammates that each own a role. The lead decomposes work onto a shared board,
teammates pick tasks up and report back, and every move stays visible from
the chat you already know. Upstream OpenChamber has no team surfaces at all:
the roster, the board, the mailbox and the team tool below are this fork's
work.

[Русская версия](#русская-версия)

## Create a team in one dialog

Start from a **preset** — built-in lineups (an engineering crew, analysts, a
duo) or your own saved rosters — or compose an empty team. Every member gets
a name, a role brief, an agent, a model, and optional skills and MCP servers.
Exactly one member is the lead. The optional first task is delegated by the
lead as soon as the team starts.

<p>
<img src="../references/fork/team-create-presets.jpg" width="45%" alt="New team dialog with built-in and saved presets">
<img src="../references/fork/team-create-editor.jpg" width="60%" alt="Team editor: members with roles, agents, models, skills and MCP servers">
</p>

Presets travel: export one (or a folder of them) as JSON, import elsewhere;
per-instance fields are stripped and failures are reported without
overwriting anything. A **live** team exports as a recipe in one click —
the same JSON the lead's own `team.export_preset` action produces.

## The roster, alive

The work-status panel grows a **Team** section: every member with its live
state (starting, busy, idle, failed) and a stable identity color shared by
the roster, the board and the activity feed. Colors come from the theme's
`syntax.*` tokens, are pinned per slot in localStorage, and rosters never
recolor on membership changes.

The roster of a *running* team can be edited: members are added through the
same spawn path the lead's tool uses and stopped with the same approval
handshake, so the app cannot walk around the tool gating. Members group
into **sub-teams** (analytics, development, review, QA), each with its own
lead who aggregates the domain's reports and passes one summary up.

<img src="../references/fork/team-roster.jpg" alt="Work-status panel with the live team roster">

## The shared task board

One board for the whole team — tasks with subject, brief, owner and
blocked-by chain, grouped **by status, by teammate, or by sub-team**. File a
task yourself with quick-add, or straight from a chat selection with the
**Team task** action: the selection's first line becomes the subject, the
rest rides as the brief. The board is read-only for you and the app — its
state belongs to the team's agents.

A task with a `prUrl` answers for its pull request: draft or open,
mergeability and the CI verdict, refreshed from GitHub through a 60-second
cache. A click opens the whole task: brief, owner, blockers, and the
receipt (below).

<p>
<img src="../references/fork/team-board.jpg" width="45%" alt="Team board with task columns and member chips">
<img src="../references/fork/task-details.jpg" width="45%" alt="Task details: owner, brief and pull-request link">
</p>

## Completed tasks must show evidence

An agent completing a team task attaches proof: a **result** — the
conclusion the user should read, not a log — or a linked pull request.
Without either, completion is rejected with a readable reason and the task
stays untouched. A closed task on the board is a guarantee that something
backs it.

Task **deadlines** ride along: `deadlineMinutes` on create or update, zero
clears, a week is the cap. The clock runs only while the task is in
progress — waiting in the queue burns nothing. A breach notifies the team
lead exactly once and the task stays open: a deadline is news, not a
verdict. Everything persists in `teams.json` across restarts.

## The Chats and Activity faces

The team tab grows parallel read-only chat columns, one per member, in roster
order — identity hue and live status in each header, click-to-open the full
chat. The **Activity** face is one shared, paged feed of the team's moves,
with per-member colors. The Board | Chats | Activity choice is remembered
per team.

## The team tool the lead drives

The lead works through `openchamber_team`: sub-teams, task PR links and
results, spawn/interrupt/shutdown with an approval handshake, task evidence
and deadlines. Every write is a permission-gated agent action; app routes
only do what you yourself could do at that moment. The server contract is
documented in `packages/web/server/lib/team/DOCUMENTATION.md`.

---

# Русская версия

# Режим команды — команда агентов под присмотром одной панели

Режим команды превращает сессии в укомплектованную команду: **ведущий**, с
которым вы переписываетесь, и сослуживцы, каждый со своей ролью. Ведущий
раскладывает работу на общую доску, сослуживцы разбирают задачи и
отчитываются, и каждый шаг виден из привычного вам чата. В апстрим-версии
OpenChamber командных поверхностей нет вообще: ростер, доска, почтовый ящик
и командный инструмент ниже — работа этого форка.

[English](#team-mode--run-a-team-of-agents-watch-it-from-one-panel)

## Команда в одном диалоге

Начните с **пресета** — встроенных составов (инженерная бригада, аналитики,
дуэт) или своих сохранённых ростеров — или соберите пустую команду. Каждый
участник получает имя, бриф роли, агента, модель и, по желанию, скиллы и
MCP-серверы. Ведущий ровно один. Первая задача, если задана, делегируется
ведущим сразу после старта команды.

Пресеты переезжают: экспорт одного (или папки пресетов) в JSON, импорт где
угодно; поля конкретного инстанса вычищаются, ошибки импорта отчечаются без
порчи существующего. **Живая** команда экспортируется рецептом в один клик —
тот же JSON, что даёт действие `team.export_preset` самого ведущего.

## Живой ростер

Панель рабочего состояния отращивает секцию **Команда**: каждый участник с
живым состоянием (стартует, занят, простаивает, упал) и устойчивым
цветом-идентичностью, общим для ростера, доски и ленты активности. Цвета
берутся из токенов `syntax.*` темы, закрепляются по слоту в localStorage, и
ростер никогда не перекрашивается при смене состава.

Ростер **работающей** команды можно править: участники добавляются тем же
путём спавна, которым пользуется инструмент ведущего, и останавливаются с
тем же рукопожатием подтверждения — приложение не может обойти гейтинг
инструмента. Участники группируются в **подкоманды** (аналитика,
разработка, ревью, QA); у каждой свой ведущий, который собирает отчёты
домена и передаёт наверх одну выжимку.

## Общая доска задач

Одна доска на всю команду — задачи с темой, брифом, владельцем и цепочкой
блокировок, сгруппированные **по статусу, по участнику или по подкоманде**.
Завести задачу можно быстрым добавлением или прямо из выделения в чате
действием **Задача команде**: первая строка выделения становится темой,
остаток едет брифом. Доска для вас и для приложения только для чтения — её
состояние принадлежит агентам команды.

Задача с `prUrl` сама отвечает за свой пул-реквест: черновик или открыт,
вливаемость и вердикт CI, освежается с GitHub через 60-секундный кеш. Клик
открывает задачу целиком: бриф, владелец, блокировки и чек (ниже).

## Завершённые задачи обязаны предъявить доказательства

Агент, завершающий командную задачу, прикладывает подтверждение:
**результат** — вывод, который должен прочитать пользователь, а не лог —
или ссылку на пул-реквест. Без того или другого завершение отклоняется с
читаемой причиной, задача остаётся как была. Закрытая задача на доске —
гарантия, что за ней что-то стоит.

У задач есть **дедлайны**: `deadlineMinutes` при создании и обновлении, ноль
снимает, потолок — неделя. Часы идут, только пока задача в работе: ожидание
в очереди ничего не жжёт. Нарушение уведомляет ведущего команды ровно один
раз, задача остаётся открытой: дедлайн — новость, а не приговор. Всё
хранится в `teams.json` между рестартами.

## Грани «Чаты» и «Активность»

Командный таб отращивает параллельные колонки только для чтения, по одной на
участника, в порядке ростера — цвет-идентичность и живой статус в каждой
шапке, клик открывает полный чат. Грань **Активность** — одна общая
постраничная лента жизни команды, с цветами участников. Выбор
Доска | Чаты | Активность запоминается на каждую команду.

## Инструмент, которым управляет ведущий

Ведущий работает через `openchamber_team`: подкоманды, ссылки на PR и
результаты на задачах, спавн/прерывание/выключение с рукопожатием
подтверждения, свидетельства и дедлайны. Каждая запись — действие агента под
гейтингом прав; роуты приложения делают только то, что вы сами могли бы
сделать в этот момент. Серверный контракт документирован в
`packages/web/server/lib/team/DOCUMENTATION.md`.
