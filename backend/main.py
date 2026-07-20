"""
Abridge — internal note-generation tool (backend).

Flow:  Transcript  ->  Note Type (versioned)  ->  generate a STRUCTURED draft note.

Design notes (why it looks like this):
  * We are prioritising two of the "deeper problems":
      1. Unreliable generation  -> `notes.status` is an explicit state machine
         (queued -> running -> succeeded | timed_out | invalid_output | failed).
         The stub generator simulates slowness, timeouts and malformed output,
         and we VALIDATE the output against the template's structure before we
         ever show it to a clinician.
      2. Trust / template evolution -> note types are VERSIONED and immutable.
         A version is draft or published; only PUBLISHED versions can generate.
         Every generated note pins the exact `note_type_version_id` it used, so
         editing a template never rewrites or breaks an existing note.

  * Templates are STRUCTURED (a list of typed sections stored as JSONB), not
    free-text blobs, so validation and rendering are mechanical, not string soup.

Four tables only: note_types, note_type_versions, transcripts, notes.
"""

import json
import os
import random
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone

import psycopg2
import psycopg2.extras
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

DB_DSN = os.environ.get("DATABASE_URL", "dbname=abridge")

app = FastAPI(title="Abridge Note Tool")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# DB helpers
# --------------------------------------------------------------------------- #
@contextmanager
def db():
    conn = psycopg2.connect(DB_DSN)
    conn.autocommit = True
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        yield cur
        cur.close()
    finally:
        conn.close()


def now():
    return datetime.now(timezone.utc)


SCHEMA = """
CREATE TABLE IF NOT EXISTS note_types (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS note_type_versions (
    id            SERIAL PRIMARY KEY,
    note_type_id  INTEGER NOT NULL REFERENCES note_types(id) ON DELETE CASCADE,
    version       INTEGER NOT NULL,
    -- sections: [{ "key": "hpi", "title": "History of Present Illness", "required": true }]
    sections      JSONB NOT NULL,
    status        TEXT NOT NULL DEFAULT 'draft',   -- draft | published
    created_by    TEXT NOT NULL DEFAULT 'unknown',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (note_type_id, version)
);

CREATE TABLE IF NOT EXISTS transcripts (
    id          SERIAL PRIMARY KEY,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notes (
    id                    SERIAL PRIMARY KEY,
    transcript_id         INTEGER NOT NULL REFERENCES transcripts(id),
    note_type_version_id  INTEGER NOT NULL REFERENCES note_type_versions(id),
    -- status: queued -> running -> succeeded -> approved
    --                            \-> timed_out | invalid_output | failed
    status                TEXT NOT NULL DEFAULT 'queued',
    -- content: { "hpi": "…", "assessment": "…" }  (keyed by section key)
    content               JSONB,
    error                 TEXT,
    -- clinician sign-off: the record of who trusted this note, and when.
    approved_by           TEXT,
    approved_at           TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migrations for DBs created before the approve step existed.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
"""


# --------------------------------------------------------------------------- #
# Seed data — two note types + a few realistic transcripts
# --------------------------------------------------------------------------- #
SEED_NOTE_TYPES = [
    {
        "name": "Visit Summary",
        "sections": [
            {"key": "chief_complaint", "title": "Chief Complaint", "required": True},
            {"key": "hpi", "title": "History of Present Illness", "required": True},
            {"key": "assessment", "title": "Assessment", "required": True},
            {"key": "plan", "title": "Plan", "required": True},
        ],
    },
    {
        "name": "Referral Letter",
        "sections": [
            {"key": "recipient", "title": "Referring To", "required": True},
            {"key": "reason", "title": "Reason for Referral", "required": True},
            {"key": "background", "title": "Clinical Background", "required": True},
            {"key": "request", "title": "Requested Action", "required": False},
        ],
    },
]

