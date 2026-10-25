const API_URL = "/api/chat";
const SYSTEM_INSTRUCTION = `You are Fieldwise, a practical agriculture assistant. Give concise, actionable advice about crops, soil, irrigation, pests, and farm technology. Ask for location or crop details only when needed. Never invent local weather, prices, or regulations.`;
const MAX_HISTORY_MESSAGES = 8;

const form = document.querySelector("#chat-form");
const input = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const messages = document.querySelector("#messages");
const welcome = document.querySelector("#welcome");
const newChatButton = document.querySelector("#new-chat");

let history = [];
let isSending = false;

function addMessage(role, text, options = {}) {
  const message = document.createElement("article");
  message.className = `message ${role}${options.error ? " error-message" : ""}`;

  if (role === "assistant") {
    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = "✳";
    message.append(avatar);
  }

  const body = document.createElement("div");
  body.className = "message-body";

  if (options.typing) {
    body.innerHTML = '<span class="typing-indicator" aria-label="Thinking"><span></span><span></span><span></span></span>';
  } else {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    body.append(paragraph);
  }

  if (options.retryText) {
    const retryButton = document.createElement("button");
    retryButton.className = "retry-button";
    retryButton.type = "button";
    retryButton.textContent = "Try again";
    retryButton.addEventListener("click", () => sendMessage(options.retryText));
    body.append(retryButton);
  }

  message.append(body);
  messages.append(message);
  message.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return message;
}

function setBusy(busy) {
  isSending = busy;
  sendButton.disabled = busy;
  input.disabled = busy;
  sendButton.setAttribute("aria-label", busy ? "Waiting for response" : "Send message");
}

async function readGeminiStream(response, onText) {
  if (!response.body) {
    throw new Error("Gemini did not return a readable response stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";

  function consumeLine(line) {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith("data:")) return;

    const data = trimmedLine.slice(5).trim();
    if (!data || data === "[DONE]") return;

    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      throw new Error("Gemini returned an invalid streaming response.");
    }

    if (chunk.error?.message) {
      throw new Error(chunk.error.message);
    }

    const text = chunk.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("");
    if (text) {
      answer += text;
      onText(answer);
    }
  }

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    lines.forEach(consumeLine);

    if (done) {
      if (buffer) consumeLine(buffer);
      break;
    }
  }

  return answer.trim();
}

async function sendMessage(rawText) {
  const text = rawText.trim();
  if (!text || isSending) return;

  welcome.hidden = true;
  addMessage("user", text);
  input.value = "";
  input.style.height = "auto";
  setBusy(true);
  const typingMessage = addMessage("assistant", "", { typing: true });

  const pendingHistory = [
    ...history.slice(-MAX_HISTORY_MESSAGES),
    { role: "user", parts: [{ text }] },
  ];
  let responseMessage = null;
  let isTemporaryOverload = false;

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: pendingHistory,
        generationConfig: { temperature: 0.5, maxOutputTokens: 512 },
      }),
    });

    if (!response.ok) {
      let apiMessage = `Gemini request failed (${response.status}).`;
      try {
        const result = await response.json();
        apiMessage = result.error?.message || apiMessage;
      } catch {
        // Use the HTTP status message when Gemini does not return JSON.
      }
      if (response.status === 503) {
        isTemporaryOverload = true;
        throw new Error("Gemini is temporarily busy. Please try again in a moment.");
      }
      throw new Error(apiMessage);
    }

    const answer = await readGeminiStream(response, (partialAnswer) => {
      if (!responseMessage) {
        typingMessage.remove();
        responseMessage = addMessage("assistant", "");
      }
      responseMessage.querySelector(".message-body p").textContent = partialAnswer;
    });
    if (!answer) {
      throw new Error("Gemini returned an empty response. Please try again.");
    }

    if (!responseMessage) {
      typingMessage.remove();
      addMessage("assistant", answer);
    }
    history = [...pendingHistory, { role: "model", parts: [{ text: answer }] }]
      .slice(-MAX_HISTORY_MESSAGES);
  } catch (error) {
    typingMessage.remove();
    const message = error instanceof Error ? error.message : "An unexpected error occurred.";
    addMessage("assistant", message, {
      error: true,
      retryText: isTemporaryOverload ? text : null,
    });
  } finally {
    setBusy(false);
    input.focus();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage(input.value);
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

document.querySelectorAll(".suggestion").forEach((button) => {
  button.addEventListener("click", () => sendMessage(button.dataset.prompt || ""));
});

newChatButton.addEventListener("click", () => {
  history = [];
  messages.replaceChildren();
  welcome.hidden = false;
  input.value = "";
  input.style.height = "auto";
  input.focus();
});
