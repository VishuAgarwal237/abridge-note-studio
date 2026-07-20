import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

/* ------------------------------------------------------------------ *
 * Component tree (as sketched):
 *   App
 *   ├── TranscriptPanel      (TranscriptSelector, TranscriptPreview)
 *   ├── NoteGenerationPanel  (NoteTypeSelector, GenerateNoteButton, GeneratedNote)
 *   └── CreateNoteTypePanel  (NoteTypeNameInput, SectionListEditor, CreateNoteTypeButton)
 * ------------------------------------------------------------------ */

const api = {
  get: (p: string) => fetch(p).then((r) => r.json()),
  post: async (p: string, body?: any) => {
    const r = await fetch(p, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || "request failed");
    return data;
  },
};

type Section = { key: string; title: string; required: boolean };
type Version = {
  version_id: number; version: number; status: string;
  sections: Section[]; created_by: string; created_at: string;
};
type NoteType = { id: number; name: string; versions: Version[] };
type Transcript = { id: number; title: string; body: string };
type Note = {
  id: number; status: string; content: Record<string, string> | null;
  error: string | null; transcript_title: string; note_type_name: string;
  version: number; sections: Section[]; updated_at: string;
  approved_by: string | null; approved_at: string | null;
};

/* --------------------------- shared UI bits --------------------------- */
const card: React.CSSProperties = {
  background: "var(--panel)", border: "1px solid var(--line)",
  borderRadius: 12, padding: 18, marginBottom: 18,
};
const btn = (primary = true): React.CSSProperties => ({
  background: primary ? "var(--accent)" : "transparent",
  color: primary ? "#fff" : "var(--text)",
  border: primary ? "none" : "1px solid var(--line)",
  padding: "9px 16px", borderRadius: 8, fontWeight: 600,
});
const input: React.CSSProperties = {
  width: "100%", background: "var(--panel-2)", color: "var(--text)",
  border: "1px solid var(--line)", borderRadius: 8, padding: "9px 11px",
};
const label: React.CSSProperties = { color: "var(--muted)", fontSize: 12, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6, display: "block" };

const STATUS_META: Record<string, { color: string; label: string }> = {
  queued: { color: "var(--muted)", label: "Queued" },
  running: { color: "var(--blue)", label: "Generating…" },
  succeeded: { color: "var(--green)", label: "Ready · needs review" },
  approved: { color: "var(--green)", label: "Approved" },
  timed_out: { color: "var(--amber)", label: "Timed out" },
  invalid_output: { color: "var(--red)", label: "Invalid output" },
  failed: { color: "var(--red)", label: "Failed" },
  draft: { color: "var(--amber)", label: "draft" },
  published: { color: "var(--green)", label: "published" },
};

function Pill({ status }: { status: string }) {
  const m = STATUS_META[status] ?? { color: "var(--muted)", label: status };
  return (
    <span style={{
      color: m.color, border: `1px solid ${m.color}`, borderRadius: 999,
      padding: "2px 10px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
    }}>{m.label}</span>
  );
}

