import { callLocalLLM, parseJsonFromLLM, repairJsonWithLLM } from "./llm.js";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import pdfParse from "pdf-parse";

function slugify(value) {
  return String(value || "concept")
    .toLowerCase()
    .replace(/\\[a-z]+\*?/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "concept";
}

function titleFromFilename(filename) {
  return path.basename(filename, path.extname(filename)).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

async function extractText(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const buffer = await fs.readFile(file.path);
  if (ext === ".pdf") {
    const parsed = await pdfParse(buffer);
    return parsed.text || "";
  }
  return buffer.toString("utf8");
}

function cleanText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractTeXBlocks(text) {
  const blocks = [];
  const envPattern = /\\begin\{(definition|theorem|proposition|lemma|corollary|example|exercise|ex|question|eg|remark)\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{\1\}/gi;
  let match;
  while ((match = envPattern.exec(text))) {
    blocks.push({
	  type: match[1],
	  content: cleanTeXForDisplay(match[2]),
	  plainContent: cleanInlineTeX(match[2]),
	  index: match.index,
	});
  }
  return blocks;
}

function cleanInlineTeX(text) {
  return String(text || "")
    .replace(/%.*$/gm, "")
    .replace(/\\label\{[^}]+\}/g, "")
    .replace(/\\ref\{([^}]+)\}/g, "$1")
    .replace(/\\cite\{[^}]+\}/g, "")
    .replace(/\\emph\{([^}]*)\}/g, "$1")
    .replace(/\\textbf\{([^}]*)\}/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/\\/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTeXForDisplay(text) {
  let output = String(text || "")
    .split("\n")
    .map((line) => {
      const percentIndex = line.indexOf("%");
      return percentIndex === -1 ? line : line.slice(0, percentIndex);
    })
    .join("\n")
    .replace(/\\label\{[^}]+\}/g, "")
    .replace(/\\cite\{[^}]+\}/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();

  while (output.includes("\n\n\n")) {
    output = output.replaceAll("\n\n\n", "\n\n");
  }

  return output;
}

function extractTexPreamble(text) {
  const raw = String(text || "");
  const beginDocument = raw.indexOf("\\begin{document}");

  if (beginDocument === -1) {
    return "";
  }

  return raw.slice(0, beginDocument);
}

function stripTexComments(text) {
  return String(text || "")
    .split("\n")
    .map((line) => {
      const percentIndex = line.indexOf("%");
      return percentIndex === -1 ? line : line.slice(0, percentIndex);
    })
    .join("\n");
}

function parseBalancedBraceContent(text, openBraceIndex) {
  if (text[openBraceIndex] !== "{") return null;

  let depth = 0;

  for (let i = openBraceIndex; i < text.length; i++) {
    const char = text[i];
    const previous = i > 0 ? text[i - 1] : "";

    if (char === "{" && previous !== "\\") {
      depth += 1;
    }

    if (char === "}" && previous !== "\\") {
      depth -= 1;

      if (depth === 0) {
        return {
          content: text.slice(openBraceIndex + 1, i),
          endIndex: i + 1,
        };
      }
    }
  }

  return null;
}

function parseNewCommandLike(preamble, commandName) {
  const macros = {};
  const marker = `\\${commandName}`;
  let index = 0;

  while (index < preamble.length) {
    const start = preamble.indexOf(marker, index);

    if (start === -1) break;

    let cursor = start + marker.length;

    while (/\s/.test(preamble[cursor] || "")) cursor += 1;

    if (preamble[cursor] !== "{") {
      index = cursor + 1;
      continue;
    }

    const nameBlock = parseBalancedBraceContent(preamble, cursor);

    if (!nameBlock) {
      index = cursor + 1;
      continue;
    }

    const macroName = String(nameBlock.content || "").replace(/^\\/, "").trim();

    cursor = nameBlock.endIndex;

    while (/\s/.test(preamble[cursor] || "")) cursor += 1;

    let argCount = 0;

    if (preamble[cursor] === "[") {
      const close = preamble.indexOf("]", cursor + 1);

      if (close !== -1) {
        argCount = Number(preamble.slice(cursor + 1, close).trim()) || 0;
        cursor = close + 1;
      }
    }

    while (/\s/.test(preamble[cursor] || "")) cursor += 1;

    if (preamble[cursor] !== "{") {
      index = cursor + 1;
      continue;
    }

    const bodyBlock = parseBalancedBraceContent(preamble, cursor);

    if (!bodyBlock) {
      index = cursor + 1;
      continue;
    }

    if (macroName) {
      macros[macroName] =
        argCount > 0
          ? [bodyBlock.content.trim(), argCount]
          : bodyBlock.content.trim();
    }

    index = bodyBlock.endIndex;
  }

  return macros;
}

function parseDeclareMathOperator(preamble) {
  const macros = {};
  const marker = "\\DeclareMathOperator";
  let index = 0;

  while (index < preamble.length) {
    const start = preamble.indexOf(marker, index);

    if (start === -1) break;

    let cursor = start + marker.length;

    while (/\s/.test(preamble[cursor] || "")) cursor += 1;

    if (preamble[cursor] === "*") {
      cursor += 1;
      while (/\s/.test(preamble[cursor] || "")) cursor += 1;
    }

    if (preamble[cursor] !== "{") {
      index = cursor + 1;
      continue;
    }

    const nameBlock = parseBalancedBraceContent(preamble, cursor);

    if (!nameBlock) {
      index = cursor + 1;
      continue;
    }

    const macroName = String(nameBlock.content || "").replace(/^\\/, "").trim();

    cursor = nameBlock.endIndex;

    while (/\s/.test(preamble[cursor] || "")) cursor += 1;

    if (preamble[cursor] !== "{") {
      index = cursor + 1;
      continue;
    }

    const opBlock = parseBalancedBraceContent(preamble, cursor);

    if (!opBlock) {
      index = cursor + 1;
      continue;
    }

    if (macroName) {
      macros[macroName] = `\\operatorname{${opBlock.content.trim()}}`;
    }

    index = opBlock.endIndex;
  }

  return macros;
}

function extractUsePackages(preamble) {
  const packages = [];
  const pattern = /\\usepackage(?:\[[^\]]+\])?\{([^}]+)\}/g;
  let match;

  while ((match = pattern.exec(preamble))) {
    const names = String(match[1] || "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);

    packages.push(...names);
  }

  return packages;
}

function mapLatexPackagesToMathJax(packages) {
  const packageMap = {
    amsmath: "ams",
    amssymb: "ams",
    amsfonts: "ams",
    mathtools: "mathtools",
    physics: "physics",
    cancel: "cancel",
    braket: "braket",
    mhchem: "mhchem",
    color: "color",
    xcolor: "color",
    textcomp: "textcomp",
    upgreek: "upgreek",
    unicode: "unicode",
    bbox: "bbox",
    enclose: "enclose",
    extpfeil: "extpfeil",
    gensymb: "gensymb",
  };

  const supported = [];
  const unsupported = [];

  for (const latexPackage of packages) {
    const mapped = packageMap[latexPackage];

    if (mapped) {
      supported.push(mapped);
    } else {
      unsupported.push(latexPackage);
    }
  }

  return {
    packages: Array.from(new Set(supported)),
    unsupportedPackages: Array.from(new Set(unsupported)),
  };
}

function extractMathJaxMetadata(text, originalName = "") {
  const isTexFile = String(originalName || "").toLowerCase().endsWith(".tex");
  const texPreamble = isTexFile ? extractTexPreamble(text) : "";
  const cleanPreamble = stripTexComments(texPreamble);

  const macros = {
    ...parseNewCommandLike(cleanPreamble, "newcommand"),
    ...parseNewCommandLike(cleanPreamble, "renewcommand"),
    ...parseDeclareMathOperator(cleanPreamble),
  };

  const latexPackages = extractUsePackages(cleanPreamble);
  const packageInfo = mapLatexPackagesToMathJax(latexPackages);

  return {
    texPreamble,
    mathJax: {
      macros,
      packages: packageInfo.packages,
      unsupportedPackages: packageInfo.unsupportedPackages,
    },
  };
}

function extractTexBodyForIngestion(text, originalName = "") {
  const isTexFile = String(originalName || "").toLowerCase().endsWith(".tex");
  const raw = String(text || "");

  if (!isTexFile) {
    return raw;
  }

  const beginDocument = raw.indexOf("\\begin{document}");

  let body =
    beginDocument === -1
      ? raw
      : raw.slice(beginDocument + "\\begin{document}".length);

  const endDocument = body.lastIndexOf("\\end{document}");

  if (endDocument !== -1) {
    body = body.slice(0, endDocument);
  }

  return body.trim();
}

function detectSections(text) {
  const texSectionPattern = /\\(chapter|section|subsection|subsubsection)\*?\{([^}]+)\}/g;
  const sections = [];
  let match;
  while ((match = texSectionPattern.exec(text))) {
    sections.push({ level: match[1], title: cleanInlineTeX(match[2]), index: match.index });
  }

  if (sections.length > 0) return sections;

  const lines = text.split("\n");
  let offset = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(chapter\s+\d+|\d+(\.\d+)*\s+)[A-Z]/i.test(trimmed) || (/^[A-Z][A-Za-z0-9 ,:;-]{3,80}$/.test(trimmed) && trimmed.length < 90)) {
      sections.push({ level: "section", title: trimmed, index: offset });
    }
    offset += line.length + 1;
  }
  return sections.length ? sections : [{ level: "section", title: "Extracted Text", index: 0 }];
}

function findSectionForIndex(sections, index) {
  let current = sections[0];
  for (const section of sections) {
    if (section.index <= index) current = section;
    else break;
  }
  return current || { title: "Extracted Text", level: "section" };
}

