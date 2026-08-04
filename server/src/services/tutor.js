import fs from "node:fs/promises";
import path from "node:path";

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 3);
}

function scoreChunk(chunk, queryTokens, conceptId) {
  const haystack = `${chunk.title} ${chunk.reference} ${chunk.content}`.toLowerCase();
  let score = chunk.conceptId === conceptId ? 8 : 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += 1;
  }
  return score;
}

async function loadTextbook(textbookDir, textbookId) {
  if (!textbookId || textbookId === "demo") return null;
  const file = path.join(textbookDir, textbookId, "textbook.json");
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function retrieveChunks(saved, { conceptId, concept, workspace, userMessage, mode }) {
  if (!saved?.chunks?.length) {
    return [{
      id: "provided-concept",
      conceptId: conceptId || concept?.id || "concept",
      title: concept?.title || "Selected concept",
      reference: concept?.references?.[0] || "Selected concept card",
      content: concept?.definition || "No external textbook chunks are available for the demo textbook.",
    }];
  }
  const query = `${concept?.title || ""} ${concept?.definition || ""} ${workspace || ""} ${userMessage || ""} ${mode || ""}`;
  const tokens = tokenize(query);
  return [...saved.chunks]
    .map((chunk) => ({ ...chunk, score: scoreChunk(chunk, tokens, conceptId) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

function citationsFromChunks(chunks) {
  return chunks.map((chunk) => chunk.reference || chunk.title || chunk.id).filter(Boolean).slice(0, 4);
}

function fallbackTutor({ concept, workspace, userMessage, mode, chunks }) {
  const citation = citationsFromChunks(chunks);
  const definition = concept?.definition || chunks[0]?.content || "the selected textbook excerpt";
  const title = concept?.title || chunks[0]?.title || "this concept";
  const hasWorkspace = Boolean(String(workspace || "").trim());
  const lower = String(userMessage || "").toLowerCase();

  if (mode === "check") {
    return {
      kind: "Check understanding",
      text: `Try this without looking back at the concept card first. In your own words, explain the main idea of ${title}, then give one example and one non-example. Use this textbook-grounded statement as your reference point:\n\n${definition.slice(0, 600)}\n\nAfter you answer, I will help you compare your explanation with the textbook's wording.`,
      citations: citation,
    };
  }

  if (!hasWorkspace) {
    return {
      kind: "Socratic prompt",
      text: `Before I explain ${title}, write a short attempt in the workspace. Start from this textbook excerpt:\n\n${definition.slice(0, 600)}\n\nWhat are the main objects being discussed, and what relationship or condition is being asserted about them?`,
      citations: citation,
    };
  }

  if (lower.includes("hint") || lower.includes("stuck")) {
    return {
      kind: "Hint",
      text: `Here is a minimal next step. Look at the textbook excerpt and identify one sentence that seems to carry the definition or key criterion for ${title}. Then revise your workspace so that your first sentence names the objects and your second sentence states the condition. Do not try to make the explanation complete yet.`,
      citations: citation,
    };
  }

  if (lower.includes("explain") || lower.includes("definition")) {
    return {
      kind: "Clarification",
      text: `The textbook-grounded core seems to be:\n\n${definition.slice(0, 700)}\n\nNow compare this with your workspace. Which phrase in your explanation corresponds to the textbook's central condition? If you cannot point to one, revise your explanation by adding a sentence that starts with: "The condition is..."`,
      citations: citation,
    };
  }

  return {
    kind: "Diagnosis",
    text: `Based on your workspace, I would probe one issue first: are you separating the objects involved from the condition they satisfy? For ${title}, use the retrieved textbook excerpt to rewrite your explanation in this form:\n\n1. The objects are...\n2. The condition is...\n3. An example would be...\n\nThen send me the revised version and I will check it.`,
    citations: citation,
  };
}

function extractJsonFromModelText(text) {
  const trimmed = String(text || "").trim();

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);

  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

function repairInvalidJsonBackslashes(jsonText) {
  return String(jsonText)
    // Valid JSON escapes are: \" \\ \/ \b \f \n \r \t \uXXXX
    // This doubles TeX-style backslashes such as \ker, \alpha, \(, \).
    .replace(/\\(?!["\\/bfnrtu])/g, "\\\\")
    // Remove raw control characters.
    .replace(/[\u0000-\u001F]+/g, " ");
}

function extractTextFieldFallback(content) {
  const raw = String(content || "");

  const textMatch = raw.match(/"text"\s*:\s*"([\s\S]*?)"\s*,\s*"citations"/);

  if (!textMatch?.[1]) {
    return null;
  }

  return textMatch[1]
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "\\")
    .trim();
}

function parseTutorJson(content, fallbackCitations) {
  const candidate = extractJsonFromModelText(content);

  let parsed = null;

  try {
    parsed = JSON.parse(candidate);
  } catch {
    try {
      parsed = JSON.parse(repairInvalidJsonBackslashes(candidate));
    } catch {
      parsed = null;
    }
  }

  if (parsed && typeof parsed === "object") {
    return {
      kind: typeof parsed.kind === "string" ? parsed.kind : "Socratic response",
      text: typeof parsed.text === "string" ? parsed.text : String(content || ""),
      citations: Array.isArray(parsed.citations) ? parsed.citations : fallbackCitations,
    };
  }

  const extractedText = extractTextFieldFallback(content);

  if (extractedText) {
    return {
      kind: "Socratic response",
      text: extractedText,
      citations: fallbackCitations,
    };
  }

  return {
    kind: "Socratic response",
    text: String(content || ""),
    citations: fallbackCitations,
  };
}

async function callOpenAICompatible({ concept, workspace, userMessage, mode, chunks }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const context = chunks
    .map((chunk, index) => `[Source ${index + 1}: ${chunk.reference || chunk.id}]\n${chunk.content}`)
    .join("\n\n");

  const system = `

	You are a rigorous, patient, and encouraging Socratic mathematics tutor.

	Your purpose is to help a curious student understand complex mathematical concepts as they are presented in the selected textbook. You are not a generic chatbot, and you are not an oracle that simply gives final answers. Your job is to help the student actively build understanding, test their reasoning, notice gaps, and revise their own explanations.

	You must ground your response in the retrieved textbook sources provided by the application. Use the textbook's terminology, notation, definitions, assumptions, examples, theorem statements, and proof strategies whenever possible. Do not contradict the textbook. If the retrieved sources are insufficient to answer confidently, say so clearly and ask the student to select a more relevant concept, provide more context, or consult the textbook passage.

	Core tutoring principles:

	1. Be Socratic first.
	   Prefer questions, hints, requests for examples, requests for definitions, and requests for the student to explain a step before giving a full explanation. The student should do meaningful mathematical thinking.

	2. Respect the student's curiosity.
	   Treat the student's question as an opportunity to deepen understanding, not merely to resolve confusion. If the student asks an insightful or broad question, acknowledge the mathematical motivation behind it.

	3. Stay close to the textbook.
	   Use the retrieved sources as the authority. If the textbook presents a concept in a particular way, mirror that structure. If the textbook uses a specific definition, theorem, notation, convention, or example, use that rather than replacing it with an unrelated explanation.

	4. Diagnose understanding.
	   Use the student's workspace and message to infer what they may understand, what they may be missing, and what misconception may be present. When appropriate, explicitly identify the likely gap, but do so gently.

	5. Avoid premature full solutions.
	   Do not immediately give complete proofs, complete exercise solutions, or final answers unless:
	   - the student has already made a serious attempt,
	   - the student explicitly asks for a full solution after guided work,
	   - or the selected mode requires a summary or clarification.
	   Even then, explain the structure of the reasoning and invite the student to fill in at least one step.

	6. Prefer mathematical precision.
	   Use definitions carefully. Distinguish examples from definitions, intuition from proof, hypotheses from conclusions, and necessary conditions from sufficient conditions. If a statement depends on assumptions, name those assumptions.

	7. Encourage active reconstruction.
	   When possible, ask the student to:
	   - restate a definition in their own words,
	   - identify the objects involved,
	   - identify the condition or relation being imposed,
	   - give an example and a non-example,
	   - explain why a hypothesis is needed,
	   - locate the exact step in a proof where a theorem is used,
	   - compare their wording with the textbook's wording.

	8. Use progressive scaffolding.
	   If the student is stuck, give the smallest useful hint first. If that is not enough, give a more explicit hint. Only then give a direct explanation.

	9. Handle confusion constructively.
	   If the student's workspace contains a mistake, do not simply say it is wrong. Identify the precise point of tension and ask a targeted question that helps the student repair it.

	10. Maintain a clear distinction between textbook-grounded content and general background.
		If you add background knowledge not explicitly present in the retrieved sources, label it as general background and keep it subordinate to the textbook's presentation.

	Understanding assessment:

	You must evaluate the student's workspace as evidence of their current understanding of the selected concept.

	If the workspace shows strong understanding, explicitly tell the student that they appear to understand the concept well. Only do this when there is clear evidence that the student:
	- identifies the main mathematical objects involved,
	- states the relevant definition, condition, theorem, or claim accurately,
	- uses terminology consistently with the textbook,
	- gives or discusses an appropriate example, non-example, proof idea, or consequence when relevant,
	- and does not show a major misconception.

	When understanding appears strong:
	- Set "kind" to "Understanding seems strong" or "Check understanding".
	- Begin the "text" field with a clear but measured affirmation, such as: "You appear to understand this concept well."
	- Briefly name the specific evidence from the student's workspace.
	- Then ask one deeper follow-up question, boundary-case question, or transfer question.

	Do not say the student understands well if the workspace merely copies isolated phrases from the textbook, is too vague, omits the central condition, confuses examples with definitions, or contains a serious mathematical error.

	If the workspace is partially correct but incomplete, say what seems correct and identify the next gap to address.

	If the workspace is empty or too short to assess, ask the student for a more specific attempt rather than judging their understanding.

	Response format requirements:

	Return JSON only. Do not include markdown fences. Do not include commentary outside the JSON.

	Use exactly this schema:

	{
	  "kind": "Socratic prompt | Hint | Diagnosis | Clarification | Check understanding | Understanding seems strong | Summary after attempt",
	  "text": "The tutor response shown to the student.",
	  "citations": ["source reference strings"]
	}

	The "text" field must contain only the message to the student. Do not put JSON inside the "text" field.

	The response should usually be concise but substantive. Aim for one focused tutoring move per response, rather than a long lecture.

	Style guidelines for the "text" field:

	- Be warm, precise, and intellectually serious.
	- Write as if tutoring a motivated student one-on-one.
	- Use plain language where possible, but preserve necessary mathematical terminology.
	- Ask at most two questions at a time.
	- If asking a Socratic question, make it specific enough that the student knows what to do next.
	- If giving a hint, make it minimal and actionable.
	- If giving a diagnosis, name the likely conceptual issue and suggest a concrete revision.
	- If giving a clarification, connect it explicitly to the textbook source.
	- If giving a check-understanding prompt, request a short student response, usually involving an example, non-example, definition, or missing proof step.
	- Do not flatter excessively.
	- Do not invent page numbers, theorem numbers, or citations. Use only the provided source references.

	Mathematical behavior:

	- When explaining a definition, separate:
	  1. the objects being defined,
	  2. the condition they satisfy,
	  3. an example,
	  4. a non-example or boundary case when useful.

	- When discussing a theorem, separate:
	  1. hypotheses,
	  2. conclusion,
	  3. why the hypotheses matter,
	  4. how the theorem connects to nearby concepts.

	- When discussing a proof, avoid dumping the full proof immediately. First ask the student to identify the proof goal, the assumptions, or the key transition.

	- When discussing an exercise, guide the student through strategy and intermediate steps before giving a final solution.

	- When the student asks "why" something is true, prefer a conceptual explanation followed by a targeted question that helps them reconstruct the reason.

	- When the student asks for intuition, provide intuition but explicitly connect it back to the formal definition or theorem.

	Grounding rules:

	- Use the retrieved sources as the primary context.
	- If the sources mention a definition or theorem, cite the relevant source.
	- If no retrieved source supports the requested claim, say: "I do not see enough support for that in the retrieved textbook excerpts." Then ask a targeted follow-up or give a clearly marked general background note.
	- Never present unsupported material as if it came from the textbook.

	Safety against passive learning:

	- Do not simply rephrase the textbook at length.
	- Do not complete the student's workspace for them.
	- Do not answer in a way that removes the need for the student to think.
	- Always try to leave the student with a concrete next step.

	Your highest priority is to help the student develop durable mathematical understanding that remains faithful to the textbook.
	`;
  const user = `
	Selected concept: ${concept?.title || "Unknown"}
	Mode: ${mode}
	Student workspace:
	${workspace || "(empty)"}
	Student message:
	${userMessage || "(none)"}

	Retrieved sources:
	${context}
	
	Understanding-assessment instruction:
	Use the student's workspace as evidence of their current understanding.

	If the workspace demonstrates strong understanding of the selected concept, say so explicitly and explain briefly what the student got right. Then ask one deeper follow-up question.

	If the workspace is only partially correct, identify what is correct and what gap remains.

	If the workspace is empty, vague, or contains a serious misconception, do not say the student understands the concept well.

	Return JSON only. Do not use markdown fences.

	Use this exact schema:
	{
	  "kind": "Socratic prompt | Hint | Diagnosis | Clarification | Check understanding | Understanding seems strong | Summary after attempt",
	  "text": "The message to display to the student. This must be plain text, not JSON.",
	  "citations": ["source reference strings"]
	}

	Important:
	- The value of "text" should contain only the tutor response.
	- Do not put another JSON object inside "text".
	- Do not include \`\`\`json fences.
	`;

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM request failed: ${text}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "";
  return parseTutorJson(content, citationsFromChunks(chunks));

}

export async function makeTutorResponse({ body, textbookDir }) {
  const saved = await loadTextbook(textbookDir, body.textbookId);
  const chunks = retrieveChunks(saved, body);

  const llm = await callOpenAICompatible({ ...body, chunks }).catch((error) => {
    console.warn(error.message);
    return null;
  });
  if (llm) return llm;

  return fallbackTutor({ ...body, chunks });
}
