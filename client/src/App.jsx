import React, { useEffect, useMemo, useState } from "react";
import { MathJax, MathJaxContext } from "better-react-mathjax";
import {
  BookOpen,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  Lightbulb,
  MessageSquare,
  Search,
  Send,
  Sparkles,
  Upload,
} from "lucide-react";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";

const demoTextbook = {
  id: "demo",
  title: "Demo Textbook: Linear Algebra",
  sections: [
    {
      id: "ch1",
      title: "Chapter 1: Vector Spaces",
      children: [
        {
          id: "span",
          title: "Span",
          page: "pp. 12-15",
          type: "Definition",
          definition: "The span of a list of vectors is the set of all linear combinations of those vectors.",
          prerequisites: ["Vectors", "Scalar multiplication", "Vector addition"],
          examples: ["Span of two nonparallel vectors in R^2", "Span of a single nonzero vector"],
          references: ["Definition 1.4", "Example 1.7"],
        },
        {
          id: "linear-independence",
          title: "Linear Independence",
          page: "pp. 18-23",
          type: "Concept",
          definition: "A list of vectors is linearly independent when no vector in the list can be written as a linear combination of the others.",
          prerequisites: ["Span", "Linear combinations", "Zero vector"],
          examples: ["Two nonparallel vectors in R^2", "Three vectors in R^2 are dependent"],
          references: ["Definition 1.9", "Proposition 1.11"],
        },
      ],
    },
    {
      id: "ch2",
      title: "Chapter 2: Linear Maps",
      children: [
        {
          id: "kernel",
          title: "Kernel",
          page: "pp. 44-48",
          type: "Definition",
          definition: "The kernel of a linear map is the set of vectors that the map sends to the zero vector.",
          prerequisites: ["Linear maps", "Zero vector", "Subspaces"],
          examples: ["Solutions to Ax = 0", "Kernel of a projection map"],
          references: ["Definition 2.6", "Example 2.8"],
        },
      ],
    },
  ],
};

const initialMessages = [
  {
    role: "tutor",
    kind: "Socratic prompt",
    text: "Choose a concept, write what you currently understand in the workspace, then ask for a hint or a check. I will stay grounded in the selected textbook concept and use questions before direct explanations.",
    citations: [],
  },
];

const defaultMathJaxMacros = {
  R: "\\mathbb{R}",
  C: "\\mathbb{C}",
  Q: "\\mathbb{Q}",
  Z: "\\mathbb{Z}",
  N: "\\mathbb{N}",
  F: "\\mathbb{F}",

  eps: "\\varepsilon",
  emptyset: "\\varnothing",

  Hom: "\\operatorname{Hom}",
  End: "\\operatorname{End}",
  Aut: "\\operatorname{Aut}",
  Spec: "\\operatorname{Spec}",

  im: "\\operatorname{im}",
  Image: "\\operatorname{Im}",
  rank: "\\operatorname{rank}",
  Span: "\\operatorname{span}",
  id: "\\operatorname{id}",

  abs: ["\\left|#1\\right|", 1],
  norm: ["\\left\\|#1\\right\\|", 1],
  inner: ["\\left\\langle #1,#2\\right\\rangle", 2],
};

function buildMathJaxConfig(textbookMathJax) {
  const basePackages = new Set([
    "ams",
    "newcommand",
    "configmacros",
    "autoload",
    "noundefined",
  ]);

  const textbookPackages = textbookMathJax?.packages || [];

  const packages = Array.from(
    new Set([
      ...basePackages,
      ...textbookPackages,
    ])
  );

  const extensionLoad = textbookPackages
    .filter((name) => !basePackages.has(name))
    .map((name) => `[tex]/${name}`);

  return {
    loader: {
      load: extensionLoad,
    },
    tex: {
      inlineMath: [
        ["\\(", "\\)"],
        ["$", "$"],
      ],
      displayMath: [
        ["\\[", "\\]"],
        ["$$", "$$"],
      ],
      processEscapes: true,
      packages: {
        "[+]": packages,
      },
      macros: {
        ...defaultMathJaxMacros,
        ...(textbookMathJax?.macros || {}),
      },
      environments: {
        ...(textbookMathJax?.environments || {}),
      },
    },
  };
}

function isConceptNode(node) {
  if (!node) return false;
  if (node.nodeKind === "concept") return true;
  if (node.nodeKind === "group") return false;
  if (node.type === "group") return false;

  // Backward compatibility:
  // old section/group nodes usually have children but no definition.
  if (node.children?.length && !node.definition) return false;

  return true;
}

function flattenConcepts(nodes) {
  const result = [];

  function visit(nodeList) {
    for (const node of nodeList || []) {
      if (isConceptNode(node)) {
        result.push(node);
      }

      if (node.children?.length) {
        visit(node.children);
      }
    }
  }

  visit(nodes);
  return result;
}

function conceptMatchesSearch(concept, query) {
  return (
    concept.title?.toLowerCase().includes(query) ||
    (concept.definition || "").toLowerCase().includes(query) ||
    (concept.prerequisites || []).some((p) => p.toLowerCase().includes(query))
  );
}

function filterTreeBySearch(nodes, search) {
  if (!search.trim()) return nodes || [];

  const query = search.toLowerCase();

  function filterNode(node) {
    if (isConceptNode(node)) {
      return conceptMatchesSearch(node, query) ? node : null;
    }

    const filteredChildren = (node.children || [])
      .map(filterNode)
      .filter(Boolean);

    if (filteredChildren.length > 0) {
      return {
        ...node,
        children: filteredChildren,
      };
    }

    return null;
  }

  return (nodes || []).map(filterNode).filter(Boolean);
}

