const http = require("http"), fs = require("fs"), path = require("path"), cp = require("child_process");
process.on("unhandledRejection", e => console.error("Unhandled:", e.message));
process.on("uncaughtException", e => console.error("Uncaught:", e.message));

// ---- OKF Knowledge Base (role/state table replaces vectors)
let _kb = {};
const KB_FILE = path.join(__dirname, "kfgrag_kb.json");
try { _kb = JSON.parse(fs.readFileSync(KB_FILE, "utf-8")); } catch { _kb = {}; }

function saveKB() {
  fs.mkdirSync(path.dirname(KB_FILE), { recursive: true });
  fs.writeFileSync(KB_FILE, JSON.stringify(_kb, null, 2));
}
saveKB();

// ---- Text cache (preserves pdftotext layout for structure tree)
let _texts = {};
const TEXTS_FILE = path.join(__dirname, "kfgrag_texts.json");
try { _texts = JSON.parse(fs.readFileSync(TEXTS_FILE, "utf-8")); } catch { _texts = {}; }
function saveTexts() { fs.writeFileSync(TEXTS_FILE, JSON.stringify(_texts, null, 2)); }

// ---- Tree cache (structural + semantic)
let _trees = {};
const TREES_FILE = path.join(__dirname, "kfgrag_trees.json");
try { _trees = JSON.parse(fs.readFileSync(TREES_FILE, "utf-8")); } catch { _trees = {}; }
function saveTrees() { fs.writeFileSync(TREES_FILE, JSON.stringify(_trees, null, 2)); }

// Each KB row keyed by state_id: { state_pattern, role_behavior, data }
// state_pattern = the action (e.g. "document_uploaded", "user_asked_question")
// role_behavior = which role responds (e.g. "Document Loader", "Knowledge Integrator")

// ---- Source documents directory (auto-ingested at startup)
const SOURCE_DIR = path.join(__dirname, "source");

// ---- parse multipart form data — returns { filename, content, rawBuffer }
function parseMultipart(bodyBuf, contentType) {
  try {
    const boundary = contentType?.split("boundary=")[1]?.trim();
    if (!boundary) return null;
    const fullStr = Buffer.isBuffer(bodyBuf) ? bodyBuf.toString("latin1") : String(bodyBuf);
    // Find the part containing filename=
    const parts = fullStr.split(`--${boundary}`);
    const filePart = parts.find(p => p.includes("filename="));
    if (!filePart) return null;
    const fnMatch = filePart.match(/filename="([^"]*)"/);
    const filename = fnMatch ? fnMatch[1] : "doc.txt";
    // Find body start (after \r\n\r\n) and end (before trailing \r\n-- or --)
    const hdrEnd = filePart.indexOf('\r\n\r\n');
    if (hdrEnd < 0) return { filename, content: "", rawBuffer: Buffer.alloc(0) };
    const bodyStart = hdrEnd + 4;
    // Calculate byte offsets in the original buffer
    // Convert the part string to latin1 to get 1:1 byte mapping
    const partStr = filePart;
    const contentEndStr = partStr.search(/\r?\n--|--\r?\n/);
    const endIdx = contentEndStr > bodyStart ? contentEndStr : partStr.length;
    // Slice raw bytes from original buffer using latin1 byte positions
    const partStartInFull = fullStr.indexOf(filePart);
    const rawBufStart = partStartInFull + bodyStart;
    const rawBufEnd = partStartInFull + endIdx;
    const rawBuffer = bodyBuf.slice(rawBufStart, rawBufEnd);
    const content = rawBuffer.toString("utf-8").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim();
    return { filename, content: content.slice(0, 32000), rawBuffer };
  } catch (e) {
    const s = Buffer.isBuffer(bodyBuf) ? bodyBuf.toString("utf-8") : String(bodyBuf);
    return { filename: "doc.txt", content: s.slice(0, 4000), rawBuffer: bodyBuf.slice(0, 4000) };
  }
}