function sentenceTitle(content, fallback) {
  const first = content.split(/[.!?]/)[0].trim();
  if (first.length > 8 && first.length < 70) return first;
  const termMatch = content.match(/(?:called|is called|defined as|definition of)\s+([A-Za-z][A-Za-z0-9\s-]{2,40})/i);
  if (termMatch) return termMatch[1].trim();
  return fallback;
}

function conceptFromBlock(block, number, section) {
  const type = block.type.charAt(0).toUpperCase() + block.type.slice(1).toLowerCase();
  const inferredTitle = sentenceTitle(block.plainContent || block.content, `${type} ${number}`);
  const id = `${slugify(inferredTitle)}-${number}`;
  const definition = block.content.slice(0, 1400);
  return {
	id,
	title: inferredTitle,
	type,
	section: section.title,
	hierarchyPath: [section.title],
	page: section.title,
	definition,
	prerequisites: [],
	examples: type === "Example" ? [definition.slice(0, 160)] : [],
	references: [`${type} near ${section.title}`],
	sourceStart: block.index,
  };
}

function conceptsFromSections(text, sections) {
  const concepts = [];
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const next = sections[i + 1]?.index ?? text.length;
    const body = cleanTeXForDisplay(text.slice(section.index, next)).slice(0, 1400);
    if (body.length < 40) continue;
    concepts.push({
		id: `${slugify(section.title)}-${i + 1}`,
		title: section.title,
		type: section.level === "chapter" ? "Chapter" : "Section",
		section: section.title,
		hierarchyPath: [section.title],
		page: section.title,
		definition: body,
		prerequisites: [],
		examples: [],
		references: [section.title],
		sourceStart: section.index,
	});
  }
  return concepts;
}

function buildConceptHierarchy(concepts) {
  const root = [];

  function findOrCreateGroup(nodes, title, depth, parentPath) {
    const groupKey = [...parentPath, title].join(" / ");
    let group = nodes.find(
      (node) => node.nodeKind === "group" && node.groupKey === groupKey
    );

    if (!group) {
      group = {
        id: `${slugify(title)}-${depth}-${slugify(groupKey)}`,
        title,
        groupKey,
        nodeKind: "group",
        type: "group",
        children: [],
      };

      nodes.push(group);
    }

    return group;
  }

  for (const concept of concepts) {
    const rawPath =
      Array.isArray(concept.hierarchyPath) && concept.hierarchyPath.length > 0
        ? concept.hierarchyPath
        : [concept.section || "Extracted Text"];

    const path = rawPath
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 4);

    let currentChildren = root;
    const parentPath = [];

    for (let depth = 0; depth < path.length; depth++) {
      const title = path[depth];
      const group = findOrCreateGroup(currentChildren, title, depth + 1, parentPath);
      parentPath.push(title);
      currentChildren = group.children;
    }

    currentChildren.push({
      ...concept,
      nodeKind: "concept",
      children: [],
    });
  }

  return root;
}

