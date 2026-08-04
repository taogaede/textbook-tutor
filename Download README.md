# Textbook Tutor

Textbook Tutor is a local-first Socratic tutoring app for learning from mathematical textbooks. It ingests a textbook file, extracts teachable concepts, organizes them into a navigable hierarchy, generates concept cards, supports LLM-assisted quality assessment and repair, and provides a textbook-grounded tutor panel.

The app is designed for local development with an OpenAI-compatible local LLM server such as LM Studio.

## Current Feature Set

### Textbook Ingestion

- Upload `.tex`, `.txt`, or `.pdf` textbook files.
- Extract text from uploaded sources.
- Detect textbook sections and TeX environments such as definitions, theorems, lemmas, propositions, examples, exercises, questions, and remarks.
- Use an LLM to extract structured concept cards from textbook excerpts.
- Fall back to rule-based extraction if LLM extraction is unavailable or weak.
- Preserve LaTeX notation in display text and tutor retrieval chunks.
- Save ingested textbooks locally under `server/data/textbooks/`.

### Concept Navigator

- Display extracted concepts in a recursive hierarchy.
- Use each concept's `hierarchyPath` to place it under chapter, section, subsection, or local topic groups.
- Search across concept titles, definitions, and prerequisites.
- Show quality indicators for assessed concept cards.

### Concept Cards

Each concept card can display and edit the following fields:

- Title
- Type
- Page or source label
- Textbook definition or excerpt
- Statement
- Why this matters
- Hierarchy path
- Prerequisites
- Depends on earlier in this section
- Key notation
- Useful examples
- Non-examples or boundary cases
- Common confusions
- Proof ideas
- Related results and nearby concepts
- How the textbook presents it
- References
- Concept card quality
- Refresh feedback

Concept card fields are collapsible so the UI remains compact even when cards contain rich metadata.

### Manual Concept Card Editing

- Expand any concept-card field.
- Click **Edit** to modify the field.
- Save individual edits back to the local textbook JSON.
- Edit string fields and list fields.
- Edit `hierarchyPath` to move a concept in the navigator.
- Persist edits across reloads.

### Concept Card Field Generation

- Expand a concept-card field.
- Click **Generate** to ask the local LLM to generate field-specific content.
- Generated content is intended to improve concept-card quality while staying grounded in the source textbook excerpt.
- String fields are appended with generated text.
- List fields are appended with generated items while avoiding duplicates.

### Concept Card Refresh

- Refresh the selected concept card using:
  - the current concept card,
  - the original source excerpt,
  - concept-card QA feedback,
  - and optional user feedback.
- The refreshed concept can update its title, definition, examples, notation, hierarchy placement, and other fields.
- After refresh, the concept hierarchy is rebuilt from the flat concept list.

### Batch Refresh

- Batch refresh concepts by quality rank.
- Choose quality rank `1`, `2`, or `3`.
- Set a maximum number of concepts to refresh.
- Provide optional batch feedback that applies to every refreshed concept.
- Rebuild the concept hierarchy after batch refresh.

### Concept Card QA

- Run LLM-based concept-card quality assessment.
- Quality scale:
  - `3`: Well-formed and valuable
  - `2`: Possibly not valuable
  - `1`: Probably not valuable
- Store QA rationale, issues, and suggested fixes.
- Re-run QA for the selected concept card.

### Socratic Tutor Panel

- Ask questions about the selected concept.
- Ask for hints, clarification, diagnosis, or understanding checks.
- Tutor responses are grounded in retrieved textbook chunks and the selected concept card.
- The tutor uses the student's workspace as evidence of current understanding.
- If the workspace demonstrates strong understanding, the tutor can explicitly say that the student appears to understand the concept well and then ask a deeper follow-up question.

### Student Workspace

- Each selected concept has a workspace where the student can write:
  - explanations,
  - attempted proofs,
  - examples,
  - non-examples,
  - or precise confusions.
- Save workspaces locally.
- Reload saved workspaces for a concept.

