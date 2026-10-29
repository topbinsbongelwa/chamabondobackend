const intelliAiClient = require("./intelliAiClient");

const PROVIDERS = {
  openai: {
    apiKey: "OPENAI_API_KEY",
    model: () => process.env.OPENAI_MODEL || "gpt-4o-mini",
    provider: "OpenAI",
  },
  gemini: {
    apiKey: "GEMINI_API_KEY",
    model: () => process.env.GEMINI_MODEL || "gemini-2.5-flash",
    provider: "Google Gemini",
  },
  claude: {
    apiKey: "ANTHROPIC_API_KEY",
    model: () => process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514",
    provider: "Anthropic Claude",
  },
};

function providerFor(model) {
  if (typeof model !== "string") return null;
  const separator = model.indexOf(":");
  const provider = separator < 0 ? null : model.slice(0, separator).toLowerCase();
  return provider && PROVIDERS[provider] ? provider : null;
}

function providerModel(provider, model) {
  const selectedModel = model?.slice(model.indexOf(":") + 1);
  if (!selectedModel || selectedModel.length > 120) {
    throw new Error(`Invalid ${PROVIDERS[provider].provider} model.`);
  }
  return selectedModel;
}

function unavailable(provider) {
  return new Error(`${PROVIDERS[provider].provider} is not configured.`);
}

async function checkedFetch(url, options, provider) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error(`${PROVIDERS[provider].provider} service is unavailable.`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `${PROVIDERS[provider].provider} request failed (HTTP ${response.status}).`
    );
  }
  if (!response.body) {
    throw new Error(`${PROVIDERS[provider].provider} returned an empty response.`);
  }
  return response;
}

async function consumeSse(response, provider, onEvent, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function handleEvent(eventText) {
    const lines = eventText.split(/\r?\n/);
    const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;

    let value;
    try {
      value = JSON.parse(data);
    } catch {
      throw new Error(`${PROVIDERS[provider].provider} returned an invalid stream event.`);
    }
    onEvent(value, eventName);
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || "";
      for (const event of events) handleEvent(event);
      if (done) break;
    }
    if (buffer.trim()) handleEvent(buffer);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  if (signal?.aborted) return;
}

function requireTextOnlyFeatures(payload, provider) {
  if (payload.tools?.webSearch || payload.tools?.plugins?.length) {
    throw new Error(
      `${PROVIDERS[provider].provider} does not support Intelli AI tools. Disable web search and plugins to continue.`
    );
  }
  if (payload.messages.some((message) => message.attachments?.length)) {
    throw new Error(
      `${PROVIDERS[provider].provider} file attachments are not supported yet. Remove the attachments to continue.`
    );
  }
}

function chatMessages(payload) {
  return payload.messages.map(({ role, content }) => ({ role, content }));
}

async function postOpenAi(payload, options, provider) {
  const key = process.env[PROVIDERS[provider].apiKey];
  if (!key) throw unavailable(provider);
  requireTextOnlyFeatures(payload, provider);

  const response = await checkedFetch(
    process.env.OPENAI_API_URL || "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: providerModel(provider, payload.model),
        messages: chatMessages(payload),
        stream: true,
      }),
      signal: options.signal,
    },
    provider
  );

  let content = "";
  await consumeSse(
    response,
    provider,
    (event) => {
      const token = event.choices?.[0]?.delta?.content;
      if (typeof token === "string") {
        content += token;
        options.onToken(token);
      }
      if (event.error) {
        throw new Error(`${PROVIDERS[provider].provider} returned a stream error.`);
      }
    },
    options.signal
  );
  return content;
}

async function postGemini(payload, options, provider) {
  const key = process.env[PROVIDERS[provider].apiKey];
  if (!key) throw unavailable(provider);
  requireTextOnlyFeatures(payload, provider);

  const model = encodeURIComponent(providerModel(provider, payload.model));
  const url = new URL(
    `${(process.env.GEMINI_API_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "")}/models/${model}:streamGenerateContent`
  );
  url.searchParams.set("alt", "sse");
  const messages = chatMessages(payload);
  const system = messages.find((message) => message.role === "system");
  const response = await checkedFetch(
    url,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": key,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system.content }] } } : {}),
        contents: messages
          .filter((message) => message.role !== "system")
          .map((message) => ({
            role: message.role === "assistant" ? "model" : "user",
            parts: [{ text: message.content }],
          })),
        generationConfig: { candidateCount: 1 },
      }),
      signal: options.signal,
    },
    provider
  );

  let content = "";
  await consumeSse(
    response,
    provider,
    (event) => {
      const text = event.candidates?.[0]?.content?.parts
        ?.map((part) => part.text)
        .filter((part) => typeof part === "string")
        .join("");
      if (text) {
        content += text;
        options.onToken(text);
      }
      if (event.error) {
        throw new Error(`${PROVIDERS[provider].provider} returned a stream error.`);
      }
    },
    options.signal
  );
  return content;
}

async function postClaude(payload, options, provider) {
  const key = process.env[PROVIDERS[provider].apiKey];
  if (!key) throw unavailable(provider);
  requireTextOnlyFeatures(payload, provider);

  const messages = chatMessages(payload);
  const system = messages.find((message) => message.role === "system")?.content;
  const response = await checkedFetch(
    process.env.ANTHROPIC_API_URL || "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: providerModel(provider, payload.model),
        max_tokens: 4096,
        ...(system ? { system } : {}),
        messages: messages
          .filter((message) => message.role !== "system")
          .map((message) => ({
            role: message.role === "assistant" ? "assistant" : "user",
            content: message.content,
          })),
        stream: true,
      }),
      signal: options.signal,
    },
    provider
  );

  let content = "";
  await consumeSse(
    response,
    provider,
    (event, eventName) => {
      if (eventName === "content_block_delta" && typeof event.delta?.text === "string") {
        content += event.delta.text;
        options.onToken(event.delta.text);
      } else if (eventName === "error" || event.type === "error") {
        throw new Error(`${PROVIDERS[provider].provider} returned a stream error.`);
      }
    },
    options.signal
  );
  return content;
}

async function postChat(payload, options) {
  const provider = providerFor(payload.model);
  if (!provider) return intelliAiClient.postChat(payload, options);
  if (!process.env[PROVIDERS[provider].apiKey]) throw unavailable(provider);
  if (provider === "gemini") return postGemini(payload, options, provider);
  if (provider === "claude") return postClaude(payload, options, provider);
  return postOpenAi(payload, options, provider);
}

async function fetchModels() {
  const intelliModels = await intelliAiClient.fetchModels();
  const providerModels = Object.entries(PROVIDERS)
    .filter(([key, config]) => process.env[config.apiKey])
    .map(([key, config]) => ({
      id: `${key}:${config.model()}`,
      name: config.model(),
      provider: config.provider,
    }));
  return [...intelliModels, ...providerModels];
}

module.exports = {
  fetchModels,
  fetchPlugins: intelliAiClient.fetchPlugins,
  postChat,
};