function chunkText(text, concepts) {
  const paragraphs = text
    .split("\n\n")
    .map((p) => cleanTeXForDisplay(p))
    .filter((p) => p.length > 40);

  const chunks = [];
  let current = "";
  let chunkIndex = 0;
  for (const paragraph of paragraphs) {
    if ((current + "\n\n" + paragraph).length > 1400 && current) {
      chunks.push(makeChunk(current, chunkIndex++, concepts));
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push(makeChunk(current, chunkIndex++, concepts));
  return chunks;
}

function makeChunk(content, index, concepts) {
  const concept = concepts.find((c) => content.toLowerCase().includes(c.title.toLowerCase().slice(0, 24))) || concepts[index % Math.max(concepts.length, 1)];
  return {
    id: `chunk-${String(index + 1).padStart(4, "0")}`,
    conceptId: concept?.id || "general",
    title: concept?.title || "General textbook excerpt",
    reference: concept?.references?.[0] || `Chunk ${index + 1}`,
    content,
  };
}

function splitTextForLLM(text, sections) {
  const blocks = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const next = sections[i + 1]?.index ?? text.length;
    const raw = text.slice(section.index, next).trim();

    if (raw.length < 80) continue;

    blocks.push({
      sectionTitle: section.title,
      sectionLevel: section.level,
      text: raw.slice(0, 4500),
      index: section.index,
    });
  }

  if (blocks.length === 0) {
    const maxBlockSize = 4500;
    for (let i = 0; i < text.length; i += maxBlockSize) {
      blocks.push({
        sectionTitle: `Text excerpt ${Math.floor(i / maxBlockSize) + 1}`,
        sectionLevel: "section",
        text: text.slice(i, i + maxBlockSize),
        index: i,
      });
    }
  }

  return blocks;
}

function chunkArray(items, size) {
  const chunks = [];
  const safeItems = Array.isArray(items) ? items : [];
  const safeSize = Math.max(1, Number(size) || 1);

  for (let i = 0; i < safeItems.length; i += safeSize) {
    chunks.push(safeItems.slice(i, i + safeSize));
  }

  return chunks;
}

function sourceEvidenceChunks(text, sections, maxChunkSize = 2600) {
  const chunks = [];
  let chunkNumber = 1;

  function sectionForOffset(offset) {
    return findSectionForIndex(sections, offset);
  }

  const normalized = String(text || "");
  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  let current = "";
  let currentStart = 0;

  for (const paragraph of paragraphs) {
    const paragraphIndex = normalized.indexOf(paragraph, currentStart);
    const startIndex = paragraphIndex === -1 ? currentStart : paragraphIndex;

    if ((current + "\n\n" + paragraph).length > maxChunkSize && current.trim()) {
      const section = sectionForOffset(currentStart);

      chunks.push({
        id: `source-${String(chunkNumber++).padStart(4, "0")}`,
        sectionTitle: section?.title || "Extracted Text",
        sectionLevel: section?.level || "section",
        index: currentStart,
        content: cleanTeXForDisplay(current).slice(0, maxChunkSize + 500),
      });

      current = paragraph;
      currentStart = startIndex;
    } else {
      if (!current) {
        currentStart = startIndex;
      }

      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }

  if (current.trim()) {
    const section = sectionForOffset(currentStart);

    chunks.push({
      id: `source-${String(chunkNumber++).padStart(4, "0")}`,
      sectionTitle: section?.title || "Extracted Text",
      sectionLevel: section?.level || "section",
      index: currentStart,
      content: cleanTeXForDisplay(current).slice(0, maxChunkSize + 500),
    });
  }

  return chunks;
}

const canonicalConceptDiscoverySystemPrompt = `
You are an expert mathematics educator building a conceptual mind map from a textbook.

Your task is to identify canonical mathematical concepts that should become concept cards in a learning app. Do not merely extract the local order of the textbook. Instead, identify concepts that represent important mathematical ideas across the whole text.

Return JSON only. Do not include markdown. Do not include commentary outside the JSON.

Use exactly this schema:

{
  "canonicalConcepts": [
    {
      "title": "string",
      "type": "Definition | Theorem | Lemma | Proposition | Corollary | Example | Exercise | Question | Concept | Technique | Proof Strategy | Notation | Assumption",
      "hierarchyPath": ["string"],
      "aliases": ["string"],
      "conceptualRole": "string",
      "searchTerms": ["string"],
      "relatedConceptTitles": ["string"],
      "references": ["string"]
    }
  ]
}

Rules:
- Identify canonical concepts, not every local mention.
- Prefer concepts that a student would intentionally select in a conceptual navigator.
- Organize concepts by mathematical meaning, not by page, chapter, section, or local order.
- Good hierarchy labels include mathematical objects, structures, maps, invariants, theorem families, proof techniques, examples, notation families, and applications.
- A concept about vector spaces should be grouped conceptually with vector spaces, subspaces, bases, dimension, linear maps, quotient spaces, and related structure when appropriate.
- A concept about kernels should be grouped with linear maps, image, rank-nullity, and related ideas when appropriate.
- A concept about bases should be grouped with span, linear independence, coordinates, and dimension when appropriate.
- hierarchyPath should contain 1 to 4 labels.
- Do not include the concept title itself as the final hierarchyPath label unless it is genuinely a broad category.
- aliases should include textbook terminology and common alternate names.
- searchTerms should include words, phrases, and notation useful for finding source evidence for this concept.
- references should include local section titles, theorem labels, definition labels, or nearby headings when available.
- Preserve TeX notation when useful.
- Because this is JSON, every TeX backslash must be escaped as a double backslash.
- Return strictly valid JSON parseable by JSON.parse.
`;

function sourceChunkSummaryForDiscovery(chunk) {
  return {
    id: chunk.id,
    sectionTitle: chunk.sectionTitle,
    sectionLevel: chunk.sectionLevel,
    content: String(chunk.content || "").slice(0, 1800),
  };
}

function looksLikeTexMacroArtifact(value) {
  const compact = String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "");

  return (
    compact.includes("@ifstar") ||
    compact.includes("ifstarstar") ||
    compact.includes("sectionboldsection") ||
    compact.includes("documentclass") ||
    compact.includes("usepackage") ||
    compact.includes("newcommand") ||
    compact.includes("renewcommand") ||
    compact.includes("declaremathoperator")
  );
}

function normalizeHierarchyPathForConceptMap(value, fallback = ["Concept Map"]) {
  const path = Array.isArray(value)
    ? value
        .map(String)
        .map((item) => item.trim())
        .filter(Boolean)
        .filter((item) => !looksLikeTexMacroArtifact(item))
        .slice(0, 4)
    : [];

  return path.length > 0 ? path : fallback;
}

function normalizeCanonicalConcept(raw, number) {
  const title = String(raw?.title || `Concept ${number}`).trim();

  if (!title) return null;

  const hierarchyPath = normalizeHierarchyPathForConceptMap(
    raw?.hierarchyPath,
    ["Concept Map"]
  );

  return {
    inventoryId: `${slugify(title)}-${number}`,
    title,
    type: String(raw?.type || "Concept").trim(),
    hierarchyPath: hierarchyPath.length ? hierarchyPath : ["Concept Map"],
    aliases: normalizeStringArray(raw?.aliases, 10),
    conceptualRole: String(raw?.conceptualRole || "").trim().slice(0, 800),
    searchTerms: normalizeStringArray(raw?.searchTerms, 16),
    relatedConceptTitles: normalizeStringArray(raw?.relatedConceptTitles, 16),
    references: normalizeStringArray(raw?.references, 10),
  };
}

function dedupeCanonicalConcepts(concepts, limit = 90) {
  const seen = new Set();
  const deduped = [];

  for (const concept of concepts) {
    const key = slugify(concept.title);

    if (!key || seen.has(key)) continue;

    seen.add(key);
    deduped.push(concept);

    if (deduped.length >= limit) break;
  }

  return deduped;
}

async function identifyCanonicalConceptsForChunkBatch({
  chunkBatch,
  batchNumber,
}) {
  const user = `
Textbook source excerpts, batch ${batchNumber}:
${JSON.stringify(chunkBatch.map(sourceChunkSummaryForDiscovery), null, 2).slice(0, 24000)}

Identify canonical concepts represented in this batch. Focus on concepts that should exist in a global concept map, not merely local section order.
`;

  const response = await callLocalLLM({
    system: canonicalConceptDiscoverySystemPrompt,
    user,
    temperature: 0.1,
    maxTokens: 5000,
    jsonMode: true,
  });

  if (!response) {
    throw new Error("No LLM is configured for canonical concept discovery.");
  }

  let parsed;

  try {
    parsed = parseJsonFromLLM(response);
  } catch (error) {
    console.warn(`Initial canonical concept JSON parse failed for batch ${batchNumber}. Asking LLM to repair JSON...`);

    const repaired = await repairJsonWithLLM({
      brokenJson: response,
      parseError: error.message,
    });

    parsed = parseJsonFromLLM(repaired);
  }

  return Array.isArray(parsed?.canonicalConcepts)
    ? parsed.canonicalConcepts
    : [];
}

async function identifyCanonicalConceptsWithLLM({ chunks }) {
  const batches = chunkArray(chunks, 12);
  const candidates = [];

  for (let i = 0; i < batches.length; i++) {
    try {
      const rawConcepts = await identifyCanonicalConceptsForChunkBatch({
        chunkBatch: batches[i],
        batchNumber: i + 1,
      });

      for (const raw of rawConcepts) {
        const normalized = normalizeCanonicalConcept(raw, candidates.length + 1);

        if (normalized) {
          candidates.push(normalized);
        }
      }
    } catch (error) {
      console.warn(`Canonical concept discovery failed for batch ${i + 1}:`, error.message);
    }
  }

  return dedupeCanonicalConcepts(candidates, 90);
}

function lowerPlainText(value) {
  return cleanInlineTeX(value)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function searchTermsForCanonicalConcept(canonicalConcept) {
  return [
    canonicalConcept.title,
    ...(canonicalConcept.aliases || []),
    ...(canonicalConcept.searchTerms || []),
    ...(canonicalConcept.relatedConceptTitles || []),
  ]
    .map(String)
    .map((term) => term.trim())
    .filter(Boolean);
}

function scoreEvidenceChunkForConcept(chunk, canonicalConcept) {
  const content = lowerPlainText(chunk.content);
  const sectionTitle = lowerPlainText(chunk.sectionTitle);
  const terms = searchTermsForCanonicalConcept(canonicalConcept);

  let score = 0;

  for (const term of terms) {
    const plainTerm = lowerPlainText(term);

    if (!plainTerm || plainTerm.length < 2) continue;

    if (content.includes(plainTerm)) {
      score += plainTerm.length > 10 ? 5 : 3;
    }

    if (sectionTitle.includes(plainTerm)) {
      score += 4;
    }

    const words = plainTerm
      .split(/\s+/)
      .map((word) => word.trim())
      .filter((word) => word.length > 4);

    for (const word of words) {
      if (content.includes(word)) {
        score += 1;
      }
    }
  }

  return score;
}

function findEvidenceForCanonicalConcept({
  canonicalConcept,
  chunks,
  limit = 10,
}) {
  const scored = chunks
    .map((chunk) => ({
      chunk,
      score: scoreEvidenceChunkForConcept(chunk, canonicalConcept),
    }))
    .sort((a, b) => b.score - a.score);

  const positive = scored
    .filter((item) => item.score > 0)
    .slice(0, limit)
    .map((item) => item.chunk);

  if (positive.length > 0) {
    return positive;
  }

  return chunks.slice(0, Math.min(limit, chunks.length));
}

const canonicalConceptSynthesisSystemPrompt = `
You are an expert mathematics educator synthesizing one canonical concept card from textbook evidence.

The concept card should represent the concept globally across the textbook, not merely the first local mention. Use the evidence excerpts to identify the definition, role, examples, notation, relationships, common confusions, and proof ideas.

Return JSON only. Do not include markdown. Do not include commentary outside the JSON.

Use exactly this schema:

{
  "title": "string",
  "type": "Definition | Theorem | Lemma | Proposition | Corollary | Example | Exercise | Question | Concept | Technique | Proof Strategy | Notation | Assumption",
  "hierarchyPath": ["string"],
  "definition": "string",
  "statement": "string",
  "teachingRole": "string",
  "prerequisites": ["string"],
  "dependsOnEarlierInExcerpt": ["string"],
  "examples": ["string"],
  "nonExamples": ["string"],
  "commonConfusions": ["string"],
  "keyNotation": ["string"],
  "relatedResults": ["string"],
  "proofIdeas": ["string"],
  "sourceSummary": "string",
  "references": ["string"]
}

Rules:
- Synthesize a canonical concept card from all provided evidence excerpts.
- Do not merely summarize one local section unless the concept only appears there.
- Stay faithful to the textbook evidence.
- Do not invent unsupported examples, theorems, or definitions.
- If the evidence includes a formal definition, preserve it accurately.
- If the evidence spans multiple contexts, explain how the concept develops across those contexts.
- hierarchyPath should be conceptual, not chapter-based or page-based.
- Preserve useful TeX notation.
- keyNotation should contain compact notation snippets when possible.
- Because this is JSON, every TeX backslash must be escaped as a double backslash.
- Return strictly valid JSON parseable by JSON.parse.
- Use empty strings or empty arrays for unsupported fields.
`;

function normalizeCanonicalConceptCard({
  raw,
  canonicalConcept,
  evidenceChunks,
  number,
}) {
  const title = String(raw?.title || canonicalConcept.title || `Concept ${number}`).trim();
  const id = `${slugify(title)}-${number}`;

  const hierarchyPath = normalizeHierarchyPathForConceptMap(
    raw?.hierarchyPath,
    canonicalConcept.hierarchyPath || ["Concept Map"]
  );

  const references = normalizeStringArray(raw?.references, 10);
  const evidenceReferences = evidenceChunks
    .map((chunk) => chunk.sectionTitle)
    .filter(Boolean);

  const sourceChunkIds = evidenceChunks.map((chunk) => chunk.id);
  const sourceSections = Array.from(new Set(evidenceReferences)).slice(0, 12);

  return {
    id,
    title,
    type: String(raw?.type || canonicalConcept.type || "Concept").trim(),
    section: hierarchyPath[0] || "Concept Map",
    hierarchyPath: hierarchyPath.length ? hierarchyPath : ["Concept Map"],
    page: sourceSections[0] || references[0] || "Concept Map",
    definition: String(raw?.definition || "").trim().slice(0, 2200),
    statement: String(raw?.statement || "").trim().slice(0, 1800),
    teachingRole: String(raw?.teachingRole || canonicalConcept.conceptualRole || "").trim().slice(0, 1400),
    prerequisites: normalizeStringArray(raw?.prerequisites, 12),
    dependsOnEarlierInExcerpt: normalizeStringArray(raw?.dependsOnEarlierInExcerpt, 12),
    examples: normalizeStringArray(raw?.examples, 10),
    nonExamples: normalizeStringArray(raw?.nonExamples, 8),
    commonConfusions: normalizeStringArray(raw?.commonConfusions, 10),
    keyNotation: normalizeStringArray(raw?.keyNotation, 12),
    relatedResults: normalizeStringArray(raw?.relatedResults, 16),
    proofIdeas: normalizeStringArray(raw?.proofIdeas, 10),
    sourceSummary: String(raw?.sourceSummary || "").trim().slice(0, 1600),
    references: references.length > 0
      ? references
      : sourceSections.length > 0
        ? sourceSections
        : canonicalConcept.references || [],
    sourceStart: evidenceChunks[0]?.index || 0,

    canonical: true,
    aliases: canonicalConcept.aliases || [],
    conceptMapRole: canonicalConcept.conceptualRole || "",
    sourceChunkIds,
    sourceSections,
  };
}

async function synthesizeCanonicalConceptCardWithLLM({
  canonicalConcept,
  evidenceChunks,
  allCanonicalConcepts,
  number,
}) {
  const user = `
Canonical concept to synthesize:
${JSON.stringify(canonicalConcept, null, 2)}

Related canonical concept titles:
${JSON.stringify(
  allCanonicalConcepts.map((concept) => ({
    title: concept.title,
    type: concept.type,
    hierarchyPath: concept.hierarchyPath,
  })),
  null,
  2
).slice(0, 12000)}

Evidence excerpts from across the textbook:
${JSON.stringify(
  evidenceChunks.map((chunk) => ({
    id: chunk.id,
    sectionTitle: chunk.sectionTitle,
    sectionLevel: chunk.sectionLevel,
    content: String(chunk.content || "").slice(0, 2200),
  })),
  null,
  2
).slice(0, 26000)}

Synthesize one global concept card for this canonical concept.
`;

  const response = await callLocalLLM({
    system: canonicalConceptSynthesisSystemPrompt,
    user,
    temperature: 0.1,
    maxTokens: 4200,
    jsonMode: true,
  });

  if (!response) {
    throw new Error("No LLM is configured for canonical concept synthesis.");
  }

  let parsed;

  try {
    parsed = parseJsonFromLLM(response);
  } catch (error) {
    console.warn(`Initial canonical concept synthesis JSON parse failed for ${canonicalConcept.title}. Asking LLM to repair JSON...`);

    const repaired = await repairJsonWithLLM({
      brokenJson: response,
      parseError: error.message,
    });

    parsed = parseJsonFromLLM(repaired);
  }

  return normalizeCanonicalConceptCard({
    raw: parsed,
    canonicalConcept,
    evidenceChunks,
    number,
  });
}

async function extractConceptMapWithLLM({ text, sections }) {
  const evidenceChunks = sourceEvidenceChunks(text, sections);

  if (evidenceChunks.length === 0) {
    return null;
  }

  const canonicalConcepts = await identifyCanonicalConceptsWithLLM({
    chunks: evidenceChunks,
  });

  if (!canonicalConcepts || canonicalConcepts.length === 0) {
    return null;
  }

  const synthesizedConcepts = [];

  for (let i = 0; i < canonicalConcepts.length; i++) {
    const canonicalConcept = canonicalConcepts[i];

    try {
      const evidence = findEvidenceForCanonicalConcept({
        canonicalConcept,
        chunks: evidenceChunks,
        limit: 10,
      });

      const conceptCard = await synthesizeCanonicalConceptCardWithLLM({
        canonicalConcept,
        evidenceChunks: evidence,
        allCanonicalConcepts: canonicalConcepts,
        number: synthesizedConcepts.length + 1,
      });

      if (conceptCard.title && conceptCard.definition.length > 20) {
        synthesizedConcepts.push(conceptCard);
      }
    } catch (error) {
      console.warn(`Canonical concept synthesis failed for ${canonicalConcept.title}:`, error.message);
    }
  }

  return synthesizedConcepts.length > 0 ? synthesizedConcepts : null;
}

function normalizeLLMConcept(raw, fallbackSection, number) {
  const title = String(raw.title || raw.name || `Concept ${number}`).trim();
  const type = String(raw.type || "Concept").trim();

  return {
    id: `${slugify(title)}-${number}`,
    title,
    type,
    section: String(raw.section || fallbackSection.sectionTitle || "Extracted Text"),

    hierarchyPath: Array.isArray(raw.hierarchyPath)
      ? raw.hierarchyPath
          .map(String)
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, 4)
      : [String(raw.section || fallbackSection.sectionTitle || "Extracted Text")],

    page: String(raw.reference || raw.section || fallbackSection.sectionTitle || "Extracted Text"),
    definition: String(raw.definition || raw.description || raw.sourceSummary || "").trim().slice(0, 1400),
    prerequisites: Array.isArray(raw.prerequisites)
      ? raw.prerequisites.map(String).filter(Boolean).slice(0, 8)
      : [],
    examples: Array.isArray(raw.examples)
      ? raw.examples.map(String).filter(Boolean).slice(0, 6)
      : [],
    commonConfusions: Array.isArray(raw.commonConfusions)
      ? raw.commonConfusions.map(String).filter(Boolean).slice(0, 6)
      : [],
    references: Array.isArray(raw.references)
      ? raw.references.map(String).filter(Boolean).slice(0, 6)
      : [String(fallbackSection.sectionTitle || "Textbook excerpt")],
    sourceSummary: String(raw.sourceSummary || "").trim().slice(0, 1200),
    sourceStart: fallbackSection.index,
	statement: String(raw.statement || "").trim().slice(0, 1800),
	teachingRole: String(raw.teachingRole || "").trim().slice(0, 1200),
	dependsOnEarlierInExcerpt: normalizeStringArray(raw.dependsOnEarlierInExcerpt, 10),
	nonExamples: normalizeStringArray(raw.nonExamples, 6),
	keyNotation: normalizeStringArray(raw.keyNotation, 10),
	relatedResults: normalizeStringArray(raw.relatedResults, 10),
	proofIdeas: normalizeStringArray(raw.proofIdeas, 8),
  };
}

const conceptQualitySystemPrompt = `
You are an expert mathematics educator evaluating concept cards for a textbook-based Socratic tutoring app.

Your job is to decide whether a proposed concept card is useful for helping a student learn from the textbook. You are not grading mathematical truth in isolation. You are assessing whether this concept card is pedagogically useful, well-formed, faithful to the source excerpt, and suitable for a concept navigator, concept card, retrieval target, and tutoring workflow.

Return JSON only. Do not include markdown. Do not include commentary outside the JSON.

Use exactly this schema:

{
  "quality": 3,
  "rationale": "string",
  "issues": ["string"],
  "suggestedFix": "string"
}

Quality scale:

- 3 means well-formed and valuable.
  Use 3 when the concept card has a clear title, a meaningful mathematical statement or definition, a useful instructional role, and enough source-grounded content to support tutoring.

- 2 means possibly not valuable.
  Use 2 when the card may be useful but is incomplete, vague, too broad, too narrow, poorly titled, missing important instructional metadata, duplicative, or only weakly supported by the source excerpt.

- 1 means probably not valuable.
  Use 1 when the card is malformed, mostly connective prose, not independently teachable, not supported by the source excerpt, too vague for a student to select, or not useful for tutoring.

Evaluation criteria:

- Is the title a meaningful concept name rather than a generic label like "Theorem 1", "Section 2", or "Concept 4"?
- Is the main statement faithful to the source excerpt?
- Is this something a student could reasonably select in a concept navigator to study?
- Does it have enough content to guide Socratic tutoring?
- Are prerequisites, examples, notation, proof ideas, or common confusions included when the source supports them?
- Is the concept neither too broad nor too atomized?
- Is it distinct from nearby concepts?
- Would this concept help organize the textbook as an instructor would teach it?

Rules:

- Return strictly valid JSON parseable by JSON.parse.
- Return a single JSON object.
- The "quality" value must be exactly 1, 2, or 3.
- Use empty arrays for missing issue lists.
- Do not use null.
- Do not use raw line breaks inside strings.
- Do not use unescaped double quotes inside strings.
- Preserve mathematical notation when it is relevant to the quality assessment, but make sure any TeX backslash in JSON output is escaped as a double backslash.
`;

function getSourceExcerptForConcept(text, concept, radius = 3500) {
  const start = Number.isFinite(concept.sourceStart) ? concept.sourceStart : 0;
  const from = Math.max(0, start - radius);
  const to = Math.min(text.length, start + radius);
  return text.slice(from, to);
}

function normalizeQualityAssessment(raw) {
  const qualityNumber = Number(raw?.quality);

  return {
    quality: [1, 2, 3].includes(qualityNumber) ? qualityNumber : 2,
    qualityRationale: String(raw?.rationale || "").trim(),
    qualityIssues: Array.isArray(raw?.issues)
      ? raw.issues.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 8)
      : [],
    qualitySuggestedFix: String(raw?.suggestedFix || "").trim(),
  };
}

