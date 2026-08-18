---
name: grill-with-docs-ui
description: A relentless interview to sharpen a plan or design, which creates docs (ADRs and glossary) as it goes and asks each round's questions through a local Ask UI form instead of plain text. Run as /grill-with-docs-ui. Requires grilling, domain-modeling and ask-ui to be installed.
disable-model-invocation: true
---

# Grill with Docs (UI)

Run a grill-with-docs session in form mode: question generation and reasoning follow grilling, docs follow domain-modeling, and each round's questions are asked through an ask-ui local form. This skill defines only the coordination between the three.

**REQUIRED SUB-SKILLS:** grilling (design tree and frontier rounds), domain-modeling (CONTEXT.md glossary and ADRs), ask-ui (form rendering and session persistence).

If grilling or domain-modeling is missing, do not start this session. If ask-ui is missing or cannot start, degrade to plain text per Fallback below — the session itself continues.

## When to use the form

- The current frontier contains at least two independent decision questions the user can answer now → form.
- A round has only one independent question → ask it directly in the conversation.
- Fact-finding questions never go into the form: per grilling, dispatch a sub-agent to look up anything you can find out yourself; never ask the user for facts.

## Sessions and rounds

- One grilling session = one ask-ui Session: reuse the same `sessionId` throughout.
- One frontier round = one ask-ui Round: each follow-up round sets `basedOnRound` to the last processed round number.
- Submitted answers are immutable; corrections and confirmations go into a new round.

## Question mapping (grilling → QuestionSet)

| grilling question shape | form field |
|---|---|
| Either/or decision | `type: single`; recommended answer → `recommendedOptionIds` |
| Pick-several decision | `type: multiple`; recommended answers → `recommendedOptionIds`; `minSelections: 1`, `maxSelections` = number of options unless the question itself sets a lower cap |
| Open question | `type: text`; recommended answer → `recommendedDraft` |

Additional rules:

- Question ids are numbered sequentially across the whole session, zero-padded to at least 3 characters (`q001`, `q002`, `q003` in round 1; round 2 continues `q004`, `q005`, …) so ids never collide between rounds.
- Every id (question and option) must satisfy ask-ui's constraint: 3-128 safe characters — start with a letter or digit, then only letters, digits, `.`, `_`, `-`. Short ids like `q1` are rejected.
- Question title → `title`; question body and context → `description`; the reason behind the recommendation → `recommendationReason`.
- Decision questions set `allowOther: true` — the user may answer outside the offered options (returned as the reserved id `__other__` plus `customText`).
- Decision questions set `required: true`; a text question is `required: false` only when it is genuinely optional.
- `sessionTitle` is the grilled subject; `title` is "Round N".
- Read ask-ui's `references/schema.md` before composing the JSON; command usage, waiting behaviour and session continuity follow ask-ui.

## Answer parsing (AnswerSet → design tree)

- `selectedOptionIds` → the decision is settled; the frontier advances and unblocks downstream questions.
- `selectedOptionIds` contains `__other__`, or a choice answer carries non-empty `customText` without `__other__` (older answer format) → `customText` is the user's answer.
- For `text` questions, `customText` is the answer itself.
- `notes` → the user's correction or objection on that question; when it conflicts with the selected options, `notes` wins. As submitted answers are immutable, carry the corrected reading into the design tree and put a confirmation question in the next round.
- An answer that conflicts with existing glossary terms → challenge it immediately, per domain-modeling.

## Docs as you go

Follow domain-modeling — never batch:

- A term is resolved → update `CONTEXT.md` right away (glossary only, no implementation detail).
- A settled decision that is hard to reverse, surprising without context, and the result of a real trade-off → offer an ADR in the conversation.
- Doc updates happen after each round's answers are parsed and before the next frontier is computed. In a multi-context repo (`CONTEXT-MAP.md` present), domain-modeling governs which `CONTEXT.md` / `docs/adr/` gets the update.

domain-modeling's in-session behaviours — challenging term conflicts, sharpening fuzzy language, stress-testing with concrete scenarios, cross-referencing the code — happen in the conversation, exactly as in text-mode grill-with-docs; the form only replaces how frontier questions are asked.

## One round

1. Compute the frontier; dispatch sub-agents for fact-finding first and do not block the remaining decision questions on them.
2. Compose the QuestionSet per the mapping rules and write it to a temp file.
3. Run ask-ui's foreground `ask` command and wait for submission; do not end the Agent turn while it waits.
4. Parse the AnswerSet: settle decisions into the design tree and challenge conflicting answers on the spot.
5. Update `CONTEXT.md`; offer ADRs where the three criteria hold.
6. Recompute the frontier: if non-empty, return to step 1 with the same `sessionId`; if empty, continue.
7. 🔴 CHECKPOINT — Present the design-tree summary and ask the user to confirm a shared understanding, per grilling. If the user raises new doubts, keep the session open and ask another round. Only after the user confirms, run ask-ui's `complete` — then act.

## Fallback

| Situation | Handling |
|---|---|
| ask-ui cannot start (no node, bad JSON, no browser, …) | Work through ask-ui's troubleshooting table; final fallback is grilling's plain-text question format. The session and doc-writing continue unbroken. |
| ask-ui rejects the QuestionSet (an id or field fails validation) | Fix the offending field per ask-ui's `references/schema.md` — most often an id shorter than 3 characters or containing unsafe characters — and resubmit the same round; sessionId and round number stay unchanged. |
| A round falls back to detached `create` mode | Before switching, follow ask-ui's 🔴 rule and confirm the user understands the detached flow. Recover per ask-ui's resume path (its submission trigger phrases); prefer returning to foreground `ask` for later rounds. Run `complete` only after confirming no further rounds remain. |
| The user asks to switch to text mid-session | Switch to plain-text grilling; submitted rounds and written docs are kept. |

## Never

- Split one round's frontier across several chat messages — a round's questions go in one form round.
- Put fact-finding questions in the form — dispatch a sub-agent; the form carries decisions only.
- Batch `CONTEXT.md` / ADR updates to the end of the session.
- Overwrite submitted answers or amend them in an old round — corrections go in a new round.
- Reuse a `sessionId` across different grilling sessions.
- Use ids shorter than 3 characters or with unsafe characters (e.g. `q1`, `my question`) — ask-ui rejects the whole QuestionSet.
- Run `complete` before the user confirms a shared understanding — a completed session cannot take new rounds.
