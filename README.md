*Readme written by an LLM
*App mostly vibe-coded :)

# Textbook Tutor

Textbook Tutor is a local-first Socratic tutoring app that turns a `.tex`, `.txt`, or `.pdf` textbook into an interactive concept-based learning workspace.

The app ingests a textbook, extracts teachable concepts, organizes them into a concept hierarchy, evaluates concept-card quality with an LLM, and lets the user refine weak concept cards through single-card or batch refresh workflows.

## Features

- Upload `.tex`, `.txt`, or `.pdf` textbooks
- LLM-assisted textbook ingestion and concept extraction
- Recursive concept hierarchy for organizing textbook concepts
- Concept cards with textbook-grounded metadata
- LLM quality assessment for each concept card
- Refresh individual concept cards using QA feedback and optional user feedback
- Batch refresh concept cards by quality rank
- Load previously ingested textbooks
- Per-concept workspace for student notes and attempted explanations
- Socratic tutor panel grounded in the selected concept and retrieved textbook context
- Works with local OpenAI-compatible LLM servers such as LM Studio

## Project Structure

```text
client/
  src/
    App.jsx
    main.jsx
    styles.css

server/
  src/
    index.js
    services/
      ingestion.js
      llm.js
      tutor.js
  data/
    textbooks/
    uploads/
    workspaces/
```

## Requirements

- Node.js LTS
- npm
- An OpenAI-compatible LLM endpoint

For local use, LM Studio works well. Start the LM Studio server and use its local OpenAI-compatible endpoint.

## Setup

Install dependencies from the project root:

```bash
npm install
```

Create a server environment file:

```bash
cp server/.env.example server/.env
```

Example `.env` for LM Studio:

```env
OPENAI_BASE_URL=http://localhost:1234/v1
OPENAI_API_KEY=lm-studio

PORT=3001
CLIENT_ORIGIN=http://localhost:5173
```

If you want to pin a specific model, add:

```env
OPENAI_MODEL=your-model-id
```

## Run the App

From the project root:

```bash
npm run dev
```

Then open:

```text
http://localhost:5173
```

The backend runs at:

```text
http://localhost:3001
```

## Basic Workflow

1. Start your local LLM server.
2. Run the app with `npm run dev`.
3. Upload a textbook file.
4. Wait for ingestion and concept-card QA.
5. Select concepts from the navigator.
6. Use the workspace to write notes, attempted explanations, examples, or precise confusions.
7. Ask the tutor for hints, clarification, diagnosis, or understanding checks.
8. Refresh weak concept cards using QA feedback and optional user feedback.
9. Batch refresh concept cards by quality rank when needed.

## Concept Quality

Each concept card receives a quality score:

- `3`: well-formed concept card
- `2`: possibly not valuable
- `1`: probably not valuable

The UI uses these ratings to help identify which concept cards may need review or refresh.

## Refresh Workflows

### Single Concept Refresh

A selected concept card can be regenerated using:

- the current concept card,
- the original textbook context,
- the QA LLM feedback,
- and optional user feedback.

This is useful when a card is vague, poorly titled, incorrectly scoped, or missing useful instructional context.

### Batch Refresh

Concepts can also be refreshed in batches by quality rank. For example, you can refresh all concepts with quality `2`, optionally adding feedback that applies to the whole batch.

Use a small batch limit first, because each refreshed concept may require multiple LLM calls.

## Saved Textbooks

Ingested textbooks are saved under:

```text
server/data/textbooks/
```

The app can reload previously ingested textbooks from the saved textbook selector.

## Important Notes

- Do not commit `.env` files or API keys.
- Do not commit `node_modules/`.
- Ingested textbook data is stored in `server/data/`.
- Large textbooks may take time to ingest because concept extraction, QA, and refresh operations call the LLM multiple times.
- The app is an active prototype, not a production system.

## Recommended `.gitignore`

```gitignore
node_modules/
client/node_modules/
server/node_modules/

.env
server/.env
client/.env

server/data/
client/dist/
dist/

.DS_Store
Thumbs.db
```

## Status

This project is an active prototype. Current focus areas include improving textbook ingestion, concept hierarchy quality, concept-card refresh workflows, and Socratic tutoring behavior.