let MODEL = "sailor2:latest"; //"ornith:9b";

// ---- Extract text from PDF via pdftotext (no npm deps needed)
function extractPDF(filePath) {
  const outPath = filePath.replace(/\.pdf$/i, "") + ".txt";
  cp.execSync(`pdftotext -layout "${filePath}" "${outPath}"`, { timeout: 15000 });
  const text = fs.readFileSync(outPath, "utf-8");
  try { fs.unlinkSync(outPath); } catch {}
  return text;
}

// ---- Convert plain text into OKF role/state table rows
function textToOKFRows(text, filename) {
  const sections = text.split(/\n\s*\n/).filter(s => s.trim().length > 20);
  if (!sections.length) {
    const chars = 2000;
    for (let i = 0; i < text.length; i += chars) {
      const chunk = text.slice(i, i + chars).trim();
      if (chunk.length > 20) sections.push(chunk);
    }
  }
  return sections.slice(0, 50).map((section, i) => ({
    state_pattern: "document_section",
    role_behavior: "Knowledge Integrator",
    filename,
    section_index: i,
    data: section.slice(0, 3000)
  }));
}

// ---- Build structural tree from pdftotext layout output
function buildStructureTree(filename) {
  const text = _texts[filename];
  if (!text) return { label: filename, type: "root", children: [] };
  const lines = text.split("\n");
  const root = { label: filename, type: "root", children: [] };
  const stack = [{ node: root, level: -1, heading: false }];
  let sectionLines = [];
  // Collect all KB row data for this file to annotate leaves
  const fileRows = Object.entries(_kb).filter(([, r]) => r.filename === filename);

  function flushSection() {
    if (!sectionLines.length) return;
    const parent = stack[stack.length - 1].node;
    const content = sectionLines.join(" ").trim();
    if (content.length > 20) {
      const label = content.slice(0, 80);
      // Find matching KB row(s) by content overlap
      const matchIds = fileRows.filter(([id, r]) => {
        const rowText = (r.data || "").slice(0, 100);
        return content.includes(rowText) || rowText.includes(content.slice(0, 50));
      }).map(([id]) => id);
      parent.children.push({ label, type: "content", state_ids: matchIds });
    }
    sectionLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) { sectionLines.push(""); continue; }
    const headingMatch = trimmed.match(/^((?:\d+\.?)+)\s+(.+)/);
    const isHeading = headingMatch || (trimmed.length < 50 && trimmed.length > 2 && !trimmed.endsWith(".") && (i === 0 || lines[i-1].trim() === ""));
    if (isHeading && headingMatch) {
      flushSection();
      const nums = headingMatch[1].split(/\./).filter(Boolean).length;
      const label = headingMatch[2].trim();
      const level = nums;
      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
      const parent = stack[stack.length - 1].node;
      const newNode = { label, type: "heading", children: [] };
      parent.children.push(newNode);
      stack.push({ node: newNode, level });
    } else if (isHeading && !headingMatch) {
      flushSection();
      const parent = stack[stack.length - 1].node;
      const hdrLabel = trimmed.length > 40 ? trimmed.slice(0, 40) + "..." : trimmed;
      const newNode = { label: hdrLabel, type: "heading", children: [] };
      parent.children.push(newNode);
      stack.push({ node: newNode, level: stack.length });
    } else {
      sectionLines.push(trimmed);
    }
  }
  flushSection();
  return root;
}