SEED_TRANSCRIPTS = [
    {
        "title": "Ms. Alvarez — persistent cough",
        "body": (
            "DR: Good morning, what brings you in today?\n"
            "PT: I've had this cough for about three weeks now, it just won't quit.\n"
            "DR: Any fever, or coughing anything up?\n"
            "PT: No fever. A little clear phlegm in the mornings. It's worse at night.\n"
            "DR: Any history of asthma or allergies?\n"
            "PT: Seasonal allergies, yeah. I started a new job in a warehouse last month.\n"
            "DR: Okay. Your lungs sound clear. This looks like a post-viral or "
            "irritant-related cough. Let's try an inhaler and see how you do over two weeks.\n"
            "PT: Sounds good.\n"
            "DR: If it's not better, we'll get a chest X-ray."
        ),
    },
    {
        "title": "Mr. Okafor — knee pain, ? orthopedics",
        "body": (
            "DR: How's the knee doing since last time?\n"
            "PT: Worse, honestly. Climbing stairs is rough and it swells by evening.\n"
            "DR: Any injury you remember?\n"
            "PT: I tweaked it playing soccer maybe two months ago.\n"
            "DR: There's some swelling and tenderness on the inner side. "
            "I'm concerned about a meniscus issue.\n"
            "PT: Do I need surgery?\n"
            "DR: Not necessarily. I'd like an MRI and an orthopedic opinion. "
            "I'll send a referral to Dr. Lin at Sports Ortho.\n"
            "PT: Okay, thank you."
        ),
    },
    {
        "title": "Mrs. Chen — diabetes follow-up",
        "body": (
            "DR: Your A1C came back at 8.1, up a little from last visit.\n"
            "PT: I've been slipping on the diet, I know.\n"
            "DR: Any symptoms — thirst, blurry vision, numbness in the feet?\n"
            "PT: A bit more thirsty lately. No numbness.\n"
            "DR: Let's increase the metformin to 1000mg twice daily and check "
            "your labs again in three months. I'll also refer you to nutrition.\n"
            "PT: I can do that."
        ),
    },
]


def seed():
    with db() as cur:
        cur.execute("SELECT count(*) AS n FROM note_types")
        if cur.fetchone()["n"] == 0:
            for nt in SEED_NOTE_TYPES:
                cur.execute(
                    "INSERT INTO note_types(name) VALUES (%s) RETURNING id",
                    (nt["name"],),
                )
                ntid = cur.fetchone()["id"]
                cur.execute(
                    """INSERT INTO note_type_versions
                       (note_type_id, version, sections, status, created_by)
                       VALUES (%s, 1, %s, 'published', 'seed')""",
                    (ntid, json.dumps(nt["sections"])),
                )
        cur.execute("SELECT count(*) AS n FROM transcripts")
        if cur.fetchone()["n"] == 0:
            for t in SEED_TRANSCRIPTS:
                cur.execute(
                    "INSERT INTO transcripts(title, body) VALUES (%s, %s)",
                    (t["title"], t["body"]),
                )


@app.on_event("startup")
def startup():
    with db() as cur:
        cur.execute(SCHEMA)
    seed()


# --------------------------------------------------------------------------- #
# The (stubbed) note generator — deliberately UNRELIABLE
# --------------------------------------------------------------------------- #
def _fake_section_text(section, transcript):
    """Produce plausible-looking stub text for one section from a transcript."""
    snippet = " ".join(transcript["body"].split()[:40])
    return (
        f"[{section['title']}] Draft generated from transcript "
        f"\"{transcript['title']}\".\n\n{snippet} …"
    )


def generate_note(note_id):
    """
    Runs in a background thread. Simulates a slow, flaky generator and writes
    the outcome back to the DB as an explicit status.
    """
    def set_status(status, content=None, error=None):
        with db() as cur:
            cur.execute(
                "UPDATE notes SET status=%s, content=%s, error=%s, updated_at=now() WHERE id=%s",
                (status, json.dumps(content) if content is not None else None, error, note_id),
            )

    set_status("running")

    # Load the note + its pinned version + transcript.
    with db() as cur:
        cur.execute(
            """SELECT n.id, v.sections, t.title, t.body
               FROM notes n
               JOIN note_type_versions v ON v.id = n.note_type_version_id
               JOIN transcripts t ON t.id = n.transcript_id
               WHERE n.id = %s""",
            (note_id,),
        )
        row = cur.fetchone()
    if not row:
        return
    sections = row["sections"]
    transcript = {"title": row["title"], "body": row["body"]}

    # 1) SLOW: seconds (a real generator can take minutes).
    time.sleep(random.uniform(1.0, 3.5))

    # 2) Roll the dice for the failure modes described in the brief.
    roll = random.random()
    if roll < 0.15:
        # Timeout — nothing usable comes back.
        set_status("timed_out", error="Generator did not respond in time. You can retry.")
        return
    if roll < 0.30:
        # Malformed output — the model dropped a required section / returned junk.
        content = {}
        for s in sections:
            if s.get("required") and random.random() < 0.6:
                continue  # drop a required section => should fail validation
            content[s["key"]] = "" if random.random() < 0.5 else _fake_section_text(s, transcript)
    else:
        # Happy path — well-formed content for every section.
        content = {s["key"]: _fake_section_text(s, transcript) for s in sections}

    # 3) VALIDATE against the template structure before trusting it.
    problems = validate_content(sections, content)
    if problems:
        set_status(
            "invalid_output",
            content=content,
            error="Output failed validation: " + "; ".join(problems),
        )
        return

    set_status("succeeded", content=content)