/* ============================== App =============================== */
function App() {
  const [noteTypes, setNoteTypes] = useState<NoteType[]>([]);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [selectedTranscript, setSelectedTranscript] = useState<number | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);

  const refreshNoteTypes = () => api.get("/api/note-types").then(setNoteTypes);
  const refreshTranscripts = () => api.get("/api/transcripts").then(setTranscripts);

  useEffect(() => { refreshNoteTypes(); refreshTranscripts(); }, []);

  const transcript = transcripts.find((t) => t.id === selectedTranscript) ?? null;

  return (
    <div>
      <header style={{ marginBottom: 22 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Abridge · Note Studio</h1>
        <p style={{ color: "var(--muted)", margin: "4px 0 0" }}>
          Turn an incoming transcript into a structured, reviewed draft note.
        </p>
      </header>

      <TranscriptPanel
        transcripts={transcripts}
        selected={selectedTranscript}
        onSelect={setSelectedTranscript}
        transcript={transcript}
        onAdded={refreshTranscripts}
      />

      <NoteGenerationPanel
        noteTypes={noteTypes}
        selectedVersion={selectedVersion}
        onSelectVersion={setSelectedVersion}
        transcriptId={selectedTranscript}
        onPublished={refreshNoteTypes}
      />

      <CreateNoteTypePanel onCreated={refreshNoteTypes} />
    </div>
  );
}

/* ======================== TranscriptPanel ========================= */
function TranscriptPanel({ transcripts, selected, onSelect, transcript, onAdded }: {
  transcripts: Transcript[]; selected: number | null;
  onSelect: (id: number) => void; transcript: Transcript | null; onAdded: () => void;
}) {
  return (
    <section style={card}>
      <h2 style={{ marginTop: 0, fontSize: 15 }}>1 · Incoming transcript</h2>
      <TranscriptSelector transcripts={transcripts} selected={selected} onSelect={onSelect} onAdded={onAdded} />
      <TranscriptPreview transcript={transcript} />
    </section>
  );
}

function TranscriptSelector({ transcripts, selected, onSelect, onAdded }: {
  transcripts: Transcript[]; selected: number | null;
  onSelect: (id: number) => void; onAdded: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const submit = async () => {
    if (!title.trim() || !body.trim()) return;
    const { id } = await api.post("/api/transcripts", { title, body });
    setTitle(""); setBody(""); setAdding(false);
    await onAdded(); onSelect(id);
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <select style={{ ...input, flex: 1 }} value={selected ?? ""}
          onChange={(e) => onSelect(Number(e.target.value))}>
          <option value="" disabled>Select a transcript from the pipeline…</option>
          {transcripts.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
        </select>
        <button style={btn(false)} onClick={() => setAdding((v) => !v)}>
          {adding ? "Cancel" : "+ New transcript"}
        </button>
      </div>
      {adding && (
        <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
          <input style={input} placeholder="Title (e.g. Ms. Smith — chest pain)"
            value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea style={{ ...input, minHeight: 120, fontFamily: "ui-monospace, monospace" }}
            placeholder="Paste transcript text…" value={body} onChange={(e) => setBody(e.target.value)} />
          <button style={btn()} onClick={submit}>Add transcript</button>
        </div>
      )}
    </div>
  );
}

function TranscriptPreview({ transcript }: { transcript: Transcript | null }) {
  if (!transcript) return null;
  return (
    <pre style={{
      marginTop: 12, background: "var(--panel-2)", border: "1px solid var(--line)",
      borderRadius: 8, padding: 12, maxHeight: 200, overflow: "auto",
      whiteSpace: "pre-wrap", color: "var(--muted)", fontSize: 13,
    }}>{transcript.body}</pre>
  );
}

/* ====================== NoteGenerationPanel ======================= */
function NoteGenerationPanel({ noteTypes, selectedVersion, onSelectVersion, transcriptId, onPublished }: {
  noteTypes: NoteType[]; selectedVersion: number | null;
  onSelectVersion: (id: number) => void; transcriptId: number | null; onPublished: () => void;
}) {
  const [note, setNote] = useState<Note | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Poll the note while it is being generated (the unreliable-generation UX).
  useEffect(() => {
    if (!note || ["succeeded", "timed_out", "invalid_output", "failed"].includes(note.status)) return;
    const t = setInterval(async () => {
      const fresh = await api.get(`/api/notes/${note.id}`);
      setNote(fresh);
    }, 900);
    return () => clearInterval(t);
  }, [note?.id, note?.status]);

  const generate = async () => {
    setError(null);
    try {
      const n = await api.post("/api/notes", {
        transcript_id: transcriptId, note_type_version_id: selectedVersion,
      });
      setNote(n);
    } catch (e: any) { setError(e.message); }
  };

  const retry = async () => {
    const n = await api.post(`/api/notes/${note!.id}/retry`);
    setNote(n);
  };

  const approve = async () => {
    const n = await api.post(`/api/notes/${note!.id}/approve`, { approved_by: "web-user" });
    setNote(n);
  };

  return (
    <section style={card}>
      <h2 style={{ marginTop: 0, fontSize: 15 }}>2 · Note type &amp; generation</h2>
      <NoteTypeSelector noteTypes={noteTypes} selected={selectedVersion}
        onSelect={onSelectVersion} onPublished={onPublished} />
      <GenerateNoteButton
        disabled={!transcriptId || !selectedVersion}
        onClick={generate} error={error} />
      <GeneratedNote note={note} onRetry={retry} onApprove={approve} />
    </section>
  );
}

function NoteTypeSelector({ noteTypes, selected, onSelect, onPublished }: {
  noteTypes: NoteType[]; selected: number | null;
  onSelect: (id: number) => void; onPublished: () => void;
}) {
  // Flatten to (note type, version) options; drafts can't generate but can be published.
  return (
    <div style={{ display: "grid", gap: 8, marginBottom: 6 }}>
      <span style={label}>Choose a note type version</span>
      {noteTypes.map((nt) => (
        <div key={nt.id} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <strong style={{ minWidth: 130 }}>{nt.name}</strong>
          {nt.versions.map((v) => {
            const isSel = v.version_id === selected;
            const isPub = v.status === "published";
            return (
              <span key={v.version_id} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <button
                  onClick={() => isPub && onSelect(v.version_id)}
                  title={isPub ? "" : "Draft versions must be published before use"}
                  style={{
                    ...btn(isSel), opacity: isPub ? 1 : 0.55,
                    borderColor: isSel ? "var(--accent)" : "var(--line)",
                    background: isSel ? "var(--accent)" : "var(--panel-2)",
                    color: isSel ? "#fff" : "var(--text)", cursor: isPub ? "pointer" : "not-allowed",
                    padding: "6px 10px",
                  }}>
                  v{v.version} · {v.sections.length} sections
                </button>
                <Pill status={v.status} />
                {!isPub && (
                  <button style={{ ...btn(false), padding: "5px 10px" }}
                    onClick={async () => { await api.post(`/api/note-type-versions/${v.version_id}/publish`); onPublished(); }}>
                    Publish
                  </button>
                )}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function GenerateNoteButton({ disabled, onClick, error }: {
  disabled: boolean; onClick: () => void; error: string | null;
}) {
  return (
    <div style={{ marginTop: 12 }}>
      <button style={{ ...btn(), opacity: disabled ? 0.5 : 1 }} disabled={disabled} onClick={onClick}>
        Generate draft note
      </button>
      {error && <span style={{ color: "var(--red)", marginLeft: 12 }}>{error}</span>}
    </div>
  );
}

function GeneratedNote({ note, onRetry, onApprove }: {
  note: Note | null; onRetry: () => void; onApprove: () => void;
}) {
  if (!note) return null;
  const busy = ["queued", "running"].includes(note.status);
  const failed = ["timed_out", "invalid_output", "failed"].includes(note.status);
  const canApprove = note.status === "succeeded";
  const approved = note.status === "approved";

  return (
    <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <Pill status={note.status} />
        <span style={{ color: "var(--muted)" }}>
          {note.note_type_name} v{note.version} · {note.transcript_title}
        </span>
        {failed && <button style={{ ...btn(false), marginLeft: "auto" }} onClick={onRetry}>Retry</button>}
        {canApprove && (
          <button style={{ ...btn(), marginLeft: "auto", background: "var(--green)" }} onClick={onApprove}>
            Review &amp; approve
          </button>
        )}
      </div>

      {approved && (
        <div style={{ background: "rgba(55,194,107,0.1)", border: "1px solid var(--green)",
          borderRadius: 8, padding: "8px 12px", color: "var(--green)", marginBottom: 10, fontSize: 13 }}>
          ✓ Approved by <strong>{note.approved_by}</strong>
          {note.approved_at ? ` · ${new Date(note.approved_at).toLocaleString()}` : ""}
        </div>
      )}

      {busy && <p style={{ color: "var(--muted)" }}>Working… a real generator can take seconds to minutes. You can keep working meanwhile.</p>}

      {note.error && (
        <div style={{ background: "rgba(232,88,108,0.1)", border: "1px solid var(--red)",
          borderRadius: 8, padding: "10px 12px", color: "var(--red)", marginBottom: 10 }}>
          {note.error}
        </div>
      )}

      {/* Render structurally: one block per section defined by the template. */}
      {note.content && (
        <div style={{ display: "grid", gap: 12 }}>
          {note.sections.map((s) => {
            const val = note.content?.[s.key];
            const missing = s.required && (!val || !val.trim());
            return (
              <div key={s.key}>
                <div style={{ ...label, color: missing ? "var(--red)" : "var(--muted)" }}>
                  {s.title}{s.required ? " *" : ""}{missing ? " — missing" : ""}
                </div>
                <div style={{ background: "var(--panel-2)", border: "1px solid var(--line)",
                  borderRadius: 8, padding: 12, whiteSpace: "pre-wrap",
                  color: missing ? "var(--red)" : "var(--text)" }}>
                  {val || "—"}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ======================= CreateNoteTypePanel ====================== */
function CreateNoteTypePanel({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [sections, setSections] = useState<Section[]>([
    { key: "", title: "", required: true },
  ]);
  const [msg, setMsg] = useState<string | null>(null);

  const submit = async () => {
    setMsg(null);
    const clean = sections
      .filter((s) => s.title.trim())
      .map((s) => ({
        title: s.title.trim(),
        key: (s.key || s.title).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
        required: s.required,
      }));
    if (!name.trim() || clean.length === 0) { setMsg("Name and at least one section are required."); return; }
    await api.post("/api/note-types", { name, sections: clean });
    setName(""); setSections([{ key: "", title: "", required: true }]);
    setMsg("Created as a draft — publish it above to start generating with it.");
    onCreated();
  };

  return (
    <section style={card}>
      <h2 style={{ marginTop: 0, fontSize: 15 }}>3 · Add a note type (no code change)</h2>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>
        New note types are stored as data and start as a <em>draft</em> for review before use.
      </p>
      <NoteTypeNameInput name={name} setName={setName} />
      <SectionListEditor sections={sections} setSections={setSections} />
      <CreateNoteTypeButton onClick={submit} />
      {msg && <span style={{ color: "var(--muted)", marginLeft: 12 }}>{msg}</span>}
    </section>
  );
}

function NoteTypeNameInput({ name, setName }: { name: string; setName: (v: string) => void }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <span style={label}>Note type name</span>
      <input style={input} placeholder="e.g. Discharge Summary" value={name}
        onChange={(e) => setName(e.target.value)} />
    </div>
  );
}

function SectionListEditor({ sections, setSections }: {
  sections: Section[]; setSections: (s: Section[]) => void;
}) {
  const update = (i: number, patch: Partial<Section>) =>
    setSections(sections.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <div style={{ marginBottom: 12 }}>
      <span style={label}>Sections (the structure of the note)</span>
      <div style={{ display: "grid", gap: 8 }}>
        {sections.map((s, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input style={{ ...input, flex: 1 }} placeholder="Section title (e.g. Assessment)"
              value={s.title} onChange={(e) => update(i, { title: e.target.value })} />
            <label style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--muted)", whiteSpace: "nowrap" }}>
              <input type="checkbox" checked={s.required}
                onChange={(e) => update(i, { required: e.target.checked })} /> required
            </label>
            <button style={{ ...btn(false), padding: "6px 10px" }}
              onClick={() => setSections(sections.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
      </div>
      <button style={{ ...btn(false), marginTop: 8 }}
        onClick={() => setSections([...sections, { key: "", title: "", required: false }])}>
        + Add section
      </button>
    </div>
  );
}

function CreateNoteTypeButton({ onClick }: { onClick: () => void }) {
  return <button style={btn()} onClick={onClick}>Create note type</button>;
}

createRoot(document.getElementById("root")!).render(<App />);