function replaceConceptInTree(nodes, updatedConcept) {
  return (nodes || []).map((node) => {
    if (isConceptNode(node)) {
      return node.id === updatedConcept.id
        ? {
            ...node,
            ...updatedConcept,
          }
        : node;
    }

    return {
      ...node,
      children: replaceConceptInTree(node.children || [], updatedConcept),
    };
  });
}

function buildLearningState(workspace, concept) {
  const trimmed = workspace.trim();
  if (!trimmed) {
    return {
      understands: "No student explanation has been provided yet.",
      gaps: `Needs an initial attempt at explaining ${concept?.title || "this concept"}.`,
      misconception: "Unknown until the student writes or answers a question.",
    };
  }

  const definition = concept?.definition || "";
  const lower = trimmed.toLowerCase();
  const mentionsDefinition = definition
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length > 5)
    .some((word) => lower.includes(word));

  return {
    understands: mentionsDefinition
      ? "The student appears to be engaging with the textbook definition."
      : "The student has made an initial attempt, but may not yet be using the textbook's central definition.",
    gaps: trimmed.length < 180
      ? "The explanation is still brief. Ask for an example, boundary case, or reason why the definition is formulated that way."
      : "The explanation is substantial enough for targeted diagnosis.",
    misconception: mentionsDefinition
      ? "No obvious misconception detected from this short heuristic."
      : `Possible gap: the explanation may not explicitly connect to: ${definition || "the stored textbook definition"}`,
  };
}

