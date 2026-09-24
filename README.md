# OKF-RAG

A lightweight RAG (Retrieval-Augmented Generation) system that replaces vector embeddings with a structured **Open Knowledge Format (OKF)** role/state table.

The LLM receives all KB rows as plain-text context in its system prompt — no vector DB, no embedding model, no similarity search.

## Architecture

```
┌─────────────┐     HTTP/SSE      ┌──────────────────┐     Ollama API     ┌──────────┐
│  ui.html    │ ◄──────────────► │  server.js       │ ◄──────────────► │  Ollama  │
│  (browser)  │    JSON / Stream  │  (Node, no deps) │                   │  (LLM)   │
└─────────────┘                   │                  │                   └──────────┘
                                  │  ┌────────────┐  │
                                  │  │ kfgrag_*.json │  │
                                  │  │ (KB, texts,   │  │
                                  │  │  trees)       │  │
                                  │  └────────────┘  │
                                  └──────────────────┘
```

- **Zero npm dependencies** — uses only Node.js built-ins (`http`, `fs`, `path`, `child_process`)
- **Plain JSON persistence** — the knowledge base, text cache, and tree data are stored as flat JSON files
- **Ollama** — all LLM calls (chat, semantic tree generation) route to a local Ollama instance

## Quick Start

### Prerequisites