async function assessConceptQualityWithLLM({ concept, sourceExcerpt, siblingConcepts = [] }) {
  const user = `
Source excerpt:
${String(sourceExcerpt || "").slice(0, 6000)}

Other concepts extracted from the same local context:
${JSON.stringify(
  siblingConcepts.map((candidate) => ({
    title: candidate.title,
    type: candidate.type,
    definition: candidate.definition,
    section: candidate.section,
  })),
  null,
  2
).slice(0, 4000)}

Concept card to evaluate:
${JSON.stringify(concept, null, 2)}
`;

  const response = await callLocalLLM({
    system: conceptQualitySystemPrompt,
    user,
    temperature: 0,
    maxTokens: 1200,
    jsonMode: true,
  });

  if (!response) {
    return {
      quality: 2,
      qualityRationale: "No LLM quality assessment was available.",
      qualityIssues: ["Quality assessment unavailable."],
      qualitySuggestedFix: "",
    };
  }

  let parsed;

  try {
    parsed = parseJsonFromLLM(response);
  } catch (error) {
    console.warn(`Initial QA JSON parse failed for ${concept.title}. Asking LLM to repair JSON...`);

    const repaired = await repairJsonWithLLM({
      brokenJson: response,
      parseError: error.message,
    });

    parsed = parseJsonFromLLM(repaired);
  }

  return normalizeQualityAssessment(parsed);
}

async function addQualityAssessmentsToConcepts({ concepts, text }) {
  const assessed = [];

  for (const concept of concepts) {
    try {
      const sourceExcerpt = getSourceExcerptForConcept(text, concept);

      const siblingConcepts = concepts.filter(
        (candidate) =>
          candidate.id !== concept.id &&
          candidate.section === concept.section
      );

      const qa = await assessConceptQualityWithLLM({
        concept,
        sourceExcerpt,
        siblingConcepts,
      });

      assessed.push({
        ...concept,
        ...qa,
      });
    } catch (error) {
      console.warn(`Concept QA failed for ${concept.title}:`, error.message);

      assessed.push({
        ...concept,
        quality: 2,
        qualityRationale: "Quality assessment failed, so this concept was marked as possibly not valuable.",
        qualityIssues: [error.message],
        qualitySuggestedFix: "Re-run QA or refresh this concept card.",
      });
    }
  }

  return assessed;
}