async function postJson(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function buildDefaultRefreshFeedback(concept) {
  if (!concept) return "";

  const parts = [];

  if (concept.quality) {
    parts.push(`Quality score: ${concept.quality}`);
  }

  if (concept.qualityRationale) {
    parts.push(`QA rationale: ${concept.qualityRationale}`);
  }

  if (concept.qualityIssues?.length) {
    parts.push(`QA issues:\n- ${concept.qualityIssues.join("\n- ")}`);
  }

  if (concept.qualitySuggestedFix) {
    parts.push(`QA suggested fix: ${concept.qualitySuggestedFix}`);
  }

  if (concept.lastRefreshFeedback) {
    parts.push(`Previous refresh feedback:\n${concept.lastRefreshFeedback}`);
  }

  return parts.join("\n\n");
}

function normalizeTutorMessageText(text) {
  const raw = String(text || "").trim();

  if (!raw) return "";

  function extractJsonCandidate(value) {
    const trimmed = String(value || "").trim();

    // Handles ```json ... ``` or ``` ... ``` wrappers.
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      return fenced[1].trim();
    }

    // Handles surrounding prose before or after JSON.
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return trimmed.slice(firstBrace, lastBrace + 1);
    }

    return trimmed;
  }

  function repairInvalidJsonBackslashes(value) {
    return String(value)
      // Valid JSON escapes are: \" \\ \/ \b \f \n \r \t \uXXXX
      // This doubles TeX-style backslashes such as \ker, \alpha, \(, \).
      .replace(/\\(?!["\\/bfnrtu])/g, "\\\\")
      // Remove raw control characters.
      .replace(/[\u0000-\u001F]+/g, " ");
  }

  function tryParseTutorObject(value) {
    const candidate = extractJsonCandidate(value);

    try {
      return JSON.parse(candidate);
    } catch {
      // Continue.
    }

    try {
      return JSON.parse(repairInvalidJsonBackslashes(candidate));
    } catch {
      return null;
    }
  }

  const parsed = tryParseTutorObject(raw);

  if (parsed && typeof parsed.text === "string") {
    return parsed.text;
  }

  // Last-resort extraction for JSON-like strings where JSON.parse still fails.
  // This handles cases like:
  // {
  //   "kind": "...",
  //   "text": "actual message",
  //   "citations": [...]
  // }
  const textFieldMatch = raw.match(/"text"\s*:\s*"([\s\S]*?)"\s*,\s*"citations"/);

  if (textFieldMatch?.[1]) {
    return textFieldMatch[1]
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\\\/g, "\\")
      .trim();
  }

  return raw;
}

function KeyNotationItem({ item }) {
  const latex = String(item || "").trim();

  return (
    <div className="key-notation-item">
      <div className="key-notation-rendered">
        <span className="key-notation-label">Rendered</span>
        <TypesetText>{notationToMathText(latex)}</TypesetText>
      </div>

      <div className="key-notation-source">
        <span className="key-notation-label">LaTeX</span>
        <code>{latex}</code>
      </div>
    </div>
  );
}

function TypesetText({ children, className = "" }) {
  return (
    <MathJax dynamic>
      <span className={className}>{children}</span>
    </MathJax>
  );
}

function TypesetBlock({ children, className = "" }) {
  return (
    <MathJax dynamic>
      <div className={className}>{children}</div>
    </MathJax>
  );
}

function ConceptTree({ sections, selectedId, onSelect }) {
  const [open, setOpen] = useState({});

  useEffect(() => {
    setOpen((prev) => {
      const nextOpen = {};

      function collectGroups(nodes) {
        for (const node of nodes || []) {
          if (!isConceptNode(node)) {
            nextOpen[node.id] = prev[node.id] ?? true;
            collectGroups(node.children || []);
          }
        }
      }

      collectGroups(sections);
      return nextOpen;
    });
  }, [sections]);

  function renderNode(node, depth = 0) {
    const isConcept = isConceptNode(node);
    const isOpen = open[node.id] ?? true;
    const safeDepth = Math.min(depth, 5);

    if (isConcept) {
      return (
        <button
          key={node.id}
          onClick={() => onSelect(node.id)}
          className={`concept-button depth-${safeDepth} ${selectedId === node.id ? "active" : ""}`}
        >
          <span className="concept-title-row">
            {node.quality === 3 && (
              <span
                className="quality-dot quality-3"
                title="Quality 3: well-formed concept card"
              />
            )}

            {node.quality === 2 && (
              <span
                className="quality-dot quality-2"
                title="Quality 2: possibly not valuable"
              />
            )}

            <span className="concept-title">{node.title}</span>
          </span>

          <span className="concept-meta">
            {node.type} · {node.page || node.references?.[0] || "source"}
          </span>
        </button>
      );
    }

    return (
      <div key={node.id} className={`tree-group depth-${safeDepth}`}>
        <button
          className="chapter"
          onClick={() =>
            setOpen((prev) => ({
              ...prev,
              [node.id]: !(prev[node.id] ?? true),
            }))
          }
        >
          {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          {node.title}
        </button>

        {isOpen && (
          <div className="concept-list">
            {(node.children || []).map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="tree">
      {(sections || []).map((node) => renderNode(node, 0))}
    </div>
  );
}

function arrayToTextareaValue(items) {
  return (items || []).join("\n");
}

function textareaValueToArray(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function notationToMathText(value) {
  const text = String(value || "").trim();

  if (!text) return "";

  const alreadyDelimited =
    text.includes("\\(") ||
    text.includes("\\)") ||
    text.includes("\\[") ||
    text.includes("\\]") ||
    text.includes("$$") ||
    text.includes("$");

  return alreadyDelimited ? text : `\\(${text}\\)`;
}

function CollapsibleField({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="collapsible-field">
      <button
        type="button"
        className="collapsible-field-header"
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>{title}</span>
        <span className="collapsible-chevron">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="collapsible-field-body">
          {children}
        </div>
      )}
    </div>
  );
}

function TextField({ title, value, defaultOpen = false }) {
  if (!isNonEmptyString(value)) return null;

  return (
    <CollapsibleField title={title} defaultOpen={defaultOpen}>
      <p>{value}</p>
    </CollapsibleField>
  );
}

function ListField({ title, items, defaultOpen = false }) {
  if (!isNonEmptyArray(items)) return null;

  return (
    <CollapsibleField title={title} defaultOpen={defaultOpen}>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </CollapsibleField>
  );
}

function PillListField({ title, items, defaultOpen = false }) {
  if (!isNonEmptyArray(items)) return null;

  return (
    <CollapsibleField title={title} defaultOpen={defaultOpen}>
      <div className="pill-row">
        {items.map((item) => (
          <span key={item} className="pill">{item}</span>
        ))}
      </div>
    </CollapsibleField>
  );
}

function EditableTextField({
  title,
  field,
  value,
  defaultOpen = false,
  onSaveField,
  savingField,
  onGenerateField,
  generatingField,
  placeholder = "",
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || "");

  useEffect(() => {
    if (!editing) {
      setDraft(value || "");
    }
  }, [value, editing]);

  const saving = savingField === field;
  const generating = generatingField === field;

  return (
    <CollapsibleField title={title} defaultOpen={defaultOpen}>
      {editing ? (
        <>
          <textarea
            className="field-edit-textarea"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={placeholder}
            disabled={saving}
          />

          <div className="field-edit-actions">
            <button
              className="mini-save-button"
              onClick={async () => {
                await onSaveField?.(field, draft);
                setEditing(false);
              }}
              disabled={saving}
            >
              {saving ? "Saving..." : "Save"}
            </button>

            <button
              className="mini-cancel-button"
              onClick={() => {
                setDraft(value || "");
                setEditing(false);
              }}
              disabled={saving}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
		  <div className="field-generate-top">
		    <button
			  className="mini-generate-button"
			  onClick={() => onGenerateField?.(field)}
			  disabled={generating}
		    >
		  	  {generating ? "Generating..." : "Generate"}
		    </button>
		  </div>
		  
          <TypesetBlock>
		    {isNonEmptyString(value) ? value : "None detected yet."}
		  </TypesetBlock>

          <div className="field-edit-footer">
            <button
              className="field-edit-button"
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
          </div>
        </>
      )}
    </CollapsibleField>
  );
}

function EditableListField({
  title,
  field,
  items,
  defaultOpen = false,
  onSaveField,
  savingField,
  onGenerateField,
  generatingField,
  asPills = false,
  placeholder = "One item per line",
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(arrayToTextareaValue(items));

  useEffect(() => {
    if (!editing) {
      setDraft(arrayToTextareaValue(items));
    }
  }, [items, editing]);

  const saving = savingField === field;
  const generating = generatingField === field;
  const hasItems = isNonEmptyArray(items);

  return (
    <CollapsibleField title={title} defaultOpen={defaultOpen}>
      {editing ? (
        <>
          <textarea
            className="field-edit-textarea"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={placeholder}
            disabled={saving}
          />

          <div className="field-edit-actions">
            <button
              className="mini-save-button"
              onClick={async () => {
                await onSaveField?.(field, textareaValueToArray(draft));
                setEditing(false);
              }}
              disabled={saving}
            >
              {saving ? "Saving..." : "Save"}
            </button>

            <button
              className="mini-cancel-button"
              onClick={() => {
                setDraft(arrayToTextareaValue(items));
                setEditing(false);
              }}
              disabled={saving}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
		  <div className="field-generate-top">
		    <button
			  className="mini-generate-button"
			  onClick={() => onGenerateField?.(field)}
			  disabled={generating}
		    >
			  {generating ? "Generating..." : "Generate"}
		    </button>
		  </div>
		  
          {hasItems ? (
			  field === "keyNotation" ? (
				<div className="key-notation-list">
				  {items.map((item) => (
					<KeyNotationItem key={item} item={item} />
				  ))}
				</div>
			  ) : asPills ? (
				<div className="pill-row">
				  {items.map((item) => (
					<span key={item} className="pill">
					  <TypesetText>{item}</TypesetText>
					</span>
				  ))}
				</div>
			  ) : (
				<ul>
				  {items.map((item) => (
					<li key={item}>
					  <TypesetText>{item}</TypesetText>
					</li>
				  ))}
				</ul>
			  )
			) : (
			  <p className="muted">None detected yet.</p>
			)
		  }


          <div className="field-edit-footer">
            <button
              className="field-edit-button"
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
          </div>
        </>
      )}
    </CollapsibleField>
  );
}

function QualityField({ concept, onRerunQA, assessingQA }) {
  const hasQuality =
    concept.quality ||
    concept.qualityRationale ||
    concept.qualityIssues?.length ||
    concept.qualitySuggestedFix;

  return (
    <CollapsibleField title="Concept card quality" defaultOpen={false}>
      <p className="muted">
        {concept.quality === 3 && "3: Well-formed"}
        {concept.quality === 2 && "2: Possibly not valuable"}
        {concept.quality === 1 && "1: Probably not valuable"}
        {!concept.quality && "Not assessed"}
      </p>

      {concept.qualityRationale && (
        <TypesetBlock className="quality-rationale">
		  {concept.qualityRationale}
		</TypesetBlock>
      )}

      {concept.qualityIssues?.length > 0 && (
        <ul>
          {concept.qualityIssues.map((issue) => (
            <li key={issue}>
			  <TypesetText>{issue}</TypesetText>
			</li>
          ))}
        </ul>
      )}

      {concept.qualitySuggestedFix && (
        <TypesetBlock className="quality-suggested-fix">
		  {`Suggested fix: ${concept.qualitySuggestedFix}`}
		</TypesetBlock>
      )}

      {concept.qualityAssessedAt && (
        <p className="muted small">
          Last assessed: {new Date(concept.qualityAssessedAt).toLocaleString()}
        </p>
      )}

      <div className="field-edit-footer">
        <button
          className="mini-qa-button"
          onClick={onRerunQA}
          disabled={assessingQA}
        >
          {assessingQA ? "Re-running QA..." : "Re-run QA"}
        </button>
      </div>
    </CollapsibleField>
  );
}

function ConceptCard({
  concept,
  refreshFeedback,
  onRefreshFeedbackChange,
  onRefresh,
  refreshing,
  onSaveField,
  savingField,
  onGenerateField,
  generatingField,
  onRerunQA,
  assessingQA,
}) {
  if (!concept) return null;

  const statementIsDifferent =
    concept.statement &&
    concept.statement.trim() &&
    concept.statement.trim() !== concept.definition?.trim();
  
  const fieldActions = {
  onSaveField,
  savingField,
  onGenerateField,
  generatingField,
};
  return (
    <div className="card">
      <div className="card-header concept-card-header">
        <div className="card-header-title">
          <BookOpen size={18} />
          <h2>Concept Card</h2>
        </div>
      </div>

      <div className="card-body stacked">
        {concept.hierarchyPath?.length > 0 && (
          <div className="concept-breadcrumb">
            {concept.hierarchyPath.join(" › ")}
          </div>
        )}
		<EditableTextField
		  title="Title"
		  field="title"
		  value={concept.title || ""}
		  defaultOpen={false}
		  {...fieldActions}
		  placeholder="Enter the concept title..."
		/>

		<EditableTextField
		  title="Type"
		  field="type"
		  value={concept.type || ""}
		  defaultOpen={false}
		  {...fieldActions}
		  placeholder="Definition, Theorem, Example, Exercise, Concept, Technique..."
		/>

		<EditableTextField
		  title="Page or source label"
		  field="page"
		  value={concept.page || ""}
		  defaultOpen={false}
		  {...fieldActions}
		  placeholder="Enter source label, page, section, or reference..."
		/>

        <EditableTextField
		  title="Textbook definition or excerpt"
		  field="definition"
		  value={concept.definition || ""}
		  defaultOpen={true}
		  {...fieldActions}
		  placeholder="Enter the textbook-grounded definition or excerpt..."
		/>

        {statementIsDifferent && (
		  <EditableTextField
			title="Statement"
			field="statement"
			value={concept.statement || ""}
			defaultOpen={true}
			{...fieldActions}
			placeholder="Enter the theorem, proposition, exercise, or question statement..."
		  />
		)}

		<EditableTextField
		  title="Why this matters"
		  field="teachingRole"
		  value={concept.teachingRole || ""}
		  defaultOpen={false}
		  {...fieldActions}
		  placeholder="Explain why this concept matters instructionally..."
		/>

		<EditableListField
		  title="Hierarchy path"
		  field="hierarchyPath"
		  items={concept.hierarchyPath || []}
		  defaultOpen={false}
		  {...fieldActions}
		  asPills={true}
		  placeholder="One hierarchy label per line, up to 4 labels"
		/>

		<EditableListField
		  title="Prerequisites"
		  field="prerequisites"
		  items={concept.prerequisites || []}
		  defaultOpen={false}
		  {...fieldActions}
		  asPills={true}
		/>

		<EditableListField
		  title="Depends on earlier in this section"
		  field="dependsOnEarlierInExcerpt"
		  items={concept.dependsOnEarlierInExcerpt || []}
		  defaultOpen={false}
		  {...fieldActions}
		  asPills={true}
		/>

		<EditableListField
		  title="Key notation"
		  field="keyNotation"
		  items={concept.keyNotation || []}
		  defaultOpen={false}
		  {...fieldActions}
		  asPills={true}
		/>

		<EditableListField
		  title="Useful examples"
		  field="examples"
		  items={concept.examples || []}
		  defaultOpen={false}
		  {...fieldActions}
		/>

		<EditableListField
		  title="Non-examples or boundary cases"
		  field="nonExamples"
		  items={concept.nonExamples || []}
		  defaultOpen={false}
		  {...fieldActions}
		/>

		<EditableListField
		  title="Common confusions"
		  field="commonConfusions"
		  items={concept.commonConfusions || []}
		  defaultOpen={false}
		  {...fieldActions}
		/>

		<EditableListField
		  title="Proof ideas"
		  field="proofIdeas"
		  items={concept.proofIdeas || []}
		  defaultOpen={false}
		  {...fieldActions}
		/>

		<EditableListField
		  title="Related results and nearby concepts"
		  field="relatedResults"
		  items={concept.relatedResults || []}
		  defaultOpen={false}
		  {...fieldActions}
		/>

		<EditableTextField
		  title="How the textbook presents it"
		  field="sourceSummary"
		  value={concept.sourceSummary || ""}
		  defaultOpen={false}
		  {...fieldActions}
		  placeholder="Summarize how the textbook presents this concept..."
		/>

		<EditableListField
		  title="References"
		  field="references"
		  items={concept.references || []}
		  defaultOpen={false}
		  {...fieldActions}
		/>

        <QualityField
		  concept={concept}
		  onRerunQA={onRerunQA}
		  assessingQA={assessingQA}
		/>

        <CollapsibleField title="Refresh feedback" defaultOpen={false}>
          <textarea
            className="refresh-feedback"
            value={refreshFeedback || ""}
            onChange={(event) => onRefreshFeedbackChange?.(event.target.value)}
            placeholder="Edit or add feedback for regenerating this concept card..."
          />

          <button
            className="mini-refresh-button"
            onClick={onRefresh}
            disabled={refreshing}
          >
            {refreshing ? "Refreshing..." : "Refresh concept card"}
          </button>
        </CollapsibleField>
      </div>
    </div>
  );
}

export default function App() {
  const [textbook, setTextbook] = useState(demoTextbook);
  const [selectedId, setSelectedId] = useState("span");
  const [savedTextbooks, setSavedTextbooks] = useState([]);
  const [loadingSavedTextbooks, setLoadingSavedTextbooks] = useState(false);
  const [search, setSearch] = useState("");
  const [workspaceByConcept, setWorkspaceByConcept] = useState({});
  const [messagesByConcept, setMessagesByConcept] = useState({ span: initialMessages });
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("Demo mode. Upload a .tex, .txt, or .pdf textbook to use your own material.");
  const [refreshingConceptId, setRefreshingConceptId] = useState(null);
  const [refreshFeedbackByConcept, setRefreshFeedbackByConcept] = useState({});
  const [assessingConceptId, setAssessingConceptId] = useState(null);
  const [savingConceptField, setSavingConceptField] = useState(null);
  const [generatingConceptField, setGeneratingConceptField] = useState(null);
  const [loadingTutor, setLoadingTutor] = useState(false);
  const [batchRefreshQuality, setBatchRefreshQuality] = useState("2");
  const [batchRefreshFeedback, setBatchRefreshFeedback] = useState("");
  const [batchRefreshLimit, setBatchRefreshLimit] = useState(50);
  const [batchRefreshing, setBatchRefreshing] = useState(false);
  
  

  const concepts = useMemo(() => flattenConcepts(textbook.sections || []), [textbook]);
  const selectedConcept = concepts.find((concept) => concept.id === selectedId) || concepts[0];
  const activeConceptId = selectedConcept?.id || selectedId;
  const workspace = workspaceByConcept[activeConceptId] || "";
  const messages = messagesByConcept[selectedId] || initialMessages;
  const learningState = buildLearningState(workspace, selectedConcept);
  const mathJaxConfig = useMemo(
    () => buildMathJaxConfig(textbook?.mathJax),
    [textbook?.mathJax]
  );

  const mathJaxKey = useMemo(
    () =>
      `${textbook?.id || "demo"}-${JSON.stringify(textbook?.mathJax?.macros || {})}-${JSON.stringify(textbook?.mathJax?.packages || [])}`,
    [textbook?.id, textbook?.mathJax]
  );
  

  useEffect(() => {
    refreshSavedTextbooks();
  }, []);
  useEffect(() => {
    if (!selectedConcept && concepts.length > 0) setSelectedId(concepts[0].id);
  }, [concepts, selectedConcept]);
  
  useEffect(() => {
    if (!textbook?.id || !selectedConcept?.id) return;
    if (textbook.id === "demo") return;

    loadWorkspaceForConcept(textbook.id, selectedConcept.id);
  }, [textbook?.id, selectedConcept?.id]);
  
  const filteredSections = useMemo(() => {
	return filterTreeBySearch(textbook.sections || [], search);
  }, [search, textbook]);

async function loadWorkspaceForConcept(textbookId, conceptId) {
  if (!textbookId || !conceptId) return;

  if (textbookId === "demo") return;

  try {
    const response = await fetch(
      `${API_BASE}/api/workspaces/${encodeURIComponent(textbookId)}/${encodeURIComponent(conceptId)}`
    );

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const data = await response.json();

    setWorkspaceByConcept((prev) => ({
	  ...prev,
	  [conceptId]: data.workspace || "",
	}));
  } catch (error) {
    console.error(error);
    setStatus(`Could not load saved workspace: ${error.message}`);
  }
}

async function refreshSavedTextbooks() {
  setLoadingSavedTextbooks(true);

  try {
    const response = await fetch(`${API_BASE}/api/textbooks`);

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const data = await response.json();
    setSavedTextbooks(data.textbooks || []);
    setStatus(`Found ${(data.textbooks || []).length} saved textbook(s).`);
  } catch (error) {
    console.error(error);
    setStatus(`Could not load saved textbooks: ${error.message}`);
  } finally {
    setLoadingSavedTextbooks(false);
  }
}

async function batchRefreshConceptCards() {
  if (!textbook?.id) return;

  if (textbook.id === "demo") {
    setStatus("Demo concepts cannot be batch refreshed. Upload or load a textbook first.");
    return;
  }

  const quality = Number(batchRefreshQuality);

  if (![1, 2, 3].includes(quality)) {
    setStatus("Choose a quality rank of 1, 2, or 3.");
    return;
  }

  setBatchRefreshing(true);
  setStatus(`Refreshing concepts with quality ${quality}...`);

  try {
    const response = await fetch(
      `${API_BASE}/api/textbooks/${encodeURIComponent(textbook.id)}/concepts/batch-refresh`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quality,
          feedback: batchRefreshFeedback,
          limit: Number(batchRefreshLimit) || 5,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const data = await response.json();

    setTextbook(data.textbook);

    setStatus(
      `Batch refresh complete. Matched ${data.matchedCount}, attempted ${data.attemptedCount}, refreshed ${data.refreshedCount}, failed ${data.failedCount}.`
    );
  } catch (error) {
    console.error(error);
    setStatus(`Batch refresh failed: ${error.message}`);
  } finally {
    setBatchRefreshing(false);
  }
}

async function loadSavedTextbook(textbookId) {
  if (!textbookId) return;

  setStatus("Loading saved textbook...");

  try {
    const response = await fetch(`${API_BASE}/api/textbooks/${encodeURIComponent(textbookId)}`);

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const data = await response.json();
    setTextbook(data.textbook);

    const firstConcept = flattenConcepts(data.textbook.sections || [])[0];

    if (firstConcept) {
      setSelectedId(firstConcept.id);
    }

    setWorkspaceByConcept({});
    setMessagesByConcept({});
    setInput("");

    setStatus(
      `Loaded ${data.textbook.title}: ${data.conceptCount} concepts, ${data.chunkCount} chunks.`
    );
  } catch (error) {
    console.error(error);
    setStatus(`Could not load saved textbook: ${error.message}`);
  }
}

  function appendMessage(message) {
    setMessagesByConcept((prev) => ({
      ...prev,
      [selectedId]: [...(prev[selectedId] || initialMessages), message],
    }));
  }

  async function handleUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setStatus(`Uploading and ingesting ${file.name}...`);
    const form = new FormData();
    form.append("textbook", file);
    try {
      const response = await fetch(`${API_BASE}/api/textbooks`, { method: "POST", body: form });
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      setTextbook(data.textbook);
      const firstConcept = flattenConcepts(data.textbook.sections)[0];
      if (firstConcept) setSelectedId(firstConcept.id);
      setWorkspaceByConcept({});
      setMessagesByConcept({});
      setStatus(`Loaded ${data.textbook.title}: ${data.conceptCount} concepts, ${data.chunkCount} chunks.`);
	  await refreshSavedTextbooks();
    } catch (error) {
      console.error(error);
      setStatus(`Upload failed: ${error.message}`);
    } finally {
      event.target.value = "";
    }
  }

  async function handleSend(mode = "question") {
    const trimmed = input.trim();
    if (mode === "question" && !trimmed) return;
    if (!selectedConcept) return;

    if (mode === "question") appendMessage({ role: "student", text: trimmed, citations: [] });
    setLoadingTutor(true);
    try {
      const data = await postJson("/api/tutor", {
        textbookId: textbook.id,
        conceptId: selectedConcept.id,
        concept: selectedConcept,
        workspace,
        userMessage: trimmed,
        mode,
      });
      appendMessage({ role: "tutor", kind: data.kind, text: data.text, citations: data.citations || [] });
    } catch (error) {
      console.error(error);
      appendMessage({
        role: "tutor",
        kind: "Local fallback",
        text: `I could not reach the tutor backend. Try again after checking that the server is running. Details: ${error.message}`,
        citations: [],
      });
    } finally {
      setLoadingTutor(false);
      setInput("");
    }
  }

async function generateConceptField(field) {
  if (!textbook?.id || !selectedConcept?.id) return;

  if (textbook.id === "demo") {
    setStatus("Demo concepts cannot generate fields. Upload or load a textbook first.");
    return;
  }

  setGeneratingConceptField(field);
  setStatus(`Generating ${field} for ${selectedConcept.title}...`);

  try {
    const response = await fetch(
      `${API_BASE}/api/textbooks/${encodeURIComponent(textbook.id)}/concepts/${encodeURIComponent(selectedConcept.id)}/fields/${encodeURIComponent(field)}/generate`,
      {
        method: "POST",
      }
    );

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const data = await response.json();

	setTextbook((prev) => {
	  const baseTextbook = data.textbook || prev;

	  return {
		...baseTextbook,
		sections: replaceConceptInTree(
		  baseTextbook.sections || prev.sections || [],
		  data.concept
		),
	  };
	});

	setSelectedId(data.concept.id);

	setStatus(`Generated new content for ${field} on ${data.concept.title}.`);
  } catch (error) {
    console.error(error);
    setStatus(`Generate failed: ${error.message}`);
  } finally {
    setGeneratingConceptField(null);
  }
}

async function saveConceptField(field, value) {
  if (!textbook?.id || !selectedConcept?.id) return;

  if (textbook.id === "demo") {
    setStatus("Demo concepts cannot be edited. Upload or load a textbook first.");
    return;
  }

  setSavingConceptField(field);
  setStatus(`Saving ${field} for ${selectedConcept.title}...`);

  try {
    const response = await fetch(
      `${API_BASE}/api/textbooks/${encodeURIComponent(textbook.id)}/concepts/${encodeURIComponent(selectedConcept.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          updates: {
		    [field]: value,
		  },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const data = await response.json();

    setTextbook(data.textbook);
    setSelectedId(data.concept.id);

    setStatus(`Saved ${field} for ${data.concept.title}.`);
  } catch (error) {
    console.error(error);
    setStatus(`Save failed: ${error.message}`);
    throw error;
  } finally {
    setSavingConceptField(null);
  }
}

async function rerunSelectedConceptQA() {
  if (!textbook?.id || !selectedConcept?.id) return;

  if (textbook.id === "demo") {
    setStatus("Demo concepts cannot be reassessed. Upload or load a textbook first.");
    return;
  }

  setAssessingConceptId(selectedConcept.id);
  setStatus(`Re-running QA for ${selectedConcept.title}...`);

  try {
    const response = await fetch(
      `${API_BASE}/api/textbooks/${encodeURIComponent(textbook.id)}/concepts/${encodeURIComponent(selectedConcept.id)}/rerun-qa`,
      {
        method: "POST",
      }
    );

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const data = await response.json();

    setTextbook(data.textbook);
    setSelectedId(data.concept.id);

    setRefreshFeedbackByConcept((prev) => ({
      ...prev,
      [data.concept.id]: buildDefaultRefreshFeedback(data.concept),
    }));

    setStatus(
      `QA updated for ${data.concept.title}. Quality: ${data.concept.quality || "unrated"}.`
    );
  } catch (error) {
    console.error(error);
    setStatus(`QA rerun failed: ${error.message}`);
  } finally {
    setAssessingConceptId(null);
  }
}

async function refreshConceptCard() {
  if (!textbook?.id || !selectedConcept?.id) return;

  if (textbook.id === "demo") {
    setStatus("Demo concepts cannot be refreshed. Upload or load a textbook first.");
    return;
  }

  const feedback =
    refreshFeedbackByConcept[selectedConcept.id] ??
    buildDefaultRefreshFeedback(selectedConcept);

  setRefreshingConceptId(selectedConcept.id);
  setStatus(`Refreshing concept card for ${selectedConcept.title}...`);

  try {
    const response = await fetch(
      `${API_BASE}/api/textbooks/${encodeURIComponent(textbook.id)}/concepts/${encodeURIComponent(selectedConcept.id)}/refresh`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback }),
      }
    );

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const data = await response.json();

    setTextbook(data.textbook);
    setSelectedId(data.concept.id);

    setRefreshFeedbackByConcept((prev) => ({
      ...prev,
      [data.concept.id]: buildDefaultRefreshFeedback(data.concept),
    }));

    setStatus(
      `Refreshed ${data.concept.title}. Quality: ${data.concept.quality || "unrated"}.`
    );
  } catch (error) {
    console.error(error);
    setStatus(`Concept refresh failed: ${error.message}`);
  } finally {
    setRefreshingConceptId(null);
  }
}
  async function saveWorkspace() {
    if (!selectedConcept) return;
    try {
      await postJson("/api/workspaces", {
        textbookId: textbook.id,
        conceptId: activeConceptId,
        workspace,
        learningState,
      });
      setStatus(`Saved workspace for ${selectedConcept.title}.`);
    } catch (error) {
      setStatus(`Save failed: ${error.message}`);
    }
  }

  return (
    <MathJaxContext
	  key={mathJaxKey}
	  version={3}
	  config={mathJaxConfig}
	>
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-row">
          <div className="brand-icon"><Brain size={21} /></div>
          <div>
            <h1>Textbook Socratic Tutor</h1>
            <p>A streamlined, textbook-grounded tutoring workspace.</p>
          </div>
        </div>
        <div className="topbar-actions">
	    <div className="saved-loader">
		  <select
		    value=""
		    onChange={(event) => loadSavedTextbook(event.target.value)}
		    disabled={loadingSavedTextbooks}
		  >
		    <option value="">
		  	{loadingSavedTextbooks ? "Loading saved textbooks..." : "Load saved textbook"}
		    </option>

		    {savedTextbooks.map((item) => (
			  <option key={item.id} value={item.id}>
			    {item.title} ({item.conceptCount} concepts)
			  </option>
		    ))}
		  </select>

		  <button className="secondary-button" onClick={refreshSavedTextbooks}>
		    Refresh
		  </button>
	    </div>

	    <label className="upload-button">
		  <Upload size={16} />
		  Upload PDF, TeX, or TXT
		  <input type="file" accept=".pdf,.tex,.txt" onChange={handleUpload} />
	    </label>
	  </div>
      </header>

      <div className="status-bar">{status}</div>

      <main className="layout">
        <aside className="sidebar card">
          <div className="card-header"><FileText size={18} /> <h2>Concept Navigator</h2></div>
          <p className="muted small">{textbook.title}</p>
		  
		  {textbook.mathJax?.unsupportedPackages?.length > 0 && (
		    <p className="muted small">
			  Unsupported TeX packages: {textbook.mathJax.unsupportedPackages.join(", ")}
		    </p>
		  )}
		  
		  <div className="batch-refresh-panel">
		  <div className="label">Batch refresh</div>

		  <div className="batch-refresh-row">
			<select
			  value={batchRefreshQuality}
			  onChange={(event) => setBatchRefreshQuality(event.target.value)}
			  disabled={batchRefreshing}
			>
			  <option value="1">Quality 1</option>
			  <option value="2">Quality 2</option>
			  <option value="3">Quality 3</option>
			</select>

			<input
			  type="number"
			  min="1"
			  max="500"
			  value={batchRefreshLimit}
			  onChange={(event) => setBatchRefreshLimit(event.target.value)}
			  disabled={batchRefreshing}
			  title="Maximum number of concepts to refresh"
			/>
		  </div>

		  <textarea
			className="batch-refresh-feedback"
			value={batchRefreshFeedback}
			onChange={(event) => setBatchRefreshFeedback(event.target.value)}
			disabled={batchRefreshing}
			placeholder="Optional feedback to apply to every refreshed concept..."
		  />

		  <button
			className="batch-refresh-button"
			onClick={batchRefreshConceptCards}
			disabled={batchRefreshing || textbook.id === "demo"}
		  >
			{batchRefreshing ? "Refreshing..." : "Refresh rank"}
		  </button>
		  </div>
		  
          <div className="search-row">
            <Search size={15} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search concepts" />
          </div>
          <ConceptTree sections={filteredSections} selectedId={selectedId} onSelect={setSelectedId} />
        </aside>

        <section className="workspace-column">
          <div className="card">
            <div className="concept-header">
              <div>
                <h2 className="main-title">
				  <TypesetText>{selectedConcept?.title || "No concept selected"}</TypesetText>
				</h2>
				<p className="muted">
				  <TypesetText>
					{`${selectedConcept?.type || ""} · ${selectedConcept?.page || selectedConcept?.references?.[0] || "source"}`}
				  </TypesetText>
				</p>

              </div>
              <div className="button-row">
                <button className="secondary-button" onClick={saveWorkspace}>Save workspace</button>
                <button className="check-button" onClick={() => handleSend("check")} disabled={loadingTutor}>
                  <CheckCircle2 size={16} /> Check understanding
                </button>
              </div>
            </div>
            <div className="workspace-prompt">
              <Sparkles size={16} />
              Write what you currently understand, an attempted proof, an example, or a precise confusion.
            </div>
            <textarea
              className="workspace"
              value={workspace}
              onChange={(e) =>
			    setWorkspaceByConcept((prev) => ({
				  ...prev,
				  [activeConceptId]: e.target.value,
			    }))
			  }
              placeholder={`Explain ${selectedConcept?.title || "the selected concept"} in your own words...`}
            />
          </div>
          <ConceptCard
			  concept={selectedConcept}
			  refreshFeedback={
				refreshFeedbackByConcept[selectedConcept?.id] ??
				buildDefaultRefreshFeedback(selectedConcept)
			  }
			  onRefreshFeedbackChange={(value) =>
				setRefreshFeedbackByConcept((prev) => ({
				  ...prev,
				  [selectedConcept.id]: value,
				}))
			  }
			  onRefresh={refreshConceptCard}
			  refreshing={refreshingConceptId === selectedConcept?.id}
			  onSaveField={saveConceptField}
			  savingField={savingConceptField}
			  onGenerateField={generateConceptField}
			  generatingField={generatingConceptField}
			  onRerunQA={rerunSelectedConceptQA}
			  assessingQA={assessingConceptId === selectedConcept?.id}
			/>
        </section>

        <section className="tutor-column">
          <div className="card tutor-card">
            <div className="card-header"><MessageSquare size={18} /> <h2>Tutor Panel</h2></div>
            <p className="muted small">Responses are constrained to the selected concept and retrieved textbook excerpts.</p>
            <div className="messages">
              {messages.map((message, index) => (
                <div key={`${message.role}-${index}`} className={`message ${message.role}`}>
                  {message.kind && <div className="message-kind"><Lightbulb size={13} />{message.kind}</div>}
                  <TypesetBlock>
					{normalizeTutorMessageText(message.text)}
				  </TypesetBlock>
                  
                </div>
              ))}
            </div>
            <div className="composer">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSend("question"); }}
                placeholder="Ask for a hint, diagnosis, or clarification"
              />
              <button onClick={() => handleSend("question")} disabled={loadingTutor}><Send size={16} /></button>
            </div>
          </div>
        </section>
      </main>
    </div>
	</MathJaxContext>
  );
}
