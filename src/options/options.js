const STORAGE_KEY = "openrouterApiKey";
const KEY_ENDPOINT = "https://openrouter.ai/api/v1/key";

const input = document.querySelector("#api-key");
const status = document.querySelector("#status");
const saveButton = document.querySelector("#save");
const checkButton = document.querySelector("#check");
const removeButton = document.querySelector("#remove");
const toggleButton = document.querySelector("#toggle-key");

let storedKey = "";

init();

async function init() {
  if (!globalThis.chrome?.storage?.local) {
    setStatus("크롬 확장 프로그램 설정 화면에서만 키를 저장할 수 있습니다.", "bad");
    return;
  }

  const stored = await chrome.storage.local.get(STORAGE_KEY);
  storedKey = stored[STORAGE_KEY] || "";
  input.value = storedKey;
  setStatus(storedKey ? "이 브라우저에 키가 저장되어 있습니다." : "저장된 키가 없습니다.", storedKey ? "ok" : "");
}

saveButton.addEventListener("click", async () => {
  if (!extensionAvailable()) return;
  const key = normalizeKey(input.value);
  if (!key) {
    setStatus("키를 입력해 주세요.", "bad");
    return;
  }
  if (!key.startsWith("sk-or-")) {
    const proceed = confirm("OpenRouter 키는 보통 sk-or-로 시작합니다. 이 값으로 저장할까요?");
    if (!proceed) return;
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: key });
  storedKey = key;
  input.value = key;
  setStatus("키를 저장했습니다.", "ok");
});

removeButton.addEventListener("click", async () => {
  if (!extensionAvailable()) return;
  if (!storedKey && !normalizeKey(input.value)) {
    setStatus("삭제할 키가 없습니다.", "");
    return;
  }
  if (!confirm("저장된 API 키를 삭제할까요?")) return;
  await chrome.storage.local.remove(STORAGE_KEY);
  storedKey = "";
  input.value = "";
  setStatus("키를 삭제했습니다.", "ok");
});

checkButton.addEventListener("click", async () => {
  if (!extensionAvailable()) return;
  const key = normalizeKey(input.value);
  if (!key) {
    setStatus("확인할 키를 입력해 주세요.", "bad");
    return;
  }

  checkButton.disabled = true;
  setStatus("키를 확인하는 중…", "");
  try {
    const response = await fetch(KEY_ENDPOINT, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      setStatus("키가 거부되었습니다.", "bad");
      return;
    }
    if (!response.ok) {
      setStatus(`키 확인에 실패했습니다. (HTTP ${response.status})`, "bad");
      return;
    }

    const info = data.data || data;
    const label = info.label ? `라벨 ${info.label}` : "라벨 없음";
    const usage = typeof info.usage === "number" ? `사용량 ${info.usage}` : "";
    setStatus(["키가 확인되었습니다.", label, usage].filter(Boolean).join(" · "), "ok");
  } catch {
    setStatus("OpenRouter에 연결하지 못했습니다.", "bad");
  } finally {
    checkButton.disabled = false;
  }
});

toggleButton.addEventListener("click", () => {
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  toggleButton.textContent = showing ? "표시" : "숨김";
});

function extensionAvailable() {
  if (globalThis.chrome?.storage?.local) return true;
  setStatus("크롬 확장 프로그램 설정 화면에서만 키를 저장할 수 있습니다.", "bad");
  return false;
}

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^["']|["']$/g, "");
}

function setStatus(message, kind) {
  status.textContent = message;
  status.className = kind ? `status ${kind}` : "status";
}