async function extractConceptsWithLLM({ text, sections }) {
  const blocks = splitTextForLLM(text, sections);
  const allConcepts = [];

  const system = `
You are an expert mathematical textbook analyst and course instructor.

Your job is to read TeX textbook excerpts and identify the teachable mathematical concepts that a student would need to understand in order to learn the textbook well. You should analyze the text as an instructor preparing to teach from this textbook: identify the concepts, organize them according to how the textbook develops them, distinguish definitions from results and techniques, and infer the local prerequisite structure when the excerpt supports it.

You are not merely extracting headings. You are building structured instructional metadata for a Socratic tutoring application. The resulting concepts will be used to create a concept navigator, concept cards, retrieval targets, and tutoring prompts.

Return JSON only. Do not include markdown. Do not include commentary outside the JSON.

The JSON schema is:

{
  "concepts": [
    {
      "title": "string",
      "type": "Definition | Theorem | Lemma | Proposition | Corollary | Example | Exercise | Question | Concept | Technique | Proof Strategy | Notation | Assumption",
      "section": "string",
	  "hierarchyPath": ["string"],
      "localOrder": 1,
      "definition": "string",
	  "statement": "string",
      "teachingRole": "string",
      "prerequisites": ["string"],
      "dependsOnEarlierInExcerpt": ["string"],
      "examples": ["string"],
      "nonExamples": ["string"],
      "commonConfusions": ["string"],
      "keyNotation": ["string"],
      "relatedResults": ["string"],
      "proofIdeas": ["string"],
      "sourceSummary": "string",
      "references": ["string"]
    }
  ]
}

Field meanings:

- "title": A concise instructor-quality name for the concept. Prefer the textbook's name if one is given. If the textbook gives no explicit name, create a clear mathematical title that accurately describes the concept.
- "type": The instructional type of the item. Use the most specific type supported by the excerpt.
- "section": The section, subsection, or local heading in which the concept occurs.
- "hierarchyPath": An ordered path of at most 4 grouping labels that places this concept in the textbook structure. Use textbook hierarchy when possible, such as ["Chapter 2", "Section 2.1", "Definitions"]. Do not include the concept title itself in hierarchyPath. The application will append the concept as the final node, so the total depth should be at most 5.
- "localOrder": The order in which this concept appears or should be learned within the excerpt, starting at 1.
- "definition": 
  - If the item is a formal definition, give a concise but faithful statement of the definition as presented in the textbook.
  - If the item is a theorem, lemma, proposition, corollary, exercise, or question, state the mathematical claim or task faithfully. If the statement is short, preserve it nearly verbatim. If it is long, preserve its hypotheses, conclusion, and mathematical content without unnecessary paraphrase.
  - If the item is a technique, proof strategy, notation, assumption, or broader concept, describe it precisely and in a way that would help a student recognize it in the textbook.
- "teachingRole": Explain why this item matters instructionally. For example: "introduces the main object of the section", "provides a criterion used later", "illustrates the definition", "gives a standard proof technique", "states a key assumption", or "tests whether the student can apply the preceding theorem".
- "prerequisites": Concepts a student should already understand before learning this item. Include only prerequisites supported by the excerpt or strongly implied by the local mathematical context.
- "dependsOnEarlierInExcerpt": Concepts from this same excerpt that this item depends on. Use titles from this JSON output when possible.
- "examples": Concrete examples, applications, special cases, or illustrative instances from the excerpt.
- "nonExamples": Non-examples, boundary cases, counterexamples, or failure cases from the excerpt. Leave empty if none are present.
- "commonConfusions": Likely student misunderstandings suggested by the excerpt. Do not invent elaborate misconceptions, but include natural confusions caused by similar terminology, hidden hypotheses, notation, or nearby concepts.
- "keyNotation": Important notation introduced or used for this concept. Preserve the textbook's mathematical notation when useful. Use TeX notation when the source uses TeX notation, but ensure every TeX backslash is JSON-escaped as a double backslash.
- "relatedResults": Named or nearby definitions, theorems, lemmas, examples, exercises, or questions that are connected to this concept.
- "proofIdeas": If the excerpt includes or sketches a proof, summarize the main proof idea, not every line. If no proof is present, use an empty array.
- "sourceSummary": Briefly explain how the textbook presents this concept in the excerpt.
- "references": Local source references available from the excerpt, such as section title, theorem number, definition number, example number, exercise number, or nearby heading.

Rules for concept identification:

- Identify all pedagogically important concepts in the excerpt, including simple concepts if they are necessary for understanding later material.
- Prefer instructor-quality concepts over vague or overly broad labels.
- Do not extract every sentence as a concept. A concept should be something a student could reasonably select in a navigator to study.
- Do not merge distinct mathematical items if the textbook treats them separately.
- Do not split one coherent definition, theorem, or technique into many artificial fragments.
- Include formal definitions, named objects, important notation, assumptions, theorem statements, proof techniques, examples, exercises, and conceptual distinctions.
- If a theorem has important hypotheses, represent the theorem as one concept and make the hypotheses clear in the "definition" field.
- If a proof introduces a reusable technique, include the proof technique as a separate concept only if it is pedagogically meaningful.
- If an exercise or question is followed by a solution, include the exercise or question as a concept and use the solution to identify prerequisites, techniques, and common confusions.
- If an example illustrates a preceding definition or theorem, include the example if it would be useful for tutoring. Connect it to the relevant concept in "relatedResults".
- If["string":

title": A concise instructor-quality name for the concept. textbook's name if one is given. textbook gives no explicit name, create a ncept or dependency.

Rules for organization:

- Organize concepts as if preparing a lesson from this excerpt.
- Use "hierarchyPath" to organize concepts as an instructor would organize the textbook. Prefer chapter, section, subsection, and local topic groupings. Keep the path short and meaningful. The hierarchyPath must contain at most 4 labels.
- Use "localOrder" to reflect the order in which a student should encounter the concepts.
- Use "dependsOnEarlierInExcerpt" to capture local dependencies among concepts from this same excerpt.
- Use "prerequisites" to capture broader mathematical prerequisites.
- If several concepts form a natural cluster, keep their titles consistent so they can be grouped later by the application.
- Preserve the textbook's hierarchy when possible: chapter, section, subsection, definition, result, example, exercise.
- Prefer titles that will make sense in a concept navigator, such as "Intersection graph of a finite family" rather than "Definition 1".

Rules for mathematical fidelity:

- Use the textbook's terminology and notation when possible.
- Do not contradict the textbook.
- Do not invent concepts, examples, theorem statements, or dependencies not supported by the excerpt.
- Do not add outside facts unless they are necessary to name an obvious prerequisite, and keep such prerequisites concise.
- Preserve hypotheses and conclusions of mathematical statements.
- Distinguish definitions, assumptions, examples, theorem statements, and proof strategies.
- Distinguish intuition from formal content.
- If the excerpt is ambiguous, choose a conservative interpretation.

Rules for JSON validity:

- Return strictly valid JSON parseable by JSON.parse.
- Return a single JSON object with exactly one top-level key: "concepts".
- Do not include markdown fences.
- Do not include commentary outside the JSON.
- Every string must be a single-line JSON string.
- Do not put raw line breaks inside string values.
- Do not use unescaped double quotes inside string values.
- Preserve mathematical notation from the textbook whenever it helps fidelity.
- Use TeX notation inside JSON strings when the textbook uses TeX notation.
- Because the output is JSON, every TeX backslash must be escaped as a double backslash.
- Prefer inline math delimiters "\\\\(...\\\\)" and display math delimiters "\\\\[...\\\\]".
- For example, write "\\\\mathbb{R}" instead of "\mathbb{R}", "\\\\ker T" instead of "\ker T", and "\\\\(x \\\\in V\\\\)" instead of "\(x \in V\)".
- Use empty arrays for fields with no supported content.
- Do not omit required fields.
- Do not use null. Use an empty string or empty array as appropriate.
- Ensure every array item is separated by a comma.
- Ensure every string is closed.

Quality standard:

The output should be useful to a mathematics instructor preparing a tutoring interface from the textbook. A high-quality output helps the app answer questions like:
- What should the student study here?
- What does this concept depend on?
- What examples clarify it?
- What theorem, definition, or technique is being used?
- What might a student misunderstand?
- How does this item fit into the local development of the textbook?

If the excerpt contains substantial mathematical content, return enough concepts to represent the instructional structure of the excerpt. If the excerpt contains little or no teachable mathematical content, return { "concepts": [] }.
`;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    const user = `
Section title: ${block.sectionTitle}
Section level: ${block.sectionLevel}

TeX excerpt:
${block.text}
`;

    try {
	  const response = await callLocalLLM({
		system,
		user,
		temperature: 0.1,
		maxTokens: 4096,
		jsonMode: true,
	  });

	  if (!response) {
		return null;
	  }

	  let parsed;

	  try {
		parsed = parseJsonFromLLM(response);
	  } catch (error) {
		console.warn(`Initial JSON parse failed for block ${i + 1}. Asking LLM to repair JSON...`);

		const repaired = await repairJsonWithLLM({
		  brokenJson: response,
		  parseError: error.message,
		});

		parsed = parseJsonFromLLM(repaired);
	  }

	  const concepts = Array.isArray(parsed.concepts) ? parsed.concepts : [];

	  for (const raw of concepts) {
		const concept = normalizeLLMConcept(raw, block, allConcepts.length + 1);

		if (concept.title && concept.definition.length > 20) {
		  allConcepts.push(concept);
		}
	  }
	} catch (error) {
	  console.warn(`LLM concept extraction failed for block ${i + 1}:`, error.message);
	}
  }

  return allConcepts.length > 0 ? allConcepts : null;
}

