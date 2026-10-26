const express = require("express");

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/models", (req, res) => {
  res.json([
    { id: "mock-edu", name: "Mock Education Model", provider: "Local mock" },
  ]);
});

app.get("/plugins", (req, res) => {
  res.json([{ id: "lesson-planner", name: "Lesson planner" }]);
});

app.post("/chat/stream", async (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const latestMessage = messages.filter((item) => item.role === "user").at(-1);
  const responseText = `Mock Intelli AI response: ${latestMessage?.content || "Hello from the mock AI server."}`;

  function send(event) {
    if (!res.destroyed && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }

  send({ type: "status", text: "Preparing a mock education response..." });
  for (const word of responseText.split(/(\s+)/)) {
    if (res.destroyed) return;
    send({ type: "token", text: word });
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
  send({ type: "done" });
  res.end();
});

const port = Number(process.env.MOCK_INTELLI_AI_PORT || 5055);
app.listen(port, () => {
  console.log(`Mock Intelli AI server listening on http://localhost:${port}`);
});
