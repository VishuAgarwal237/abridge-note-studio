# Abridge — Note Studio

An internal tool for a non-technical teammate to turn an incoming patient-visit
**transcript** into a structured, reviewed **note** using a chosen **note type**.

```
Transcript  ─►  Note Type (versioned template)  ─►  Structured draft note
```

## Run it

Requires: Postgres running locally, `python3`, and `bun`.

```bash
./bin/serve
```

Then open **http://localhost:5173**.

`bin/serve` creates the `abridge` database if needed, installs backend + frontend
deps, and starts both. Ports are configurable: `BACKEND_PORT` (default 8000),
`FRONTEND_PORT` (default 5173). The frontend proxies `/api` to the backend.

> If port 8000 is taken locally, run e.g. `BACKEND_PORT=8010 ./bin/serve`.

## What it does (the core, working end to end)

- **See available note types** — seeded with *Visit Summary* and *Referral Letter*.
- **Pick a transcript** (3 realistic ones are seeded) and **a note type**, then
  **generate** a stubbed structured draft.
- **Add a new note type through the UI**, stored as data — no code change.

## Where I spent the design budget

We agreed to prioritise the **unreliable generation** and **trust** problems.
Both fall out of two decisions in the data model rather than special-casing.

### 1. Unreliable generation → an explicit state machine + validation
The stubbed generator is deliberately flaky: it is slow, ~15% times out, and
~15% returns malformed output (a dropped required section). A note is never a
blob with a spinner — it moves through explicit states:

```
queued → running → succeeded | timed_out | invalid_output | failed
```

The UI polls and shows the live status, and offers **Retry** on any failure.
Crucially, generated output is **validated against the note type's structure**
before a clinician sees it — a dropped required section surfaces as
`invalid_output`, not as a silently broken note.

### 2. Trust & template evolution → versioned, immutable note types
- A note type is a list of **structured sections** (`{key, title, required}`)
  stored as JSONB — not a template string. Validation and rendering are
  mechanical, avoiding "string soup".
- Every edit creates a **new immutable version**. A version is `draft` or
  `published`, and **only published versions can generate** (the trust
  guardrail). Editing a published template **forks a new draft** rather than
  mutating it.
- Every generated note **pins the exact `note_type_version_id`** it used, so a
  later edit — even a bad one — can never rewrite or break an existing note.
  Old notes stay reproducible under the template they were made with.

## Data model (4 tables)

| table                | purpose |
|----------------------|---------|
| `note_types`         | named templates |
| `note_type_versions` | immutable versions: `sections` (JSONB), `status` (draft/published), author — the versioning + trust backbone |
| `transcripts`        | incoming from the "recording pipeline" |
| `notes`              | generated notes with the status state machine; pins the note-type version used |

## Stack

- **Backend** — Python / FastAPI + Postgres (`backend/main.py`). Generation runs
  in a background thread and writes status back to the DB.
- **Frontend** — React served/bundled by a small Bun server (`frontend/`),
  proxying `/api` to the backend.

## Not built (deliberately), and what I'd do next

- **Volume (200 transcripts at once):** the async-job model already *is* the
  shape of the answer — a batch is just many queued jobs. Next steps would be a
  real worker queue with a concurrency cap + backpressure, pagination on list
  endpoints, and a batch-generate endpoint. Not built here to keep scope tight.
