import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ingestTextbook,
  refreshConceptCard,
  refreshConceptsByQuality,
  updateConceptCardFields,
  rerunConceptQualityAssessment,
  generateConceptCardField,
} from "./services/ingestion.js";
import { makeTutorResponse } from "./services/tutor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const textbookDir = path.join(dataDir, "textbooks");
const workspaceDir = path.join(dataDir, "workspaces");
const uploadDir = path.join(dataDir, "uploads");

await fs.mkdir(textbookDir, { recursive: true });
await fs.mkdir(workspaceDir, { recursive: true });
await fs.mkdir(uploadDir, { recursive: true });

const app = express();
const port = Number(process.env.PORT || 3001);
const clientOrigin = process.env.CLIENT_ORIGIN || "http://localhost:5173";

app.use(cors({ origin: clientOrigin }));
app.use(express.json({ limit: "4mb" }));

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(pdf|tex|txt)$/i.test(file.originalname);
    cb(ok ? null : new Error("Only .pdf, .tex, and .txt files are supported."), ok);
  },
});

async function listSavedTextbooks() {
  await fs.mkdir(textbookDir, { recursive: true });

  const entries = await fs.readdir(textbookDir, { withFileTypes: true });
  const textbooks = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const textbookJsonPath = path.join(textbookDir, entry.name, "textbook.json");

    try {
      const saved = JSON.parse(await fs.readFile(textbookJsonPath, "utf8"));

      textbooks.push({
        id: saved.textbook.id,
        title: saved.textbook.title,
        originalName: saved.textbook.originalName || "",
        createdAt: saved.textbook.createdAt || "",
        conceptCount: saved.concepts?.length || 0,
        chunkCount: saved.chunks?.length || 0,
      });
    } catch {
      // Ignore incomplete or corrupted textbook folders.
    }
  }

  textbooks.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  return textbooks;
}

async function loadSavedTextbookById(id) {
  const textbookId = safeId(id);
  const textbookJsonPath = path.join(textbookDir, textbookId, "textbook.json");

  const saved = JSON.parse(await fs.readFile(textbookJsonPath, "utf8"));

  return {
    textbook: saved.textbook,
    conceptCount: saved.concepts?.length || 0,
    chunkCount: saved.chunks?.length || 0,
  };
}

function safeId(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 160);
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, app: "Textbook Socratic Tutor", llmConfigured: Boolean(process.env.OPENAI_API_KEY) });
});

app.post("/api/textbooks", upload.single("textbook"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No textbook file uploaded." });
    const result = await ingestTextbook({ file: req.file, textbookDir });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/textbooks", async (_req, res, next) => {
  try {
    const textbooks = await listSavedTextbooks();
    res.json({ textbooks });
  } catch (error) {
    next(error);
  }
});

app.get("/api/textbooks/:id", async (req, res, next) => {
  try {
    const result = await loadSavedTextbookById(req.params.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/textbooks/:textbookId/concepts/:conceptId/refresh", async (req, res, next) => {
  try {
    const textbookId = safeId(req.params.textbookId);
    const conceptId = safeId(req.params.conceptId);

    const result = await refreshConceptCard({
      textbookDir,
      textbookId,
      conceptId,
      userFeedback: req.body?.feedback || "",
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/textbooks/:textbookId/concepts/batch-refresh", async (req, res, next) => {
  try {
    const textbookId = safeId(req.params.textbookId);

    const result = await refreshConceptsByQuality({
      textbookDir,
      textbookId,
      quality: req.body?.quality,
      userFeedback: req.body?.feedback || "",
      limit: req.body?.limit || 50,
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/textbooks/:textbookId/concepts/:conceptId", async (req, res, next) => {
  try {
    const textbookId = safeId(req.params.textbookId);
    const conceptId = safeId(req.params.conceptId);

    const result = await updateConceptCardFields({
      textbookDir,
      textbookId,
      conceptId,
      updates: req.body?.updates || {},
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/textbooks/:textbookId/concepts/:conceptId/rerun-qa", async (req, res, next) => {
  try {
    const textbookId = safeId(req.params.textbookId);
    const conceptId = safeId(req.params.conceptId);

    const result = await rerunConceptQualityAssessment({
      textbookDir,
      textbookId,
      conceptId,
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/textbooks/:textbookId/concepts/:conceptId/fields/:field/generate", async (req, res, next) => {
  try {
    const textbookId = safeId(req.params.textbookId);
    const conceptId = safeId(req.params.conceptId);
    const field = String(req.params.field || "").trim();

    const result = await generateConceptCardField({
      textbookDir,
      textbookId,
      conceptId,
      field,
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});


app.post("/api/tutor", async (req, res, next) => {
  try {
    const response = await makeTutorResponse({ body: req.body, textbookDir });
    res.json(response);
  } catch (error) {
    next(error);
  }
});

app.post("/api/workspaces", async (req, res, next) => {
  try {
    const textbookId = safeId(req.body.textbookId || "demo");
    const conceptId = safeId(req.body.conceptId || "unknown");
    const file = path.join(workspaceDir, `${textbookId}_${conceptId}.json`);
    const payload = {
      textbookId,
      conceptId,
      workspace: req.body.workspace || "",
      learningState: req.body.learningState || {},
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(file, JSON.stringify(payload, null, 2));
    res.json({ ok: true, workspace: payload });
  } catch (error) {
    next(error);
  }
});

app.get("/api/workspaces/:textbookId/:conceptId", async (req, res, next) => {
  try {
    const textbookId = safeId(req.params.textbookId);
    const conceptId = safeId(req.params.conceptId);
    const file = path.join(workspaceDir, `${textbookId}_${conceptId}.json`);
    const json = JSON.parse(await fs.readFile(file, "utf8"));
    res.json(json);
  } catch (error) {
    if (error.code === "ENOENT") return res.json({ workspace: "", learningState: {} });
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message || "Internal server error" });
});

app.listen(port, () => {
  console.log(`Textbook tutor server running on http://localhost:${port}`);
});