const conceptRefreshSystemPrompt = `
You are an expert mathematical textbook analyst and course instructor improving one concept card for a textbook-based Socratic tutoring app.

The existing concept card may be incomplete, vague, malformed, duplicative, poorly titled, or pedagogically weak. Your job is to regenerate a better concept card using the provided textbook excerpt, the QA feedback, and any user feedback.

Your goal is to produce a concept card that would be useful to a curious student trying to understand the textbook and useful to a Socratic tutor trying to guide that student.

Priority order:
1. Stay faithful to the textbook excerpt.
2. Use the user feedback to guide what should be improved.
3. Use the QA feedback to repair weaknesses.
4. Preserve useful content from the old concept card.
5. Do not invent unsupported content.

If the user feedback conflicts with the textbook excerpt, follow the textbook excerpt.
If the user feedback conflicts with the QA feedback, prefer the user feedback unless it asks for unsupported content.

Return JSON only. Do not include markdown. Do not include commentary outside the JSON.

Use exactly this schema:

{
  "title": "string",
  "type": "Definition | Theorem | Lemma | Proposition | Corollary | Example | Exercise | Question | Concept | Technique | Proof Strategy | Notation | Assumption",
  "section": "string",
  "hierarchyPath": ["string"],
  "localOrder": 1,
  "definition": "string",
  "statement": "string",
  "teachingRole": "string",
  "prerequisites": ["string"],
  "dependsOnEarlierInExcerpt": ["string"],
  "examples": ["string"],
  "nonExamples": ["string"],
  "commonConfusions": ["string"],
  "keyNotation": ["string"],
  "relatedResults": ["string"],
  "proofIdeas": ["string"],
  "sourceSummary": "string",
  "references": ["string"]
}

Instructions:
- Keep the same general mathematical target as the original concept unless the source excerpt clearly shows that the original target was wrong.
- Prefer a meaningful concept title over generic labels like "Theorem 1", "Definition 2", "Section 3", or "Concept 4".
- If the item is a formal definition, put a faithful statement of the definition in "definition".
- If the item is a theorem, lemma, proposition, corollary, exercise, or question, put the faithful mathematical claim or task in "definition".
- If "statement" is useful, copy the theorem, exercise, question, or proposition statement there as well.
- "hierarchyPath" should contain at most 4 grouping labels. Use it to place the refreshed concept in the textbook hierarchy. Do not include the concept title itself in hierarchyPath. The application will append the concept as the final node.
- Use "teachingRole" to explain why this item matters instructionally.
- Include prerequisites, examples, non-examples, common confusions, notation, related results, and proof ideas only when supported by the source excerpt.
- Use the textbook's terminology and notation where possible.
- Preserve mathematical notation from the textbook whenever it helps fidelity.
- Use TeX notation inside JSON strings when the textbook uses TeX notation.
- Because the output is JSON, every TeX backslash must be escaped as a double backslash.
- Prefer inline math delimiters "\\\\(...\\\\)" and display math delimiters "\\\\[...\\\\]".
- For example, write "\\\\mathbb{R}" instead of "\mathbb{R}", "\\\\ker T" instead of "\ker T", and "\\\\(x \\\\in V\\\\)" instead of "\(x \in V\)".
- Return strictly valid JSON parseable by JSON.parse.
- Do not use null. Use empty strings or empty arrays.
- Do not put raw line breaks inside string values.
- Do not use unescaped double quotes inside string values.
`;

function normalizeStringArray(value, limit = 8) {
  return Array.isArray(value)
    ? value.map(String).map((item) => item.trim()).filter(Boolean).slice(0, limit)
    : [];
}

function normalizeRefreshedConcept(raw, oldConcept) {
  const references = normalizeStringArray(raw.references, 8);

  return {
    id: oldConcept.id,

    title: String(raw.title || oldConcept.title || "Untitled concept").trim(),
    type: String(raw.type || oldConcept.type || "Concept").trim(),
    section: String(raw.section || oldConcept.section || "Extracted Text").trim(),
	hierarchyPath: Array.isArray(raw.hierarchyPath)
		? raw.hierarchyPath
			.map(String)
			.map((item) => item.trim())
			.filter(Boolean)
			.slice(0, 4)
		: oldConcept.hierarchyPath || [oldConcept.section || "Extracted Text"],
    page: String(raw.section || raw.reference || oldConcept.page || oldConcept.section || "Extracted Text").trim(),

    localOrder: Number.isFinite(Number(raw.localOrder))
      ? Number(raw.localOrder)
      : oldConcept.localOrder,

    definition: String(
      raw.definition ||
      raw.statement ||
      oldConcept.definition ||
      ""
    ).trim().slice(0, 1800),

    statement: String(raw.statement || oldConcept.statement || "").trim().slice(0, 1800),
    teachingRole: String(raw.teachingRole || oldConcept.teachingRole || "").trim().slice(0, 1200),

    prerequisites: normalizeStringArray(raw.prerequisites, 10),
    dependsOnEarlierInExcerpt: normalizeStringArray(raw.dependsOnEarlierInExcerpt, 10),
    examples: normalizeStringArray(raw.examples, 8),
    nonExamples: normalizeStringArray(raw.nonExamples, 6),
    commonConfusions: normalizeStringArray(raw.commonConfusions, 8),
    keyNotation: normalizeStringArray(raw.keyNotation, 10),
    relatedResults: normalizeStringArray(raw.relatedResults, 10),
    proofIdeas: normalizeStringArray(raw.proofIdeas, 8),

    sourceSummary: String(raw.sourceSummary || oldConcept.sourceSummary || "").trim().slice(0, 1400),

    references: references.length > 0
      ? references
      : oldConcept.references || [],

    sourceStart: oldConcept.sourceStart,
  };
}

function getRefreshContext({ sourceText, saved, concept }) {
  if (sourceText && Number.isFinite(concept.sourceStart)) {
    return getSourceExcerptForConcept(sourceText, concept, 7000);
  }

  const relatedChunks = (saved.chunks || [])
    .filter((chunk) => chunk.conceptId === concept.id)
    .map((chunk) => chunk.content)
    .join("\n\n");

  if (relatedChunks.trim()) {
    return relatedChunks.slice(0, 9000);
  }

  return JSON.stringify(concept, null, 2);
}



function updateChunksForConcept(chunks, updatedConcept) {
  return (chunks || []).map((chunk) => {
    if (chunk.conceptId !== updatedConcept.id) return chunk;

    return {
      ...chunk,
      title: updatedConcept.title || chunk.title,
      reference: updatedConcept.references?.[0] || updatedConcept.section || chunk.reference,
    };
  });
}

async function regenerateConceptCardWithLLM({ oldConcept, sourceExcerpt, userFeedback }) {
  const qaFeedback = {
    quality: oldConcept.quality,
    qualityRationale: oldConcept.qualityRationale || "",
    qualityIssues: oldConcept.qualityIssues || [],
    qualitySuggestedFix: oldConcept.qualitySuggestedFix || "",
  };

  const user = `
Existing concept card:
${JSON.stringify(oldConcept, null, 2)}

QA feedback:
${JSON.stringify(qaFeedback, null, 2)}

User feedback:
${String(userFeedback || "(none provided)").slice(0, 4000)}

Relevant textbook excerpt:
${String(sourceExcerpt || "").slice(0, 9000)}

Regenerate a better concept card for this same concept using the textbook excerpt, QA feedback, and user feedback.
`;

  const response = await callLocalLLM({
    system: conceptRefreshSystemPrompt,
    user,
    temperature: 0,
    maxTokens: 3500,
    jsonMode: true,
  });

  if (!response) {
    throw new Error("No LLM is configured for concept refresh.");
  }

  let parsed;

  try {
    parsed = parseJsonFromLLM(response);
  } catch (error) {
    console.warn(`Initial refresh JSON parse failed for ${oldConcept.title}. Asking LLM to repair JSON...`);

    const repaired = await repairJsonWithLLM({
      brokenJson: response,
      parseError: error.message,
    });

    parsed = parseJsonFromLLM(repaired);
  }

  return normalizeRefreshedConcept(parsed, oldConcept);
}