// ---- Build semantic tree via LLM
async function buildSemanticTree(filename, model) {
  const rows = Object.entries(_kb).filter(([, r]) => r.filename === filename);
  if (!rows.length) return { label: filename, type: "root", children: [] };
  const sections = rows.map(([id, r]) => `[${id}] ${(r.data || "").slice(0, 500)}`).join("\n\n");
  const prompt = `Organize these document sections into a knowledge tree with topics and subtopics. Return ONLY valid JSON (no markdown, no explanation):\n{"tree":[{"topic":"...","summary":"...","children":[{"topic":"...","summary":"..."}]}]}\n\nDocument sections:\n${sections}`;
  try {
    const res = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: model || MODEL, messages: [{ role: "user", content: prompt }], stream: false })
    });
    const data = await res.json();
    const content = data.message?.content || "";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    const tree = parsed?.tree || [];
    // Annotate tree leaves with all file's state_ids (simplified: all rows belong to every leaf)
    // In a production system you'd do proper content matching
    const allIds = rows.map(([id]) => id);
    function annotateIds(nodes) {
      nodes.forEach(n => {
        if (n.children && n.children.length) annotateIds(n.children);
        else n.state_ids = allIds;
      });
    }
    annotateIds(tree);
    return { label: filename, type: "root", children: Array.isArray(tree) ? tree : [] };
  } catch {
    return { label: filename, type: "root", children: [] };
  }
}

// ---- Fetch available models from Ollama
async function fetchModels() {
  try {
    const res = await fetch("http://localhost:11434/api/tags");
    const data = await res.json();
    return (data.models || []).map(m => m.name);
  } catch { return [MODEL]; }
}

// ---- Recursively list PDFs under a directory (keyed by slash-relative path)
function listSourcePDFs(dir, prefix) {
  const files = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) files.push(...listSourcePDFs(full, rel));
    else if (name.toLowerCase().endsWith(".pdf")) files.push({ full, rel });
  }
  return files;
}

// ---- Rebuild the KB from source/ on startup (replaces any prior contents)
function ingestSource() {
  const pdfs = listSourcePDFs(SOURCE_DIR, "");
  _kb = {};
  _texts = {};
  let rows = 0;
  for (const { full, rel } of pdfs) {
    let extractedText = "";
    try { extractedText = extractPDF(full); }
    catch (e) { extractedText = `[PDF extraction failed for ${rel}: ${e.message}]`; }
    _texts[rel] = extractedText;
    const docRows = textToOKFRows(extractedText, rel);
    const firstId = String(Object.keys(_kb).length);
    docRows.forEach((row, i) => { _kb[String(Number(firstId) + i)] = row; });
    rows += docRows.length;
  }
  _trees = {};
  saveKB();
  saveTexts();
  saveTrees();
  return { doc_count: pdfs.length, row_count: rows };
}

// ---- Streaming SSE response that routes to Ollama /api/chat
async function streamOllama(res, messages, model) {
  const body = JSON.stringify({ model: model || MODEL, messages, stream: true });
  try {
    const ollamaRes = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    });
    if (!ollamaRes.ok || !ollamaRes.body) {
      try { res.writeHead(500); res.end("Ollama error"); } catch {}
      return;
    }
    const reader = ollamaRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        try { res.write("data: [DONE]\n\n"); res.end(); } catch {}
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          const c = j.message?.content || j.message?.thinking || '';
          if (c) try { res.write(`data: ${JSON.stringify({ content: c })}\n\n`); } catch {}
          if (j.done) {
            try { res.write("data: [DONE]\n\n"); res.end(); } catch {}
            return;
          }
        } catch {}
      }
    }
  } catch { try { res.end(); } catch {} }
}