def validate_content(sections, content):
    """Return a list of human-readable problems; empty list == valid."""
    problems = []
    content = content or {}
    for s in sections:
        val = content.get(s["key"])
        if s.get("required") and (val is None or str(val).strip() == ""):
            problems.append(f"missing required section '{s['title']}'")
    return problems


def kick_generation(note_id):
    threading.Thread(target=generate_note, args=(note_id,), daemon=True).start()


# --------------------------------------------------------------------------- #
# API models
# --------------------------------------------------------------------------- #
class Section(BaseModel):
    key: str
    title: str
    required: bool = False


class NoteTypeIn(BaseModel):
    name: str
    sections: list[Section]
    created_by: str = "web-user"


class NewVersionIn(BaseModel):
    sections: list[Section]
    created_by: str = "web-user"


class TranscriptIn(BaseModel):
    title: str
    body: str


class GenerateIn(BaseModel):
    transcript_id: int
    note_type_version_id: int


class ApproveIn(BaseModel):
    approved_by: str = "web-user"


# --------------------------------------------------------------------------- #
# Note types  (list / create / new version / publish)
# --------------------------------------------------------------------------- #
@app.get("/api/note-types")
def list_note_types():
    with db() as cur:
        cur.execute(
            """SELECT nt.id, nt.name,
                      v.id AS version_id, v.version, v.status, v.sections,
                      v.created_by, v.created_at
               FROM note_types nt
               JOIN note_type_versions v ON v.note_type_id = nt.id
               ORDER BY nt.name, v.version"""
        )
        rows = cur.fetchall()
    by_type = {}
    for r in rows:
        t = by_type.setdefault(r["id"], {"id": r["id"], "name": r["name"], "versions": []})
        t["versions"].append(
            {
                "version_id": r["version_id"],
                "version": r["version"],
                "status": r["status"],
                "sections": r["sections"],
                "created_by": r["created_by"],
                "created_at": r["created_at"].isoformat(),
            }
        )
    return list(by_type.values())


@app.post("/api/note-types")
def create_note_type(payload: NoteTypeIn):
    sections = [s.model_dump() for s in payload.sections]
    if not sections:
        raise HTTPException(400, "A note type needs at least one section.")
    with db() as cur:
        cur.execute("INSERT INTO note_types(name) VALUES (%s) RETURNING id", (payload.name,))
        ntid = cur.fetchone()["id"]
        cur.execute(
            """INSERT INTO note_type_versions
               (note_type_id, version, sections, status, created_by)
               VALUES (%s, 1, %s, 'draft', %s) RETURNING id""",
            (ntid, json.dumps(sections), payload.created_by),
        )
    return {"id": ntid, "version": 1, "status": "draft"}


@app.post("/api/note-types/{note_type_id}/versions")
def new_version(note_type_id: int, payload: NewVersionIn):
    """Editing a template never mutates a published version — it forks a new draft."""
    sections = [s.model_dump() for s in payload.sections]
    with db() as cur:
        cur.execute(
            "SELECT COALESCE(max(version),0)+1 AS v FROM note_type_versions WHERE note_type_id=%s",
            (note_type_id,),
        )
        v = cur.fetchone()["v"]
        cur.execute(
            """INSERT INTO note_type_versions
               (note_type_id, version, sections, status, created_by)
               VALUES (%s, %s, %s, 'draft', %s) RETURNING id""",
            (note_type_id, v, json.dumps(sections), payload.created_by),
        )
        vid = cur.fetchone()["id"]
    return {"version_id": vid, "version": v, "status": "draft"}


@app.post("/api/note-type-versions/{version_id}/publish")
def publish_version(version_id: int):
    with db() as cur:
        cur.execute(
            "UPDATE note_type_versions SET status='published' WHERE id=%s RETURNING id",
            (version_id,),
        )
        if not cur.fetchone():
            raise HTTPException(404, "version not found")
    return {"version_id": version_id, "status": "published"}