export async function ingestTextbook({ file, textbookDir }) {
    const rawText = await extractText(file);
    const fullText = cleanText(rawText);

    if (!fullText || fullText.length < 20) {
	  throw new Error("Could not extract enough text from the uploaded file.");
    }

    const { texPreamble, mathJax } = extractMathJaxMetadata(fullText, file.originalname);

    const text = cleanText(extractTexBodyForIngestion(fullText, file.originalname));

    if (!text || text.length < 20) {
	  throw new Error("Could not extract enough textbook body text from the uploaded file.");
    }

    const title = titleFromFilename(file.originalname) || "Uploaded textbook";
    const id = `${slugify(title)}-${crypto.randomBytes(4).toString("hex")}`;
    const sections = detectSections(text);

	// First try global concept-map ingestion.
	// This identifies canonical concepts across the whole textbook,
	// gathers distributed evidence, and synthesizes concept cards
	// organized by conceptual hierarchyPath.
	let concepts = await extractConceptMapWithLLM({ text, sections });

	// Fall back to the original local LLM extraction if global concept-map
	// ingestion is unavailable or returns weak output.
	if (!concepts || concepts.length === 0) {
	  concepts = await extractConceptsWithLLM({ text, sections });
	}

	// Fall back to rule-based extraction if the LLM is unavailable or returns weak output.
	if (!concepts || concepts.length === 0) {
	  const blocks = extractTeXBlocks(text);

	  concepts = blocks.map((block, idx) =>
		conceptFromBlock(block, idx + 1, findSectionForIndex(sections, block.index))
	  );

	  if (concepts.length < 3) {
		concepts = conceptsFromSections(text, sections);
	  }
	}
  if (concepts.length === 0) {
    concepts = [{
      id: "textbook-overview",
      title: "Textbook Overview",
      type: "Section",
      section: "Extracted Text",
      page: "Extracted Text",
      definition: cleanTeXForDisplay(text).slice(0, 1400),
      prerequisites: [],
      examples: [],
      references: [file.originalname],
      sourceStart: 0,
    }];
  }

  concepts = await addQualityAssessmentsToConcepts({ concepts, text });

	const chunks = chunkText(text, concepts);
	const textbook = {
		id,
		title,
		sections: buildConceptHierarchy(concepts),
		createdAt: new Date().toISOString(),
		originalName: file.originalname,
		texPreamble,
		mathJax,
	};
  const saved = { textbook, concepts, chunks };
  const dir = path.join(textbookDir, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "textbook.json"), JSON.stringify(saved, null, 2));
  await fs.writeFile(path.join(dir, "source.txt"), text);
  await fs.copyFile(file.path, path.join(dir, file.originalname));
  await fs.unlink(file.path).catch(() => {});

  return { textbook, conceptCount: concepts.length, chunkCount: chunks.length };
}

async function refreshConceptInSavedTextbook({ saved, sourceText, conceptId, userFeedback = "" }) {
  const oldConcept = saved.concepts.find((concept) => concept.id === conceptId);

  if (!oldConcept) {
    throw new Error(`Could not find concept ${conceptId}.`);
  }

  const sourceExcerpt = getRefreshContext({
    sourceText,
    saved,
    concept: oldConcept,
  });

  const regeneratedConcept = await regenerateConceptCardWithLLM({
    oldConcept,
    sourceExcerpt,
    userFeedback,
  });

  const qa = await assessConceptQualityWithLLM({
    concept: regeneratedConcept,
    sourceExcerpt,
    siblingConcepts: saved.concepts.filter(
      (concept) =>
        concept.id !== conceptId &&
        concept.section === oldConcept.section
    ),
  });

  const finalConcept = {
    ...oldConcept,
    ...regeneratedConcept,
    ...qa,
    lastRefreshFeedback: userFeedback,
    refreshedAt: new Date().toISOString(),
  };

  saved.concepts = saved.concepts.map((concept) =>
    concept.id === conceptId ? finalConcept : concept
  );

  saved.chunks = updateChunksForConcept(saved.chunks, finalConcept);

  return finalConcept;
}

export async function refreshConceptCard({ textbookDir, textbookId, conceptId, userFeedback = "" }) {
  const textbookJsonPath = path.join(textbookDir, textbookId, "textbook.json");
  const sourceTextPath = path.join(textbookDir, textbookId, "source.txt");

  const saved = JSON.parse(await fs.readFile(textbookJsonPath, "utf8"));
  const sourceText = await fs.readFile(sourceTextPath, "utf8").catch(() => "");

  const finalConcept = await refreshConceptInSavedTextbook({
    saved,
    sourceText,
    conceptId,
    userFeedback,
  });

  saved.textbook.sections = buildConceptHierarchy(saved.concepts);

  await fs.writeFile(textbookJsonPath, JSON.stringify(saved, null, 2));

  return {
    concept: finalConcept,
    textbook: saved.textbook,
    conceptCount: saved.concepts.length,
    chunkCount: saved.chunks?.length || 0,
  };
}

export async function refreshConceptsByQuality({
  textbookDir,
  textbookId,
  quality,
  userFeedback = "",
  limit = 50,
}) {
  const qualityNumber = Number(quality);

  if (![1, 2, 3].includes(qualityNumber)) {
    throw new Error("Quality must be 1, 2, or 3.");
  }

  const textbookJsonPath = path.join(textbookDir, textbookId, "textbook.json");
  const sourceTextPath = path.join(textbookDir, textbookId, "source.txt");

  const saved = JSON.parse(await fs.readFile(textbookJsonPath, "utf8"));
  const sourceText = await fs.readFile(sourceTextPath, "utf8").catch(() => "");

  const matchingConcepts = saved.concepts.filter(
    (concept) => Number(concept.quality) === qualityNumber
  );

  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500));
  const conceptsToRefresh = matchingConcepts.slice(0, safeLimit);

  const refreshed = [];
  const failed = [];

  for (const concept of conceptsToRefresh) {
    try {
      const feedbackParts = [];

      feedbackParts.push(`Batch refresh requested for all concepts with quality ${qualityNumber}.`);

      if (concept.qualityRationale) {
        feedbackParts.push(`QA rationale: ${concept.qualityRationale}`);
      }

      if (concept.qualityIssues?.length) {
        feedbackParts.push(`QA issues:\n- ${concept.qualityIssues.join("\n- ")}`);
      }

      if (concept.qualitySuggestedFix) {
        feedbackParts.push(`QA suggested fix: ${concept.qualitySuggestedFix}`);
      }

      if (userFeedback) {
        feedbackParts.push(`User batch feedback:\n${userFeedback}`);
      }

      const combinedFeedback = feedbackParts.join("\n\n");

      const finalConcept = await refreshConceptInSavedTextbook({
        saved,
        sourceText,
        conceptId: concept.id,
        userFeedback: combinedFeedback,
      });

      refreshed.push({
        id: finalConcept.id,
        title: finalConcept.title,
        quality: finalConcept.quality,
      });
    } catch (error) {
      console.warn(`Batch refresh failed for ${concept.title}:`, error.message);

      failed.push({
        id: concept.id,
        title: concept.title,
        error: error.message,
      });
    }
  }
  
  saved.textbook.sections = buildConceptHierarchy(saved.concepts);

  await fs.writeFile(textbookJsonPath, JSON.stringify(saved, null, 2));

  return {
    textbook: saved.textbook,
    requestedQuality: qualityNumber,
    matchedCount: matchingConcepts.length,
    attemptedCount: conceptsToRefresh.length,
    refreshedCount: refreshed.length,
    failedCount: failed.length,
    refreshed,
    failed,
    conceptCount: saved.concepts.length,
    chunkCount: saved.chunks?.length || 0,
  };
}

export async function rerunConceptQualityAssessment({
  textbookDir,
  textbookId,
  conceptId,
}) {
  const textbookJsonPath = path.join(textbookDir, textbookId, "textbook.json");
  const sourceTextPath = path.join(textbookDir, textbookId, "source.txt");

  const saved = JSON.parse(await fs.readFile(textbookJsonPath, "utf8"));
  const sourceText = await fs.readFile(sourceTextPath, "utf8").catch(() => "");

  const oldConcept = saved.concepts.find((concept) => concept.id === conceptId);

  if (!oldConcept) {
    throw new Error(`Could not find concept ${conceptId}.`);
  }

  const sourceExcerpt = getRefreshContext({
    sourceText,
    saved,
    concept: oldConcept,
  });

  const qa = await assessConceptQualityWithLLM({
    concept: oldConcept,
    sourceExcerpt,
    siblingConcepts: saved.concepts.filter(
      (concept) =>
        concept.id !== conceptId &&
        concept.section === oldConcept.section
    ),
  });

  const updatedConcept = {
    ...oldConcept,
    ...qa,
    qualityAssessedAt: new Date().toISOString(),
  };

  saved.concepts = saved.concepts.map((concept) =>
    concept.id === conceptId ? updatedConcept : concept
  );

  saved.textbook.sections = buildConceptHierarchy(saved.concepts);

  await fs.writeFile(textbookJsonPath, JSON.stringify(saved, null, 2));

  return {
    concept: updatedConcept,
    textbook: saved.textbook,
    conceptCount: saved.concepts.length,
    chunkCount: saved.chunks?.length || 0,
  };
}

function normalizeEditableArray(value, limit = 20) {
  if (Array.isArray(value)) {
    return value
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, limit);
  }

  if (typeof value === "string") {
    return value
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, limit);
  }

  return [];
}

function normalizeEditableString(value, limit = 3000) {
  return String(value || "").trim().slice(0, limit);
}

export async function updateConceptCardFields({
  textbookDir,
  textbookId,
  conceptId,
  updates,
}) {
  const textbookJsonPath = path.join(textbookDir, textbookId, "textbook.json");
  const saved = JSON.parse(await fs.readFile(textbookJsonPath, "utf8"));

  const oldConcept = saved.concepts.find((concept) => concept.id === conceptId);

  if (!oldConcept) {
    throw new Error(`Could not find concept ${conceptId}.`);
  }

  const allowedStringFields = new Set([
    "title",
    "type",
    "section",
    "page",
    "definition",
    "statement",
    "teachingRole",
    "sourceSummary",
  ]);

  const allowedArrayFields = new Set([
    "hierarchyPath",
    "prerequisites",
    "dependsOnEarlierInExcerpt",
    "keyNotation",
    "examples",
    "nonExamples",
    "commonConfusions",
    "proofIdeas",
    "relatedResults",
    "references",
  ]);

  const normalizedUpdates = {};

  for (const [field, value] of Object.entries(updates || {})) {
    if (allowedStringFields.has(field)) {
      normalizedUpdates[field] = normalizeEditableString(value);
    }

    if (allowedArrayFields.has(field)) {
      normalizedUpdates[field] = normalizeEditableArray(
        value,
        field === "hierarchyPath" ? 4 : 20
      );
    }
  }

  if (Object.keys(normalizedUpdates).length === 0) {
    throw new Error("No editable concept fields were provided.");
  }

  const updatedConcept = {
    ...oldConcept,
    ...normalizedUpdates,
    editedAt: new Date().toISOString(),
  };

  if (!updatedConcept.hierarchyPath?.length) {
    updatedConcept.hierarchyPath = [
      updatedConcept.section || oldConcept.section || "Extracted Text",
    ];
  }

  saved.concepts = saved.concepts.map((concept) =>
    concept.id === conceptId ? updatedConcept : concept
  );

  saved.chunks = updateChunksForConcept(saved.chunks, updatedConcept);

  saved.textbook.sections = buildConceptHierarchy(saved.concepts);

  await fs.writeFile(textbookJsonPath, JSON.stringify(saved, null, 2));

  return {
    concept: updatedConcept,
    textbook: saved.textbook,
    conceptCount: saved.concepts.length,
    chunkCount: saved.chunks?.length || 0,
  };
}