### LaTeX Rendering

- The frontend uses MathJax to typeset mathematical notation.
- Supports inline delimiters such as `\(...\)` and `$...$`.
- Supports display delimiters such as `\[...\]` and `$$...$$`.
- Concept-card fields and tutor messages are rendered through MathJax-aware components.
- Ingestion preserves TeX notation for display fields and retrieval chunks.

## Project Structure

```text
client/
  index.html
  package.json
  src/
    App.jsx
    main.jsx
    styles.css

server/
  package.json
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
- LM Studio or another OpenAI-compatible local LLM server
- A downloaded local model in LM Studio

## Installation

Clone the repository:

```bash
git clone https://github.com/taogaede/textbook-tutor.git
cd textbook-tutor
```

Install dependencies:

```bash
npm install
```

If your root package does not install workspace dependencies automatically, install client and server dependencies separately:

```bash
cd client
npm install
cd ../server
npm install
cd ..
```

## Environment Configuration

Create a server environment file:

```bash
cp server/.env.example server/.env
```

If `.env.example` does not exist yet, create this file manually:

```text
server/.env
```

Recommended local LM Studio configuration:

```env
OPENAI_BASE_URL=http://localhost:1234/v1
OPENAI_API_KEY=lm-studio
OPENAI_MODEL=your-loaded-model-id

PORT=3001
CLIENT_ORIGIN=http://localhost:5173
```

Notes:

- `OPENAI_BASE_URL` should point to LM Studio's OpenAI-compatible endpoint.
- `OPENAI_API_KEY` can usually be any non-empty string for local LM Studio use.
- `OPENAI_MODEL` should match the model identifier available from your LM Studio server. You can usually find it in the LM Studio server UI or by calling `/v1/models`.
- `PORT=3001` is the default backend port used by this project.
- `CLIENT_ORIGIN=http://localhost:5173` matches the Vite frontend development server.

## Setting Up LM Studio as the Local LLM

### 1. Install LM Studio

Download and install LM Studio from:

```text
https://lmstudio.ai/
```

Open LM Studio after installation.

### 2. Download a model

In LM Studio:

1. Open the model search or discover area.
2. Search for an instruction-tuned model.
3. Download a model that fits your hardware.

Suggested starting points:

- For lower-memory machines: a 3B or 7B instruct model with a 4-bit quantization.
- For stronger machines: a larger instruct model if you have enough RAM or VRAM.

The app benefits from models that are good at:

- structured JSON output,
- mathematical exposition,
- following detailed instructions,
- and preserving LaTeX notation.

### 3. Load the model

After downloading a model, load it in LM Studio. Make sure the model is available to the local server.

### 4. Start the local server

In LM Studio:

1. Open the **Developer** or **Server** tab.
2. Start the local API server.
3. Use the default port unless you have a conflict.

Recommended server URL:

```text
http://localhost:1234/v1
```

### 5. Verify the server

From a terminal, test the model list endpoint:

```bash
curl http://localhost:1234/v1/models
```

You should see a JSON response listing available or loaded models.

Then test chat completions:

```bash
curl http://localhost:1234/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-loaded-model-id",
    "messages": [
      {"role": "user", "content": "Say hello in one short sentence."}
    ],
    "temperature": 0.2
  }'
```

If that works, your local LLM endpoint is ready.

### 6. Set the model ID in `.env`

Set:

```env
OPENAI_MODEL=your-loaded-model-id
```

If in doubt, copy the model ID from the `/v1/models` response or from the LM Studio server UI.

### 7. Restart the app after changing `.env`

If the server is already running, stop it and restart it so the new environment variables are loaded.

## Running the App

From the repository root:

```bash
npm run dev
```

Then open:

```text
http://localhost:5173
```

The backend should run at:

```text
http://localhost:3001
```

If your root package does not run both apps together, start them in separate terminals:

Terminal 1:

```bash
cd server
npm run dev
```

Terminal 2:

```bash
cd client
npm run dev
```

