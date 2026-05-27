# My Focus — Backlog Issues Incorrectly Tracked Instead of Sprint Issues

**Prepared:** 2026-05-25
**Component:** Forge app (Jira Time Tracker — "My Focus" screen)
**Status:** Issue confirmed, fix proposed — awaiting approval to proceed
**Severity:** Medium (affects accuracy of tracked time; no data loss)

---

## 1. Summary (TL;DR)

The "My Focus" screen is meant to show each user's **active work** — sprint issues for
software projects, and open tickets for non-sprint projects (Jira Service Management /
service desk / business). In practice it is **also pulling in software-project backlog
items that have not been added to any sprint**. Once those backlog items appear in the
list, the desktop app starts matching activity and time against them — so time gets
logged to a backlog item instead of the sprint issue the user is actually working on.

We have traced this to a single limitation in the Jira query the app uses, confirmed the
behaviour against both our own code and Atlassian's official documentation, and have a
targeted, low-risk fix ready. **No database changes, no new permissions, and no user
re-consent are required.**

---

## 2. What users experience

- Opening "My Focus" / the assigned-time view shows issues that are **sitting in the
  backlog**, not in the current sprint.
- Desktop activity and tracked time get **attributed to those backlog issues** instead of
  the sprint issue the person is working on.
- This was reported from real usage: backlog issues were being tracked instead of the
  in-sprint issue. (Issues from Jira Service Management / customer service desk projects
  correctly need to appear, because those projects have no sprints — that part must be
  preserved.)

---

## 3. Why it happens (root cause)

The app asks Jira for issues using this filter:

```
(sprint in openSprints())  OR  (sprint is EMPTY AND resolution = EMPTY AND statusCategory != Done)
```

- The first half — `sprint in openSprints()` — correctly returns issues in the current
  open sprint.
- The second half — `sprint is EMPTY ...` — was added earlier so that **Jira Service
  Management / service desk / business** issues would appear, since those projects have
  **no sprint field** (their issues are always "sprint empty").

**The problem:** Jira's query language cannot tell the difference between these two cases,
because both look identical to it:

| Issue | Has sprints? | Looks "sprint empty"? | Should show in My Focus? |
|-------|--------------|------------------------|--------------------------|
| A service desk / JSM ticket | No (project has no sprints) | Yes | **Yes** |
| A software **backlog** item not yet in a sprint | Yes, but currently empty | Yes | **No** |

So the clause we added to capture service-desk tickets **also captures every
not-yet-sprinted software backlog item.** Those leak into the list, and from there the
desktop app treats them as valid targets for time matching.

This `sprint is EMPTY` behaviour is documented by Atlassian and is expected Jira
behaviour — it is not a Jira bug; it is a limitation of how we wrote the query.

---

## 4. The proposed fix

Instead of guessing "no sprint = include it," classify each project by its **type** first
(Jira reports every project as `software`, `service_desk`, or `business`), and build the
query accordingly:

```
(sprint in openSprints())
OR (project in (<list of service-desk / business projects only>) AND resolution = EMPTY AND statusCategory != Done)
```

Why this is reliable:

- **`sprint in openSprints()` only ever matches issues genuinely in an open sprint** — so
  software backlog items cannot slip in through this half.
- **The second half is restricted to an explicit list of non-sprint project keys** — a
  software project's key is never on that list, so its backlog items cannot slip in here
  either.
- **Net effect:** software projects contribute only their open-sprint issues; service
  desk / business projects contribute all their active, unresolved issues. Service-desk
  visibility is preserved; the backlog leak is closed.

The fix also fails safe: if there are no service-desk/business projects, or if the project
lookup fails, the query simply falls back to `(sprint in openSprints())` — no crash, no
broken screen.

---

## 5. Impact & expected outcome

| Project type | Before fix | After fix |
|--------------|------------|-----------|
| Software (Scrum) | Sprint issues **+ leaked backlog items** | Sprint issues only ✅ |
| Service Management / service desk | Shown | Shown (unchanged) ✅ |
| Business | Shown | Shown (unchanged) ✅ |
| Software backlog (not in a sprint) | Incorrectly shown & tracked | No longer shown ✅ |

Result: time is matched to the work people are actually doing, not to stale backlog items.

---

## 6. Known limitation (needs a decision)

**Kanban software projects.** A Kanban board is a *software* project that uses a board
instead of sprints. Under this fix it is treated as sprint-based, so its (sprint-less)
issues would **not** appear in My Focus. Supporting Kanban properly requires additional
Jira permissions and a one-time user re-consent, so it has been intentionally deferred.

> **Decision needed:** Do any teams track work on **Kanban software boards**? If yes, we
> should scope Kanban support as a follow-up. If no, this fix fully resolves the issue.

---

## 7. Risk, scope & rollback

- **Risk:** Low. The change is confined to how one query is built. No database schema
  changes, no new Jira permissions, and **no user re-consent** required.
- **Out of scope (unchanged on purpose):** the AI matching cache, and the "carryover"
  behaviour that keeps an issue visible if it already has real tracked/pending time.
- **Rollback:** Trivial — revert the query back to its previous single-line form. One-file
  change.

---

## 8. Validation plan

1. Software project: only open-sprint issues appear; a not-sprinted backlog item does
   **not** appear.
2. Every open-sprint issue assigned to the user still appears.
3. Service desk / business issues (unresolved, not done) still appear.
4. With no service-desk/business projects present, the query reduces to sprint-only and
   the screen still loads.
5. Automated tests are updated to lock in the new behaviour before the code change ships
   (per our standard spec-driven workflow).

---

## 9. Effort & next steps

- **Estimated effort:** Small — one query-building change plus a small project-type helper,
  with updated automated tests. Roughly half a day to a day including testing.
- **Awaiting:** Sign-off to proceed, and an answer on the Kanban question in Section 6.

---

*This document was verified end-to-end against the application source code and Atlassian's
official Jira REST/JQL documentation. No assumptions were made about the query behaviour;
it was confirmed in both places.*
