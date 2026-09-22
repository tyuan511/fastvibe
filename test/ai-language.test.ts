import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_LANGUAGE_PROMPT_ENV,
  CUSTOM_SYSTEM_PROMPT_ENV,
  applyLanguages,
  customSystemPromptOf,
} from "../src/main/engine/ai-language.ts";

test("custom system prompt is trimmed and empty values are ignored", () => {
  assert.equal(customSystemPromptOf({ customSystemPrompt: "  use concise answers  " }), "use concise answers");
  assert.equal(customSystemPromptOf({ customSystemPrompt: " \n\t" }), undefined);
  assert.equal(customSystemPromptOf({ customSystemPrompt: 42 }), undefined);
});

test("language plumbing updates and clears the personalization environment", () => {
  const previousLanguagePrompt = process.env[AI_LANGUAGE_PROMPT_ENV];
  const previousCustomPrompt = process.env[CUSTOM_SYSTEM_PROMPT_ENV];
  try {
    applyLanguages({ aiLanguage: "en", customSystemPrompt: "  Prefer bullet points.  " });
    assert.match(process.env[AI_LANGUAGE_PROMPT_ENV] ?? "", /English/);
    assert.equal(process.env[CUSTOM_SYSTEM_PROMPT_ENV], "Prefer bullet points.");

    applyLanguages({ aiLanguage: "zh", customSystemPrompt: "" });
    assert.equal(process.env[CUSTOM_SYSTEM_PROMPT_ENV], undefined);
  } finally {
    if (previousLanguagePrompt === undefined) delete process.env[AI_LANGUAGE_PROMPT_ENV];
    else process.env[AI_LANGUAGE_PROMPT_ENV] = previousLanguagePrompt;
    if (previousCustomPrompt === undefined) delete process.env[CUSTOM_SYSTEM_PROMPT_ENV];
    else process.env[CUSTOM_SYSTEM_PROMPT_ENV] = previousCustomPrompt;
  }
});