# --------------------------------------------------------------------------- #
# Transcripts
# --------------------------------------------------------------------------- #
@app.get("/api/transcripts")
def list_transcripts():
    with db() as cur:
        cur.execute("SELECT id, title, body, created_at FROM transcripts ORDER BY id DESC")
        return [
            {**r, "created_at": r["created_at"].isoformat()} for r in cur.fetchall()
        ]


@app.post("/api/transcripts")
def create_transcript(payload: TranscriptIn):
    with db() as cur:
        cur.execute(
            "INSERT INTO transcripts(title, body) VALUES (%s, %s) RETURNING id",
            (payload.title, payload.body),
        )
        return {"id": cur.fetchone()["id"]}


# --------------------------------------------------------------------------- #
# Notes (generate / poll / retry / list)
# --------------------------------------------------------------------------- #
def _note_row(cur, note_id):
    cur.execute(
        """SELECT n.*, t.title AS transcript_title, nt.name AS note_type_name,
                  v.version, v.sections
           FROM notes n
           JOIN transcripts t ON t.id = n.transcript_id
           JOIN note_type_versions v ON v.id = n.note_type_version_id
           JOIN note_types nt ON nt.id = v.note_type_id
           WHERE n.id = %s""",
        (note_id,),
    )
    r = cur.fetchone()
    if not r:
        return None
    r["created_at"] = r["created_at"].isoformat()
    r["updated_at"] = r["updated_at"].isoformat()
    if r.get("approved_at"):
        r["approved_at"] = r["approved_at"].isoformat()
    return r


@app.post("/api/notes")
def create_note(payload: GenerateIn):
    with db() as cur:
        cur.execute(
            "SELECT status FROM note_type_versions WHERE id=%s",
            (payload.note_type_version_id,),
        )
        v = cur.fetchone()
        if not v:
            raise HTTPException(404, "note type version not found")
        if v["status"] != "published":
            # Trust guardrail: you cannot generate from an unreviewed draft.
            raise HTTPException(
                400, "This note type version is a draft. Publish it before generating."
            )
        cur.execute(
            "INSERT INTO notes(transcript_id, note_type_version_id, status) VALUES (%s,%s,'queued') RETURNING id",
            (payload.transcript_id, payload.note_type_version_id),
        )
        note_id = cur.fetchone()["id"]
        row = _note_row(cur, note_id)
    kick_generation(note_id)
    return row


@app.get("/api/notes/{note_id}")
def get_note(note_id: int):
    with db() as cur:
        row = _note_row(cur, note_id)
    if not row:
        raise HTTPException(404, "note not found")
    return row


@app.post("/api/notes/{note_id}/retry")
def retry_note(note_id: int):
    with db() as cur:
        cur.execute(
            "UPDATE notes SET status='queued', error=NULL, content=NULL, approved_by=NULL, approved_at=NULL, updated_at=now() WHERE id=%s RETURNING id",
            (note_id,),
        )
        if not cur.fetchone():
            raise HTTPException(404, "note not found")
        row = _note_row(cur, note_id)
    kick_generation(note_id)
    return row


@app.post("/api/notes/{note_id}/approve")
def approve_note(note_id: int, payload: ApproveIn):
    """
    Clinician sign-off. A note can only be approved once it has SUCCEEDED
    (a timed-out / invalid / still-running note is not trustworthy to sign).
    We record who approved it and when — the audit trail for the note itself.
    """
    with db() as cur:
        cur.execute("SELECT status FROM notes WHERE id=%s", (note_id,))
        n = cur.fetchone()
        if not n:
            raise HTTPException(404, "note not found")
        if n["status"] not in ("succeeded", "approved"):
            raise HTTPException(400, "Only a successfully generated note can be approved.")
        cur.execute(
            """UPDATE notes SET status='approved', approved_by=%s, approved_at=now(),
                                updated_at=now() WHERE id=%s""",
            (payload.approved_by, note_id),
        )
        return _note_row(cur, note_id)


@app.get("/api/notes")
def list_notes():
    with db() as cur:
        cur.execute(
            """SELECT n.id, n.status, n.created_at, n.updated_at,
                      t.title AS transcript_title, nt.name AS note_type_name, v.version
               FROM notes n
               JOIN transcripts t ON t.id = n.transcript_id
               JOIN note_type_versions v ON v.id = n.note_type_version_id
               JOIN note_types nt ON nt.id = v.note_type_id
               ORDER BY n.id DESC LIMIT 100"""
        )
        return [
            {**r, "created_at": r["created_at"].isoformat(), "updated_at": r["updated_at"].isoformat()}
            for r in cur.fetchall()
        ]


@app.get("/api/health")
def health():
    return {"ok": True}
