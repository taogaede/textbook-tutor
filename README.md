# Textbook Tutor

Textbook Tutor is a local-first Socratic tutoring app that turns a `.tex`, `.txt`, or `.pdf` textbook into an interactive concept-based learning workspace.

The app ingests a textbook, extracts teachable concepts, builds a concept hierarchy, evaluates concept-card quality with an LLM, and lets the user refine weak concept cards through single-card or batch refresh workflows.

## Features

- Upload `.tex`, `.txt`, or `.pdf` textbooks
- LLM-assisted concept extraction
- Recursive concept hierarchy for organizing textbook concepts
- Concept cards with definitions, prerequisites, examples, confusions, and source references
- LLM quality assessment for each concept card
- Refresh individual concept cards using QA feedback and user feedback
- Batch refresh concepts by quality rank
- Saved textbook loading
- Per-concept workspace for student notes
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