// ---- Server
const PORT = 3002;
const server = http.createServer(async (req, res) => {
  try {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;
  const method = req.method;

  // ---- CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ---- List models from Ollama
  if (method === "GET" && pathname === "/api/models") {
    const models = await fetchModels();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(models));
    return;
  }

  // ---- Serve chat UI
  if (method === "GET" && pathname === "/") {
    const htmlPath = path.join(__dirname, "ui.html");
    try {
      const html = fs.readFileSync(htmlPath, "utf-8");
      res.setHeader("Content-Type", "text/html");
      res.end(html);
    } catch {
      // fallback inline UI if file missing
      res.setHeader("Content-Type", "text/html");
      res.end(`<!DOCTYPE html><html><body><h2>OKF RAG Chat</h2>
<p>Server running. Upload a document via POST /api/upload then chat at /api/chat.</p></body></html>`);
    }
    return;
  }

  // ---- Upload document → store as OKF KB row(s)
  if (method === "POST" && pathname === "/api/upload") {
    const ct = req.headers["content-type"] || "";
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const parsedForm = parseMultipart(raw, ct);
    if (!parsedForm) {
      res.writeHead(400); res.end(JSON.stringify({ error: "bad form" })); return;
    }
    const { filename, content, rawBuffer } = parsedForm;
    const isPDF = /\.pdf$/i.test(filename);

    if (isPDF) {
      // Save raw PDF bytes to temp, extract via pdftotext, convert to rows
      const tmpPath = path.join("/tmp", `okf_pdf_${Date.now()}.pdf`);
      fs.writeFileSync(tmpPath, rawBuffer);
      let rows = [];
      let extractedText = "";
      try {
        extractedText = extractPDF(tmpPath);
        rows = textToOKFRows(extractedText, filename);
      } catch (e) {
        rows = [{ state_pattern: "document_section", role_behavior: "Knowledge Integrator", filename, section_index: 0, data: `[PDF extraction failed: ${e.message}]` }];
      }
      try { fs.unlinkSync(tmpPath); } catch {}
      // Cache extracted text for structural tree
      _texts[filename] = extractedText;
      saveTexts();
      const firstId = String(Object.keys(_kb).length);
      rows.forEach((row, i) => { _kb[String(Number(firstId) + i)] = row; });
      saveKB();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, row_count: rows.length, first_state_id: firstId, filename }));
      return;
    }

    // Non-PDF: store content as single OKF row
    const nonPdfRows = [{ state_pattern: "document_section", role_behavior: "Knowledge Integrator", filename, section_index: 0, data: content.slice(0, 16000) }];
    const nonPdfId = String(Object.keys(_kb).length);
    nonPdfRows.forEach((row, i) => { _kb[String(Number(nonPdfId) + i)] = row; });
    saveKB();
    // Cache text for structural tree
    _texts[filename] = content;
    saveTexts();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, row_count: nonPdfRows.length, first_state_id: nonPdfId, filename }));
    return;
  }

  // ---- Get knowledge tree (structural + semantic)
  if (method === "GET" && pathname === "/api/knowledge-tree") {
    const file = parsed.searchParams.get("file");
    if (!file) { res.writeHead(400); res.end(JSON.stringify({ error: "file param required" })); return; }
    if (!_trees[file]) _trees[file] = {};
    if (!_trees[file].structural) _trees[file].structural = buildStructureTree(file);
    const semantic = _trees[file].semantic || null;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ structural: _trees[file].structural, semantic }));
    return;
  }

  // ---- Generate semantic tree for a file
  if (method === "POST" && pathname === "/api/knowledge-tree/generate") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    let body;
    try { body = JSON.parse(raw.toString()); } catch { body = {}; }
    const file = body.file;
    const model = body.model || MODEL;
    if (!file) { res.writeHead(400); res.end(JSON.stringify({ error: "file required" })); return; }
    if (!_trees[file]) _trees[file] = {};
    _trees[file].semantic = await buildSemanticTree(file, model);
    _trees[file].semantic_generated_at = new Date().toISOString();
    saveTrees();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ semantic: _trees[file].semantic }));
    return;
  }

  // ---- Get KB table
  if (method === "GET" && pathname === "/api/kb-table") {
    const file = parsed.searchParams.get("file");
    const entries = Object.entries(_kb);
    const filtered = file ? entries.filter(([, r]) => r.filename === file) : entries;
    const rows = filtered.map(([id, r]) => ({
      state_id: id,
      state_pattern: r.state_pattern || "",
      role_behavior: r.role_behavior || "",
      section_index: r.section_index ?? 0,
      data_preview: (r.data || "").slice(0, 120),
      data_length: (r.data || "").length,
      filename: r.filename || ""
    }));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ rows }));
    return;
  }

  // ---- List documents in the KB (grouped by filename)
  if (method === "GET" && pathname === "/api/documents") {
    const counts = {};
    for (const [, r] of Object.entries(_kb)) {
      const f = r.filename || "";
      counts[f] = (counts[f] || 0) + 1;
    }
    const docs = Object.entries(counts)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([filename, row_count]) => ({ filename, row_count }));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ documents: docs }));
    return;
  }

  function contextRowString(id, row) {
  return `[Row ${id}] pattern="${row.state_pattern}" role="${row.role_behavior}" filename="${row.filename}":\n${(row.data || "").slice(0, 3000)}`;
}