## Recommended Workflow

### Ingest a textbook

1. Start LM Studio and the local server.
2. Start Textbook Tutor.
3. Upload a `.tex`, `.txt`, or `.pdf` textbook.
4. Wait for ingestion and QA.
5. Select a concept from the navigator.

### Study with the tutor

1. Select a concept.
2. Read the concept card.
3. Write your own explanation in the workspace.
4. Click **Check understanding** or ask a question in the tutor panel.
5. Revise your workspace based on the tutor's response.

### Improve concept cards

Use the concept-card repair loop:

1. Expand concept-card quality.
2. Review QA issues and suggested fixes.
3. Generate missing fields when useful.
4. Manually edit fields when needed.
5. Re-run QA.
6. Refresh the card if it needs a larger reconstruction.

### Batch repair low-quality concepts

1. Select a quality rank in the batch refresh panel.
2. Optionally provide batch feedback.
3. Set a safe limit.
4. Run batch refresh.
5. Review the updated concepts.

## Local Data Storage

The app stores local data under:

```text
server/data/
```

Typical subfolders:

```text
server/data/textbooks/
server/data/uploads/
server/data/workspaces/
```

Do not commit this folder unless you intentionally want to version local textbook data.

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

## Troubleshooting

### The tutor backend cannot reach the LLM

Check that LM Studio is running and that the server is started.

Verify:

```bash
curl http://localhost:1234/v1/models
```

Then check `server/.env`:

```env
OPENAI_BASE_URL=http://localhost:1234/v1
OPENAI_API_KEY=lm-studio
OPENAI_MODEL=your-loaded-model-id
```

Restart the backend after changing `.env`.

### Ingestion fails or produces weak concepts

Try:

- using a stronger instruction-tuned model,
- increasing local model context length in LM Studio,
- uploading a smaller textbook excerpt first,
- refreshing poor concept cards,
- or batch refreshing quality rank `1` or `2` cards.

### JSON parse errors from the LLM

The app includes JSON repair logic, but local models can still return malformed JSON.

Try:

- lowering temperature,
- using a model with better instruction-following ability,
- shortening the input textbook excerpt,
- or retrying ingestion/refresh.

### LaTeX does not render

Check that the text uses supported delimiters:

```tex
\( inline math \)
\[ display math \]
```

Also verify that `better-react-mathjax` is installed in the client.

### Generated field content does not appear

Check that the backend saves generated content into the requested field name, not into a generic `updatedValue` property. For example, generating **Why this matters** should update `teachingRole`.

### Editing saves fail

The frontend must send PATCH updates using the actual field name:

```js
updates: {
  [field]: value
}
```

The backend only accepts known editable fields.

## Development Notes

This project is an active prototype. It is optimized for experimentation and local workflows rather than production deployment.

Important current design choices:

- The flat `concepts` array is the source of truth.
- The visible navigator tree is rebuilt from `concepts` using `hierarchyPath`.
- Concept card refresh and manual edits update the flat concept list, then rebuild the hierarchy.
- Local LLM output is treated as useful but fallible and can be repaired through QA, refresh, generation, and manual editing.

## Security Notes

- Do not commit `.env` files.
- Do not commit API keys.
- Do not expose the LM Studio server to a public network.
- If binding LM Studio to `0.0.0.0` for local network access, use firewall rules and network controls.
- Be careful with copyrighted or private textbook content stored under `server/data/`.

## Status

Textbook Tutor currently supports a full local learning workflow:

```text
Upload textbook
→ Extract concepts
→ Build hierarchy
→ Assess concept-card quality
→ Study selected concept
→ Ask Socratic tutor questions
→ Edit or generate concept card fields
→ Refresh weak cards
→ Re-run QA
→ Save workspaces
```

The next likely improvements are:

- safer generate-preview-accept workflow,
- concept deletion and undo/history,
- source excerpt viewer,
- textbook macro support for custom LaTeX commands,
- better duplicate concept detection,
- and project-level export/import.