- Node.js 18+
- [Ollama](https://ollama.ai) running on `localhost:11434` with a model pulled (e.g. `pekeliling_talkbot:beta`)
- `pdftotext` (part of [Poppler](https://poppler.freedesktop.org)) — required for PDF uploads
- ollama run ZF2106/pekeliling_talkbot:beta (to pull fine tune model to local)

### Run

```bash
node server.js
```

Opens at `http://127.0.0.1:3002`.

### Usage

1. Open the browser UI
2. Upload a PDF or text file via the **+ Upload Document** button
3. Click a document in the sidebar to expand its knowledge tree
4. Switch between **Structure** (heading-based) and **Semantic** (LLM-generated) tree views
5. Click the **Table** toggle to browse raw KB rows
6. Click a tree node or a table **Filter** link to ask a question scoped to those rows
7. Chat with the LLM using the selected context

## Knowledge Base Structure

All data lives in the server's memory and is persisted to `kfgrag_kb.json`:

```json
{
  "0": {
    "state_pattern": "document_section",
    "role_behavior": "Knowledge Integrator",
    "filename": "example.pdf",
    "section_index": 0,
    "data": "extracted text content up to 3000 characters..."
  },
  "1": { "...": "..." }
}
```

| Field | Description |
|---|---|
| `state_pattern` | The action or event type (e.g. `document_section`) |
| `role_behavior` | The role that handles this row (e.g. `Knowledge Integrator`) |
| `filename` | Source document name |
| `section_index` | Ordinal position within the document |
| `data` | The extracted text content (capped at 3000 chars per row) |

Supporting files:
- `kfgrag_texts.json` — raw extracted text per document (used for structural tree building)
- `kfgrag_trees.json` — cached structural and semantic trees per document

## API Reference

### `GET /api/models`

Returns a list of available Ollama models.

**Response:** `["model1:tag", "model2:tag", ...]`

---

### `POST /api/upload`

Upload a document (PDF or plain text) to the knowledge base.

**Request:** `multipart/form-data` with a `file` field.

PDFs are extracted via `pdftotext` and split into sections. Text files are stored as a single row.

**Response:**
```json
{
  "ok": true,
  "row_count": 15,
  "first_state_id": "42",
  "filename": "document.pdf"
}
```

---

### `GET /api/knowledge-tree?file=<filename>`

Returns the cached structural and semantic trees for a document.

**Response:**
```json
{
  "structural": { "label": "doc.pdf", "type": "root", "children": [...] },
  "semantic": { "label": "doc.pdf", "type": "root", "children": [...] }
}
```

- **Structural tree** — built from numbered headings and indentation in the extracted text
- **Semantic tree** — LLM-generated topic clustering (null until generated)

---

### `POST /api/knowledge-tree/generate`

Generate a semantic tree for a document by calling Ollama.

**Request:**
```json
{
  "file": "document.pdf",
  "model": "ornith:9b"
}
```

**Response:**
```json
{
  "semantic": { "label": "doc.pdf", "type": "root", "children": [...] }
}
```

---

### `GET /api/kb-table?file=<filename>`

Returns KB rows as a table-compatible JSON array, filtered to a single document.

**Response:**
```json
{
  "rows": [
    {
      "state_id": "0",
      "state_pattern": "document_section",
      "role_behavior": "Knowledge Integrator",
      "section_index": 0,
      "data_preview": "Open Knowledge Format...",
      "data_length": 460,
      "filename": "test_okf.pdf"
    }
  ]
}
```

---

### `POST /api/chat`

Send a message to the LLM with KB context. Streaming SSE response.

**Request:**
```json
{
  "message": "What is OKF?",
  "model": "ornith:9b",
  "filter_ids": ["0", "1", "2"]
}
```

| Field | Description |
|---|---|
| `message` | User's question |
| `model` | Ollama model to use (optional, defaults to server's current model) |
| `filter_ids` | Array of KB row IDs to scope context (optional; omitting sends all rows) |

**Response:** Server-Sent Events stream:
```
data: {"content": "OKF stands for..."}
data: {"content": " Open Knowledge..."}
data: [DONE]
```

## OKF vs Traditional RAG

| Dimension | OKF (this project) | Traditional Vector RAG |
|---|---|---|
| **Retrieval** | None — all rows are placed in the LLM's system prompt | Similarity search against a vector index |
| **Context limit** | ~50-100 rows (bounded by LLM context window) | Millions of chunks (scales via vector DB) |
| **Interpretability** | Full transparency — every row in the prompt is visible | Opaque — similarity scores don't explain *why* a match occurred |
| **Infrastructure** | JSON file + Node.js stdlib | Embedding model + vector database (Pinecone, Chroma, Qdrant, etc.) |
| **Setup time** | Minutes (no external services beyond Ollama) | Hours-days (pipeline: chunk → embed → index → query) |
| **Filtering** | Client-driven — `filter_ids` scopes which rows are included | Vector DB metadata filtering + approximate nearest neighbor |
| **Data freshness** | Immediate — edit the JSON and the next query picks it up | Requires re-indexing documents after changes |
| **Cost** | No embedding API costs; single Ollama instance | Embedding API calls per document + vector DB hosting |
| **Precision** | Deterministic — the LLM reads exactly the rows you specify | Probabilistic — depends on embedding quality and similarity threshold tuning |

### When to use OKF

- Small knowledge bases (<50 documents, <100 rows total)
- Interpretability is critical (audit trails, compliance, debugging)
- Rapid prototyping and experimentation
- Offline/air-gapped environments without vector DB infrastructure

### When to use Traditional RAG

- Large document collections (thousands+ documents)
- Need for scaling beyond LLM context window limits
- Existing embedding pipeline and vector DB infrastructure
- Hierarchical metadata filtering at retrieval time

## UI Design

The interface follows a Tesla-inspired design system (see `DESIGN-tesla.md`):
- **Electric Blue** (`#3E6AE1`) as the sole accent color for interactive elements
- No shadows, no borders, no gradients — whitespace and typography carry the layout
- 0.33s transitions on all interactive states
- 4px border-radius on all interactive elements
- Monochrome palette: whites, grays, and a single blue

### Layout

```
┌──────────────────────────────────────────────────┐
│  Sidebar (300px)              │  Main (flex 1)   │
│  ┌────────────────────┐       │  ┌──────────────┐│
│  │ Documents           │       │  │ OKF Chat [Table]││
│  │  ► doc1.pdf    15   │       │  ├──────────────┤│
│  │    ├ Structure      │       │  │ Messages      ││
│  │    └ Semantic       │       │  │ or Table View ││
│  │  ► doc2.pdf     2   │       │  │              ││
│  │    ├ Structure      │       │  │              ││
│  │    └ Semantic       │       │  ├──────────────┤│
│  │  [+ Upload Document]│       │  │ [Ask a q...] ││
│  │  ───────────────────│       │  └──────────────┘│
│  │  Model ▼            │       │                  │
│  └────────────────────┘       │                  │
└──────────────────────────────────────────────────┘
```

- **Sidebar** — document list with expandable tree views (Structure/Semantic tabs per doc)
- **Table toggle** — replaces the chat message area with a KB row table for the selected document
- **Chat** — streaming LLM responses with optional row-level filter context

## Data Files

| File | Purpose | Size (approx) |
|---|---|---|
| `kfgrag_kb.json` | Knowledge base rows (role/state table) | 90 KB |
| `kfgrag_texts.json` | Raw extracted text per document | 240 KB |
| `kfgrag_trees.json` | Cached structural + semantic trees | 125 KB |
| `kfgrag_trees.json` | Also stores `semantic_generated_at` timestamps | — |

Files are created automatically on first server run.