const conceptFieldGenerationSystemPrompt = `
You are an expert mathematics educator improving one field of a textbook-based concept card.

Your task is to generate new content for exactly one requested concept-card field. The generated content should improve the pedagogical quality of the concept card while remaining faithful to the textbook excerpt.

Return JSON only. Do not include markdown. Do not include commentary outside the JSON.

Use exactly this schema:

{
  "generatedText": "string",
  "generatedItems": ["string"]
}

Rules:
- Generate only content appropriate for the requested field.
- Do not repeat content that is already present in the current field.
- Do not invent unsupported mathematical facts.
- Use the textbook excerpt as the source of truth.
- Use the current concept card for context.
- If the requested field is a list field, use "generatedItems".
- If the requested field is a text field, use "generatedText".
- Use empty strings or empty arrays if the source does not support adding useful content.
- Preserve mathematical notation when useful.
- Because this is JSON, every TeX backslash must be escaped as a double backslash.
- Return strictly valid JSON parseable by JSON.parse.
`;

const editableFieldGenerationConfig = {
  title: {
    kind: "string",
    label: "Title",
    guidance: "Generate a concise, instructor-quality title for this concept. Only generate a title if the current title is weak, generic, or misleading.",
  },
  type: {
    kind: "string",
    label: "Type",
    guidance: "Generate the best instructional type for this card, such as Definition, Theorem, Example, Exercise, Concept, Technique, Proof Strategy, Notation, or Assumption.",
  },
  page: {
    kind: "string",
    label: "Page or source label",
    guidance: "Generate a concise source label or local reference if supported by the excerpt.",
  },
  definition: {
    kind: "string",
    label: "Textbook definition or excerpt",
    guidance: "Add a faithful mathematical statement, definition, theorem statement, or explanatory excerpt for this concept.",
  },
  statement: {
    kind: "string",
    label: "Statement",
    guidance: "Add or improve the formal mathematical statement, preserving hypotheses and conclusion.",
  },
  teachingRole: {
    kind: "string",
    label: "Why this matters",
    guidance: "Explain why this concept matters instructionally and how it fits into the textbook's development.",
  },
  sourceSummary: {
    kind: "string",
    label: "How the textbook presents it",
    guidance: "Summarize how the textbook presents this concept in the local excerpt.",
  },
  hierarchyPath: {
    kind: "array",
    label: "Hierarchy path",
    guidance: "Generate up to 4 hierarchy labels that place the concept in the textbook structure. Do not include the concept title itself.",
    limit: 4,
  },
  prerequisites: {
    kind: "array",
    label: "Prerequisites",
    guidance: "Add prerequisite concepts a student should understand first.",
  },
  dependsOnEarlierInExcerpt: {
    kind: "array",
    label: "Depends on earlier in this section",
    guidance: "Add concepts from the local excerpt that this concept depends on.",
  },
  keyNotation: {
    kind: "array",
    label: "Key notation",
    guidance: "Add important notation used or introduced by this concept.",
  },
  examples: {
    kind: "array",
    label: "Useful examples",
    guidance: "Add examples, applications, or special cases supported by the source excerpt.",
  },
  nonExamples: {
    kind: "array",
    label: "Non-examples or boundary cases",
    guidance: "Add non-examples, boundary cases, counterexamples, or failure cases supported by the source excerpt.",
  },
  commonConfusions: {
    kind: "array",
    label: "Common confusions",
    guidance: "Add likely student misunderstandings suggested by the source excerpt.",
  },
  proofIdeas: {
    kind: "array",
    label: "Proof ideas",
    guidance: "Add proof ideas or proof strategy notes supported by the source excerpt.",
  },
  relatedResults: {
    kind: "array",
    label: "Related results and nearby concepts",
    guidance: "Add nearby definitions, theorems, examples, exercises, or concepts connected to this one.",
  },
  references: {
    kind: "array",
    label: "References",
    guidance: "Add local source references supported by the excerpt, such as section title, theorem number, definition number, example number, or heading.",
  },
};

function appendGeneratedString(currentValue, generatedText) {
  const current = String(currentValue || "").trim();
  const generated = String(generatedText || "").trim();

  if (!generated) return current;

  if (!current) return generated;

  if (current.includes(generated)) return current;

  return `${current}\n\n${generated}`;
}

function appendGeneratedArray(currentItems, generatedItems, limit = 20) {
  const existing = Array.isArray(currentItems)
    ? currentItems.map(String).map((item) => item.trim()).filter(Boolean)
    : [];

  const generated = Array.isArray(generatedItems)
    ? generatedItems.map(String).map((item) => item.trim()).filter(Boolean)
    : [];

  const seen = new Set(existing.map((item) => item.toLowerCase()));
  const combined = [...existing];

  for (const item of generated) {
    const key = item.toLowerCase();

    if (!seen.has(key)) {
      combined.push(item);
      seen.add(key);
    }
  }

  return combined.slice(0, limit);
}

async function generateConceptFieldContentWithLLM({
  concept,
  field,
  fieldConfig,
  sourceExcerpt,
}) {
  const currentValue = concept[field];

  const user = `
Requested field:
${field}

Field label:
${fieldConfig.label}

Field type:
${fieldConfig.kind}

Field-specific guidance:
${fieldConfig.guidance}

Current field value:
${JSON.stringify(currentValue, null, 2)}

Current concept card:
${JSON.stringify(concept, null, 2)}

Relevant textbook excerpt:
${String(sourceExcerpt || "").slice(0, 9000)}

Generate new content that can be appended to the requested field.
`;

  const response = await callLocalLLM({
    system: conceptFieldGenerationSystemPrompt,
    user,
    temperature: 0.2,
    maxTokens: 1800,
    jsonMode: true,
  });

  if (!response) {
    throw new Error("No LLM is configured for concept field generation.");
  }

  let parsed;

  try {
    parsed = parseJsonFromLLM(response);
  } catch (error) {
    console.warn(`Initial field generation JSON parse failed for ${concept.title}.${field}. Asking LLM to repair JSON...`);

    const repaired = await repairJsonWithLLM({
      brokenJson: response,
      parseError: error.message,
    });

    parsed = parseJsonFromLLM(repaired);
  }

  return {
    generatedText: String(parsed?.generatedText || "").trim(),
    generatedItems: Array.isArray(parsed?.generatedItems)
      ? parsed.generatedItems.map(String).map((item) => item.trim()).filter(Boolean)
      : [],
  };
}

export async function generateConceptCardField({
  textbookDir,
  textbookId,
  conceptId,
  field,
}) {
  const fieldConfig = editableFieldGenerationConfig[field];

  if (!fieldConfig) {
    throw new Error(`Field "${field}" cannot be generated.`);
  }

  const textbookJsonPath = path.join(textbookDir, textbookId, "textbook.json");
  const sourceTextPath = path.join(textbookDir, textbookId, "source.txt");

  const saved = JSON.parse(await fs.readFile(textbookJsonPath, "utf8"));
  const sourceText = await fs.readFile(sourceTextPath, "utf8").catch(() => "");

  const oldConcept = saved.concepts.find((concept) => concept.id === conceptId);

  if (!oldConcept) {
    throw new Error(`Could not find concept ${conceptId}.`);
  }

  const sourceExcerpt = getRefreshContext({
    sourceText,
    saved,
    concept: oldConcept,
  });

  const generated = await generateConceptFieldContentWithLLM({
    concept: oldConcept,
    field,
    fieldConfig,
    sourceExcerpt,
  });

  let updatedValue;

  if (fieldConfig.kind === "array") {
    updatedValue = appendGeneratedArray(
      oldConcept[field],
      generated.generatedItems,
      fieldConfig.limit || 20
    );
  } else {
    updatedValue = appendGeneratedString(
      oldConcept[field],
      generated.generatedText
    );
  }

  const generatedAt = new Date().toISOString();

  const updatedConcept = {
    ...oldConcept,
    [field]: updatedValue,
    generatedFields: {
	  ...(oldConcept.generatedFields || {}),
	  [field]: generatedAt,
    },
    editedAt: generatedAt,
  };



  if (!updatedConcept.hierarchyPath?.length) {
    updatedConcept.hierarchyPath = [
      updatedConcept.section || oldConcept.section || "Extracted Text",
    ];
  }

  saved.concepts = saved.concepts.map((concept) =>
    concept.id === conceptId ? updatedConcept : concept
  );

  saved.chunks = updateChunksForConcept(saved.chunks, updatedConcept);
  saved.textbook.sections = buildConceptHierarchy(saved.concepts);

  await fs.writeFile(textbookJsonPath, JSON.stringify(saved, null, 2));

  return {
    field,
    generated,
    concept: updatedConcept,
    textbook: saved.textbook,
    conceptCount: saved.concepts.length,
    chunkCount: saved.chunks?.length || 0,
  };
}