// ---- Bounded unfiltered context: sample rows evenly across all documents
function sampleContextRows(budget) {
  const byDoc = new Map();
  for (const [id, row] of Object.entries(_kb)) {
    const f = row.filename || "?";
    if (!byDoc.has(f)) byDoc.set(f, []);
    byDoc.get(f).push([id, row]);
  }
  const docs = [...byDoc.keys()].sort();
  if (!docs.length) return [];
  const base = Math.max(1, Math.floor(budget / docs.length));
  let remainder = budget - base * docs.length;
  const rows = [];
  for (const f of docs) {
    const docRows = byDoc.get(f)
      .sort((a, b) => ((a[1].section_index) || 0) - ((b[1].section_index) || 0));
    let take = base;
    if (remainder > 0) { take += 1; remainder -= 1; }
    take = Math.min(take, docRows.length);
    for (let i = 0; i < take; i++) rows.push(docRows[i]);
  }
  return rows;
}

  // ---- Chat with knowledge base context
  if (method === "POST" && pathname === "/api/chat") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    let body;
    try { body = JSON.parse(raw.toString()); } catch { body = { message: raw.toString() }; }
    const userMsg = body.message || body.content || "";
    const selectedModel = body.model || MODEL;
    MODEL = selectedModel;
    const filterIds = body.filter_ids;
    let contextRows;
    if (Array.isArray(filterIds) && filterIds.length) {
      contextRows = filterIds.map(id => {
        const row = _kb[id];
        if (!row) return "";
        return contextRowString(id, row);
      }).filter(Boolean).join("\n\n");
    } else {
      contextRows = sampleContextRows(60).map(([id, row]) => contextRowString(id, row)).join("\n\n");
    }
    const systemPrompt = `You are a professional assistant for Sabah state government public-sector documents (OKF-RAG knowledge base). Your knowledge base comes from these role/state table rows:

${contextRows || "(no documents loaded yet)"}

Rules:
- Be courteous, professional, and helpful at all times.
- For greetings, small talk, or off-topic questions: respond naturally and politely in the user's language (reply in Bahasa Malaysia if the user writes in Malay); do NOT force knowledge-base content into conversational replies. If the user only greets you, reply with a warm greeting and ask how you can help; do not list or summarize any documents.
- For document questions: answer using the rows above. If no row is relevant, say so plainly; never invent or fabricate from partial fragments.
- When you use a row, briefly reference its source filename or row ID.
- Rely solely on the provided rows for document-specific facts; do not use outside knowledge for them.
- Format responses for readability, GPT-style: open with a short direct answer, use paragraphs for explanation, use bullet points when listing more than one fact or item, and **bold** key terms (department names, figures, addresses, document titles). Keep it concise with no filler.`;
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMsg }
    ];
    await streamOllama(res, messages, selectedModel);
    return;
  }

  // ---- fallback: respond with 404
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
  } catch (e) {
    console.error("Server error:", e.message);
    try { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); } catch {}
  }
});

// ---- Rebuild KB from source/ before accepting requests
const s = ingestSource();
server.listen(PORT, "127.0.0.1", () => {
  console.log(`OKF-RAG server running at http://127.0.0.1:${PORT}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Ingested source/: ${s.doc_count} docs -> ${s.row_count} rows`);
  console.log(`KB rows: ${Object.keys(_kb).length}`);
});
