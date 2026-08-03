# Textbook Socratic Tutor

A local full-stack prototype for textbook-grounded Socratic tutoring.

The app lets you upload a `.tex`, `.txt`, or `.pdf` textbook, extracts a concept navigator, gives you a per-concept workspace, retrieves relevant source excerpts, and returns Socratic tutor responses. It runs without an LLM API key using a deterministic local tutoring fallback. If you add an OpenAI-compatible API key, the tutoring responses become model-generated while still using retrieved textbook context.

## Requirements

Install Node.js LTS from <https://nodejs.org/>.

Check that Node and npm are available:

```bash
node -v
npm -v
```

## Quick start

From this folder, run:

```bash
npm install
npm run dev
```

Then open:

```text
http://localhost:5173
```

The backend runs on:

```text
http://localhost:3001
```

## Optional LLM setup

The app works without an API key. To use a real LLM, create this file:

```text
server/.env
```

Copy from:

```text
server/.env.example
```

Then set values such as:

```bash
OPENAI_API_KEY=your_api_key_here
OPENAI_MODEL=gpt-4o-mini
OPENAI_BASE_URL=https://api.openai.com/v1
PORT=3001
CLIENT_ORIGIN=http://localhost:5173
```

You can also point `OPENAI_BASE_URL` to an OpenAI-compatible local server.

## What is included

```text
client/
  Vite React app
  Concept navigator
  Workspace
  Tutor panel
  Learning-state panel

server/
  Express API
  PDF, TeX, and TXT upload
  Text extraction
  Simple concept extraction
  Local retrieval
  Optional OpenAI-compatible LLM integration
  File-based persistence for textbook data and workspaces
```

## Supported uploads

- `.tex`: best support. The parser detects section commands and environments such as `definition`, `theorem`, `lemma`, `example`, and `exercise`.
- `.txt`: supported through heading and paragraph heuristics.
- `.pdf`: supported through text extraction. Mathematical layout may be imperfect because PDF extraction depends on the source PDF encoding.

## Useful commands

Run both frontend and backend:

```bash
npm run dev
```

Run only the server:

```bash
npm run dev -w server
```

Run only the client:

```bash
npm run dev -w client
```

Build the client:

```bash
npm run build -w client
```

## Notes

This is an MVP, not a finished commercial product. The concept extraction and retrieval are deliberately simple so that you can inspect and modify them easily. The next engineering steps would be a proper parser for mathematical documents, a stronger retrieval layer, authentication, a database, and deployment packaging.
