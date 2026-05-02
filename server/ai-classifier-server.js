import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CATEGORY_ORDER, FALLBACK_CATEGORY, normalizeGeneratedCategoryName } from "../src/shared/categories.js";

loadLocalEnv();

const PORT = Number(process.env.PORT || 8787);
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest";

const CLASSIFICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["categories", "assignments"],
  properties: {
    categories: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "string"
      }
    },
    assignments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tabId", "category"],
        properties: {
          tabId: {
            type: "integer"
          },
          category: {
            type: "string"
          }
        }
      }
    }
  }
};

const server = http.createServer(async (request, response) => {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "GET" && request.url === "/") {
    sendJson(response, 200, {
      ok: true,
      service: "Tab Organizer AI classifier",
      endpoint: "/classify-tabs",
      method: "POST",
      provider: getProvider()
    });
    return;
  }

  if (request.method !== "POST" || request.url !== "/classify-tabs") {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  try {
    const body = await readJson(request);
    const tabs = validateTabs(body.tabs);

    if (tabs.length === 0) {
      sendJson(response, 200, { provider: "none", categories: [], assignments: [] });
      return;
    }

    const result = await classifyTabs(tabs);
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, error.statusCode || 500, {
      error: error.message || "Unable to classify tabs"
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Tab Organizer AI classifier running at http://127.0.0.1:${PORT}`);
});

async function classifyTabs(tabs) {
  const provider = getProvider();

  if (provider === "anthropic") {
    return classifyWithAnthropic(tabs);
  }

  return classifyWithOpenAi(tabs);
}

function getProvider() {
  const provider = process.env.AI_PROVIDER;

  if (provider === "anthropic" || provider === "openai") {
    return provider;
  }

  if (process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return "anthropic";
  }

  return "openai";
}

async function classifyWithOpenAi(tabs) {
  if (!process.env.OPENAI_API_KEY) {
    throw httpError(400, "OPENAI_API_KEY is required for the OpenAI classifier.");
  }

  const apiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        {
          role: "system",
          content: buildSystemPrompt()
        },
        {
          role: "user",
          content: JSON.stringify({ fallbackCategories: CATEGORY_ORDER, tabs })
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "tab_category_assignments",
          strict: true,
          schema: CLASSIFICATION_SCHEMA
        }
      }
    })
  });

  const data = await readProviderResponse(apiResponse);
  const content = extractOpenAiText(data);
  const parsed = JSON.parse(content);

  return {
    provider: "openai",
    model: OPENAI_MODEL,
    ...normalizeClassification(parsed, tabs)
  };
}

async function classifyWithAnthropic(tabs) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw httpError(400, "ANTHROPIC_API_KEY is required for the Anthropic classifier.");
  }

  const apiResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1200,
      system: buildSystemPrompt(),
      messages: [
        {
          role: "user",
          content: JSON.stringify({ fallbackCategories: CATEGORY_ORDER, tabs })
        }
      ],
      tools: [
        {
          name: "return_tab_categories",
          description: "Return category assignments for browser tabs.",
          strict: true,
          input_schema: CLASSIFICATION_SCHEMA
        }
      ],
      tool_choice: {
        type: "tool",
        name: "return_tab_categories"
      }
    })
  });

  const data = await readProviderResponse(apiResponse);
  const toolUse = data.content?.find((item) => item.type === "tool_use" && item.name === "return_tab_categories");

  if (!toolUse?.input) {
    throw new Error("Anthropic response did not include category assignments.");
  }

  return {
    provider: "anthropic",
    model: ANTHROPIC_MODEL,
    ...normalizeClassification(toolUse.input, tabs)
  };
}

function buildSystemPrompt() {
  return [
    "Create session-specific browser tab category names from the provided tab titles and hostnames.",
    "Use 2 to 8 concise category names, each 1 to 3 words.",
    "Each category must describe one topic only.",
    "Do not use compound labels with &, /, commas, plus signs, hyphens, or the word and.",
    "Prefer simple labels such as AI, Design, Travel, Research, Email, Finance, Shopping, Music, or Coding.",
    "Use AI for tabs about ChatGPT, Claude, Gemini, OpenAI, Anthropic, LLMs, prompts, model docs, or AI tools.",
    "Return one assignment for each provided tab ID and make every assignment category exactly match one category in the categories array.",
    `Use ${FALLBACK_CATEGORY} only for tabs that do not fit a clearer generated category.`,
    "Do not include page contents, personal details, or URLs in category names."
  ].join(" ");
}

async function readProviderResponse(response) {
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw httpError(response.status, data?.error?.message || data?.error || `Provider returned HTTP ${response.status}`);
  }

  return data;
}

function extractOpenAiText(data) {
  if (typeof data.output_text === "string") {
    return data.output_text;
  }

  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if ((content.type === "output_text" || content.type === "text") && typeof content.text === "string") {
        return content.text;
      }
    }
  }

  throw new Error("OpenAI response did not include category assignments.");
}

function validateTabs(tabs) {
  if (!Array.isArray(tabs)) {
    throw httpError(400, "Request body must include a tabs array.");
  }

  return tabs
    .filter((tab) => typeof tab?.id === "number")
    .map((tab) => ({
      id: tab.id,
      title: String(tab.title || "").slice(0, 240),
      hostname: String(tab.hostname || "").slice(0, 240)
    }));
}

function normalizeClassification(classification, tabs) {
  const tabIds = new Set(tabs.map((tab) => tab.id));
  const categories = [];
  const seenCategories = new Set();
  const assignments = [];

  for (const category of Array.isArray(classification.categories) ? classification.categories : []) {
    addCategory(category, categories, seenCategories);
  }

  for (const assignment of Array.isArray(classification.assignments) ? classification.assignments : []) {
    const category = normalizeGeneratedCategoryName(assignment?.category);

    if (!tabIds.has(assignment?.tabId) || !category) {
      continue;
    }

    addCategory(category, categories, seenCategories);
    assignments.push({
      tabId: assignment.tabId,
      category
    });
  }

  if (categories.length === 0 && assignments.length > 0) {
    addCategory(FALLBACK_CATEGORY, categories, seenCategories);
  }

  return { categories, assignments };
}

function addCategory(category, categories, seenCategories) {
  const normalized = normalizeGeneratedCategoryName(category);

  if (normalized && !seenCategories.has(normalized) && categories.length < 8) {
    categories.push(normalized);
    seenCategories.add(normalized);
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let rawBody = "";

    request.on("data", (chunk) => {
      rawBody += chunk;

      if (rawBody.length > 64_000) {
        reject(httpError(413, "Request body is too large."));
        request.destroy();
      }
    });

    request.on("end", () => {
      try {
        resolve(JSON.parse(rawBody || "{}"));
      } catch {
        reject(httpError(400, "Request body must be valid JSON."));
      }
    });

    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json"
  });
  response.end(JSON.stringify(payload));
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function loadLocalEnv() {
  const envPath = resolve(".env");

  if (!existsSync(envPath)) {
    return;
  }

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = stripWrappingQuotes(rawValue);
  }
}

function stripWrappingQuotes(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
