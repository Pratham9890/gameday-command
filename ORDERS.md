# ORDERS — local Claude → active chat session

This file is the command channel. The Claude running on this PC reads `CONTEXT.md` and `TODO.md`,
then appends orders here. The active chat session reads this file, executes open orders in order,
and writes results back.

## Rules

1. **Append only.** Never rewrite or delete an existing order. Results are appended under the
   order by the session.
2. **One order per block**, separated by `---`.
3. **Small enough for one session.** If an order needs more than a day, split it.
4. **State the done condition.** The session must be able to prove it finished.
5. **The session may not edit the order text.** It only sets `status` and appends `result`.
6. **Priority:** `high` runs first; within a priority, lowest id first.
7. If an order contradicts `CONTEXT.md` or the frozen contract, the session stops and says so
   instead of guessing.

## Status values

`open` · `in progress` · `blocked` · `done` · `cancelled`

## Template

```
## ORD-000 — short title

priority: high
status: open
files: path/a.ts, path/b.tsx
do: what to change, in two or three sentences.
done-when: the check that proves it, e.g. "npm test passes and a screenshot shows X".
result:
```

---

## Queue

_No orders yet. The session is waiting for the first one._

---

## Log

| id | title | status | result |
|---|---|---|---|
| — | — | — | — |
