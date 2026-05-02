import assert from "node:assert/strict";
import test from "node:test";

import { fetchAiCategoryMap } from "../src/shared/ai-classifier.js";

test("fetchAiCategoryMap sends title and hostname but not full URL", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = null;

  globalThis.fetch = async (url, options) => {
    requestBody = JSON.parse(options.body);

    return {
      ok: true,
      async json() {
        return {
          provider: "test",
          categories: ["AI"],
          assignments: [
            {
              tabId: 1,
              category: "AI"
            }
          ]
        };
      }
    };
  };

  try {
    const result = await fetchAiCategoryMap([
      {
        id: 1,
        title: "Claude",
        url: "https://claude.ai/chat/private-path",
        pinned: false
      }
    ], {
      endpoint: "http://127.0.0.1:8787/classify-tabs"
    });

    assert.equal(result.ok, true);
    assert.equal(requestBody.tabs[0].title, "Claude");
    assert.equal(requestBody.tabs[0].hostname, "claude.ai");
    assert.equal("url" in requestBody.tabs[0], false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
