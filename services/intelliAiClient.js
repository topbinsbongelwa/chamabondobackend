const CACHE_TTL_MS = 5 * 60 * 1000;
const fallbackCatalog = {
  models: [{ id: "default", name: "Default", provider: "Intelli AI" }],
  plugins: [],
};
const catalogCache = new Map();

function endpointUrl(path) {
  const baseUrl = process.env.INTELLI_AI_URL;
  if (!baseUrl) {
    throw new Error("Intelli AI is not configured.");
  }

  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function headers(extra = {}) {
  const key = process.env.INTELLI_AI_KEY;
  if (!key) {
    throw new Error("Intelli AI is not configured.");
  }

  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function postChat(payload, { signal, onStatus, onToken }) {
  let response;

  try {
    response = await fetch(endpointUrl("chat/stream"), {
      method: "POST",
      headers: headers({ Accept: "text/event-stream" }),
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    throw new Error("Intelli AI service is unavailable.");
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Intelli AI request failed (HTTP ${response.status}).`);
  }
  if (!response.body) {
    throw new Error("Intelli AI returned an empty response.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";

  function handleEvent(eventText) {
    const data = eventText
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") {
      return;
    }

    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw new Error("Intelli AI returned an invalid stream event.");
    }
    if (!event || typeof event !== "object") {
      throw new Error("Intelli AI returned an invalid stream event.");
    }

    if (event.type === "status" && typeof event.text === "string") {
      onStatus(event.text.slice(0, 500));
      return;
    }

    const openAiToken = event.choices?.[0]?.delta?.content;
    const token =
      event.type === "token" || event.type === "delta"
        ? event.text ?? event.delta ?? event.token
        : typeof openAiToken === "string"
          ? openAiToken
          : null;
    if (typeof token === "string") {
      content += token;
      onToken(token);
      return;
    }

    const finalContent =
      event.type === "done" || event.type === "final"
        ? event.content ?? event.text
        : null;
    if (typeof finalContent === "string") {
      content = finalContent;
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || "";
      for (const event of events) {
        handleEvent(event);
      }
      if (done) {
        break;
      }
    }
    if (buffer.trim()) {
      handleEvent(buffer);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }

  return content;
}

async function fetchCatalog(kind) {
  const cached = catalogCache.get(kind);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  try {
    const response = await fetch(endpointUrl(kind), {
      headers: headers(),
    });
    if (!response.ok) {
      throw new Error("Intelli AI catalog request failed.");
    }
    const responseValue = await response.json();
    const value = Array.isArray(responseValue)
      ? responseValue
      : responseValue?.[kind];
    if (!Array.isArray(value)) {
      throw new Error("Intelli AI returned an invalid catalog.");
    }
    catalogCache.set(kind, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch {
    return cached?.value || fallbackCatalog[kind];
  }
}

module.exports = {
  fetchPlugins: () => fetchCatalog("plugins"),
  fetchModels: () => fetchCatalog("models"),
  postChat,
};
