import { jsonrepair } from "jsonrepair";

async function resolveModel({ baseUrl, apiKey }) {
  const explicitModel = process.env.OPENAI_MODEL?.trim();

  if (explicitModel) {
    return explicitModel;
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Could not retrieve models from local LLM server: ${text}`);
  }

  const data = await response.json();
  const model = data.data?.[0]?.id;

  if (!model) {
    throw new Error("The local LLM server did not return any model IDs.");
  }

  return model;
}

async function postChatCompletion({ baseUrl, apiKey, body }) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return response;
}

export async function callLocalLLM({
  system,
  user,
  temperature = 0.1,
  maxTokens = 4096,
  jsonMode = false,
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL;

  if (!apiKey || !baseUrl) {
    return null;
  }

  const model = await resolveModel({ baseUrl, apiKey });

  const body = {
    model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };

  if (jsonMode) {
    body.response_format = { type: "json_object" };
  }

  let response = await postChatCompletion({ baseUrl, apiKey, body });

  // Some local OpenAI-compatible servers may reject response_format.
  // If so, retry without JSON mode rather than failing ingestion.
  if (!response.ok && jsonMode) {
    const errorText = await response.text();

    if (
      errorText.toLowerCase().includes("response_format") ||
      errorText.toLowerCase().includes("json_object")
    ) {
      delete body.response_format;
      response = await postChatCompletion({ baseUrl, apiKey, body });
    } else {
      throw new Error(`LLM request failed: ${errorText}`);
    }
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM request failed: ${text}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

function extractJsonCandidate(text) {
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

function repairInvalidBackslashes(jsonText) {
  return String(jsonText)
    // Valid JSON escapes are: \" \\ \/ \b \f \n \r \t \uXXXX
    // This doubles any backslash that is not part of a valid JSON escape.
    .replace(/\\(?!["\\/bfnrtu])/g, "\\\\")
    // Remove raw control characters.
    .replace(/[\u0000-\u001F]+/g, " ");
}

export function parseJsonFromLLM(text) {
  if (!text) {
    throw new Error("Empty LLM response.");
  }

  const candidate = extractJsonCandidate(text);

  // Attempt 1: direct parse.
  try {
    return JSON.parse(candidate);
  } catch (firstError) {
    // Continue.
  }

  // Attempt 2: repair bad LaTeX backslashes.
  const backslashRepaired = repairInvalidBackslashes(candidate);

  try {
    return JSON.parse(backslashRepaired);
  } catch (secondError) {
    // Continue.
  }

  // Attempt 3: use jsonrepair for missing commas, trailing commas,
  // quote problems, unescaped newlines, and similar common issues.
  try {
    return JSON.parse(jsonrepair(backslashRepaired));
  } catch (thirdError) {
    throw new Error(
      [
        "Could not parse JSON from LLM response even after repair.",
        "",
        `Final parse error: ${thirdError.message}`,
        "",
        "Raw response excerpt:",
        String(text).slice(0, 3000),
      ].join("\n")
    );
  }
}

export async function repairJsonWithLLM({ brokenJson, parseError }) {
  const system = `
You repair malformed JSON.

Return only valid JSON. Do not include markdown. Do not explain.
Preserve as much content as possible.
If a string is unterminated, close it sensibly.
If commas are missing, insert them.
If LaTeX backslashes appear, either double them or rewrite the notation in plain English.
The final output must be parseable by JSON.parse.
`;

  const user = `
The following JSON is malformed.

Parse error:
${parseError}

Malformed JSON:
${String(brokenJson).slice(0, 12000)}

Return the repaired JSON only.
`;

  return callLocalLLM({
    system,
    user,
    temperature: 0,
    maxTokens: 4096,
    jsonMode: true,
  });
}