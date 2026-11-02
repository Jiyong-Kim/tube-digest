import { MODEL, SYSTEM_PROMPT, buildUserContent } from "../lib/prompt.js";

const STORAGE_KEY = "openrouterApiKey";
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 90000;
const MAX_TRANSCRIPT_CHARS = 20000;

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    return undefined;
  }

  if (message?.type === "HAS_KEY") {
    chrome.storage.local.get(STORAGE_KEY).then((stored) => {
      sendResponse({ ok: true, hasKey: Boolean(stored[STORAGE_KEY]) });
    });
    return true;
  }

  if (message?.type === "SUMMARIZE") {
    summarize(message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "요약에 실패했습니다.",
        });
      });
    return true;
  }

  return undefined;
});

async function summarize(payload) {
  const transcript = typeof payload?.transcript === "string" ? payload.transcript.trim() : "";
  if (!transcript) {
    throw new Error("요약할 자막이 없습니다.");
  }
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    throw new Error("자막이 너무 깁니다. 다시 시도해 주세요.");
  }

  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const apiKey = stored[STORAGE_KEY];
  if (!apiKey) {
    throw new Error("설정에서 OpenRouter API 키를 먼저 저장해 주세요.");
  }

  const body = {
    model: MODEL,
    temperature: 0.2,
    max_tokens: 900,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: buildUserContent({
          title: cleanMeta(payload.title),
          language: cleanMeta(payload.language),
          transcript,
          truncated: Boolean(payload.truncated),
        }),
      },
    ],
  };

  let lastError = new Error("요약 요청에 실패했습니다.");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { status, data } = await postCompletion(apiKey, body);
    if (status === 502 || status === 503) {
      lastError = new Error("OpenRouter가 잠시 응답하지 않습니다. 다시 시도해 주세요.");
      continue;
    }
    if (status < 200 || status >= 300) {
      throw new Error(errorMessage(status, data));
    }

    const text = extractText(data?.choices?.[0]?.message?.content).trim();
    if (!text) {
      lastError = new Error("모델이 빈 응답을 반환했습니다. 다시 시도해 주세요.");
      continue;
    }

    return {
      markdown: text,
      model: typeof data.model === "string" && data.model ? data.model : MODEL,
    };
  }

  throw lastError;
}

async function postCompletion(apiKey, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Tube Digest",
      },
      body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => ({}));
    return { status: response.status, data };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("요약 요청이 시간 초과되었습니다. 다시 시도해 주세요.");
    }
    throw new Error("OpenRouter에 연결하지 못했습니다. 네트워크를 확인해 주세요.");
  } finally {
    clearTimeout(timer);
  }
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      return "";
    })
    .join("\n");
}

function errorMessage(status, body) {
  if (status === 401) return "API 키가 거부되었습니다. 설정에서 키를 다시 확인해 주세요.";
  if (status === 402) return "OpenRouter 크레딧이 부족합니다.";
  if (status === 429) return "무료 모델 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.";
  if (status === 404) return "openrouter/free 모델을 찾지 못했습니다.";

  const apiMessage = String(body?.error?.message || body?.message || "")
    .replace(/\s+/g, " ")
    .trim();
  if (apiMessage) return `요약 요청이 거절되었습니다. ${apiMessage}`.slice(0, 280);
  return `요약 요청에 실패했습니다. (HTTP ${status})`;
}

function cleanMeta(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}
