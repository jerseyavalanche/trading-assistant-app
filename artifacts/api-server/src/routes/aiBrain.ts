import { openai as replitOpenai } from "@workspace/integrations-openai-ai-server";
import OpenAI from "openai";
import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getAutopilotSnapshot, getRaceSnapshot } from "./autopilot.js";

const router = Router();

// ─── Paths ────────────────────────────────────────────────────────────────────
const EXPORTS_DIR          = path.resolve("exports/ai_brain");
const HISTORY_DIR          = path.join(EXPORTS_DIR, "history");
const FEEDBACK_DIR         = path.resolve("feedback/inbox");
const FEEDBACK_HISTORY_DIR = path.resolve("feedback/history");
const QUEUE_DIR            = path.resolve("feedback/queue");
const REPLIT_DIR           = path.resolve("feedback/replit");
const LATEST_EXPORT        = path.join(EXPORTS_DIR, "latest_export.json");
const LATEST_PROMPT        = path.join(EXPORTS_DIR, "latest_feedback_prompt.txt");
const LATEST_FEEDBACK      = path.join(FEEDBACK_DIR, "latest_feedback.json");
const LATEST_FEEDBACK_RAW  = path.join(FEEDBACK_DIR, "latest_feedback_raw.txt");
const LATEST_REPLIT_PROMPT = path.join(REPLIT_DIR, "latest_prompt.txt");
const WORK_PACKETS         = path.join(QUEUE_DIR, "work_packets.jsonl");

const REQUIRED_FEEDBACK_KEYS = [
  "summary",
  "problems_found",
  "recommended_changes",
  "files_to_modify",
  "tests_to_run",
  "next_prompt_for_replit",
] as const;

function ensureDirs() {
  for (const d of [EXPORTS_DIR, HISTORY_DIR, FEEDBACK_DIR, FEEDBACK_HISTORY_DIR, QUEUE_DIR, REPLIT_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

// ─── LLM client: prefer OPENAI_API_KEY → fall back to Replit proxy ──────────
function makeLLMClient(): { client: OpenAI; model: string } {
  if (process.env.OPENAI_API_KEY) {
    return { client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }), model: "gpt-4o" };
  }
  // Replit AI-Integrations proxy is an OpenAI-compatible endpoint
  return {
    client: replitOpenai as unknown as OpenAI,
    model: "gpt-5.4",
  };
}

function buildFeedbackPrompt(exportData: unknown): string {
  const json = JSON.stringify(exportData, null, 2);
  return `You are reviewing AI Brain trading bot race output from a paper-trading mobile app.

Below is the latest race export. Analyze what happened, identify weak agents, missing data, bugs, and the most impactful next improvements.

Return ONLY a valid JSON object (no markdown, no explanation outside the JSON) with this exact shape:
{
  "summary": "1-2 sentence overview of what happened",
  "problems_found": ["list of specific bugs, data gaps, or logic failures"],
  "recommended_changes": ["list of concrete actionable improvements"],
  "files_to_modify": ["list of file paths that should be changed"],
  "tests_to_run": ["list of things to manually verify after changes"],
  "next_prompt_for_replit": "a clear, detailed prompt you would give to Replit Agent to implement the top recommended change"
}

--- EXPORT DATA ---
${json}
`;
}

// ─── Write an export (called from autopilot or on demand) ─────────────────────

export function writeExport(payload: unknown) {
  ensureDirs();
  const record = {
    export_id: randomUUID(),
    created_at: new Date().toISOString(),
    ...(payload as Record<string, unknown>),
  };
  fs.writeFileSync(LATEST_EXPORT, JSON.stringify(record, null, 2), "utf8");
  const dateStr = new Date().toISOString().slice(0, 10);
  const historyFile = path.join(HISTORY_DIR, `${dateStr}.jsonl`);
  fs.appendFileSync(historyFile, JSON.stringify(record) + "\n", "utf8");
  const prompt = buildFeedbackPrompt(record);
  fs.writeFileSync(LATEST_PROMPT, prompt, "utf8");
  return record;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// ─── Live snapshot export (reads real in-memory race/solo state) ─────────────

router.get("/ai-brain/export-snapshot", (req, res) => {
  try {
    const race = getRaceSnapshot();
    const solo = getAutopilotSnapshot();

    // Prefer race data if a race has ever been set up with symbols, else solo
    const payload = race.symbols.length > 0 || race.bots.some((b) => b.trades > 0)
      ? { screen: "AI Brain", ...race }
      : { screen: "AI Brain", ...solo };

    const record = writeExport(payload);
    res.json({ ok: true, export_id: (record as { export_id: string }).export_id, snapshot: payload });
  } catch (err) {
    req.log.error({ err }, "export-snapshot error");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/ai-brain/export", (req, res) => {
  try {
    const record = writeExport(req.body as unknown);
    res.json({ ok: true, export_id: (record as { export_id: string }).export_id });
  } catch (err) {
    req.log.error({ err }, "export write error");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/ai-brain/latest-export", (_req, res) => {
  ensureDirs();
  if (!fs.existsSync(LATEST_EXPORT)) {
    res.status(404).json({ error: "No export yet. Start a race first." });
    return;
  }
  try {
    const data = JSON.parse(fs.readFileSync(LATEST_EXPORT, "utf8")) as unknown;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get("/ai-brain/latest-feedback-prompt", (_req, res) => {
  ensureDirs();
  if (!fs.existsSync(LATEST_PROMPT)) {
    res.status(404).json({ error: "No prompt yet. Generate an export first." });
    return;
  }
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(fs.readFileSync(LATEST_PROMPT, "utf8"));
});

router.post("/ai-brain/feedback", async (req, res) => {
  ensureDirs();
  const body = req.body as {
    summary?: string;
    problems_found?: string[];
    recommended_changes?: string[];
    files_to_modify?: string[];
    tests_to_run?: string[];
    next_prompt_for_replit?: string;
  };

  if (!body?.summary) {
    res.status(400).json({ error: "Invalid feedback — 'summary' field required." });
    return;
  }

  const packetId = randomUUID();
  const packet: Record<string, unknown> = {
    packet_id: packetId,
    created_at: new Date().toISOString(),
    source: "chatgpt_feedback",
    status: "applied",
    summary: body.summary ?? "",
    problems_found: body.problems_found ?? [],
    recommended_changes: body.recommended_changes ?? [],
    files_to_modify: body.files_to_modify ?? [],
    tests_to_run: body.tests_to_run ?? [],
    next_prompt_for_replit: body.next_prompt_for_replit ?? "",
    ai_response: null,
    applied_at: new Date().toISOString(),
  };

  // Persist immediately so status endpoint reflects the new packet
  fs.writeFileSync(LATEST_FEEDBACK, JSON.stringify(packet, null, 2), "utf8");
  fs.appendFileSync(WORK_PACKETS, JSON.stringify(packet) + "\n", "utf8");

  // Respond right away — don't make the client wait for the AI call
  res.json({ ok: true, packet_id: packetId });

  // Auto-apply: fire next_prompt_for_replit through the AI and store the response
  const prompt = body.next_prompt_for_replit?.trim();
  if (!prompt) return;

  try {
    const response = await replitOpenai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 2048,
      messages: [
        {
          role: "system",
          content:
            "You are a senior software engineer reviewing feedback about an AI trading bot system. " +
            "The user will give you a next-step prompt. Produce a clear, structured implementation plan: " +
            "what to change, which files, what the new logic should be, and any edge cases to handle. " +
            "Be specific and actionable. Do not write full code unless asked — focus on the plan.",
        },
        { role: "user", content: prompt },
      ],
      stream: false as const,
    });

    const aiText = response.choices[0]?.message?.content ?? "";

    // Patch the packet with the AI response and re-save
    packet.ai_response = aiText;
    packet.ai_applied_at = new Date().toISOString();
    fs.writeFileSync(LATEST_FEEDBACK, JSON.stringify(packet, null, 2), "utf8");

    // Also patch the last line of work_packets.jsonl
    const lines = fs.existsSync(WORK_PACKETS)
      ? fs.readFileSync(WORK_PACKETS, "utf8").split("\n").filter(Boolean)
      : [];
    if (lines.length > 0) {
      lines[lines.length - 1] = JSON.stringify(packet);
      fs.writeFileSync(WORK_PACKETS, lines.join("\n") + "\n", "utf8");
    }
  } catch {
    // Never let AI failure break the feedback flow
  }
});

router.get("/ai-brain/feedback-status", (_req, res) => {
  ensureDirs();
  const exportExists   = fs.existsSync(LATEST_EXPORT);
  const feedbackExists = fs.existsSync(LATEST_FEEDBACK);
  const promptExists   = fs.existsSync(LATEST_REPLIT_PROMPT);
  const exportData = exportExists
    ? (JSON.parse(fs.readFileSync(LATEST_EXPORT, "utf8")) as { created_at?: string; bots?: unknown[] })
    : null;
  const feedbackData = feedbackExists
    ? (JSON.parse(fs.readFileSync(LATEST_FEEDBACK, "utf8")) as {
        created_at?: string; summary?: string; status?: string; packet_id?: string;
        problems_found?: string[]; recommended_changes?: string[]; files_to_modify?: string[];
        tests_to_run?: string[]; next_prompt_for_replit?: string; source?: string;
      })
    : null;

  let queueCount = 0;
  if (fs.existsSync(WORK_PACKETS)) {
    const lines = fs.readFileSync(WORK_PACKETS, "utf8").split("\n").filter(Boolean);
    queueCount = lines.length;
  }

  res.json({
    export: exportData
      ? { created_at: exportData.created_at, bot_count: (exportData.bots as unknown[])?.length ?? 0 }
      : null,
    feedback: feedbackData
      ? {
          created_at: feedbackData.created_at,
          summary: feedbackData.summary,
          status: feedbackData.status,
          packet_id: feedbackData.packet_id,
          source: feedbackData.source,
          problems_count: feedbackData.problems_found?.length ?? 0,
          changes_count: feedbackData.recommended_changes?.length ?? 0,
          has_replit_prompt: !!feedbackData.next_prompt_for_replit,
        }
      : null,
    replit_prompt: promptExists
      ? { exists: true, path: "feedback/replit/latest_prompt.txt" }
      : null,
    queue_count: queueCount,
    llm_source: process.env.OPENAI_API_KEY ? "OPENAI_API_KEY" : "replit_proxy",
  });
});

// ─── POST /api/ai-brain/analyze-export ───────────────────────────────────────
// Automated bridge: load latest export → build prompt → call LLM backend-only
// → validate JSON → save feedback + replit prompt. Never exposes key to client.

router.post("/ai-brain/analyze-export", async (req, res) => {
  ensureDirs();

  if (!fs.existsSync(LATEST_EXPORT)) {
    res.status(400).json({ error: "No export found. Tap 'Generate Export' first." });
    return;
  }

  let exportData: unknown;
  try {
    exportData = JSON.parse(fs.readFileSync(LATEST_EXPORT, "utf8"));
  } catch (err) {
    res.status(500).json({ error: `Could not read latest_export.json: ${String(err)}` });
    return;
  }

  const prompt = buildFeedbackPrompt(exportData);

  // ── LLM call (backend-only — key never sent to client) ────────────────────
  let rawText = "";
  try {
    const { client, model } = makeLLMClient();
    const response = await client.chat.completions.create({
      model,
      max_completion_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
      stream: false as const,
    });
    rawText = response.choices[0]?.message?.content ?? "";
  } catch (err) {
    req.log.error({ err }, "analyze-export LLM call failed");
    res.status(502).json({ error: `LLM call failed: ${String(err)}` });
    return;
  }

  // ── Strip markdown fences ─────────────────────────────────────────────────
  const stripped = rawText.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  // ── Parse JSON ────────────────────────────────────────────────────────────
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    fs.writeFileSync(LATEST_FEEDBACK_RAW, rawText, "utf8");
    res.status(422).json({
      error: "LLM returned invalid JSON. Raw response saved to feedback/inbox/latest_feedback_raw.txt.",
      raw_preview: rawText.slice(0, 400),
    });
    return;
  }

  // ── Validate required shape ───────────────────────────────────────────────
  const missing = REQUIRED_FEEDBACK_KEYS.filter((k) => !(k in parsed));
  if (missing.length > 0) {
    fs.writeFileSync(LATEST_FEEDBACK_RAW, rawText, "utf8");
    res.status(422).json({
      error: `LLM response missing required fields: ${missing.join(", ")}. Raw response saved.`,
      raw_preview: rawText.slice(0, 400),
    });
    return;
  }

  // ── Persist ───────────────────────────────────────────────────────────────
  const packet: Record<string, unknown> = {
    packet_id: randomUUID(),
    created_at: new Date().toISOString(),
    source: "auto_analyze",
    status: "pending_review",
    ...parsed,
  };

  // Never overwrite a valid file if we're writing a new valid one — just replace
  fs.writeFileSync(LATEST_FEEDBACK, JSON.stringify(packet, null, 2), "utf8");

  const dateStr = new Date().toISOString().slice(0, 10);
  const historyFile = path.join(FEEDBACK_HISTORY_DIR, `${dateStr}.jsonl`);
  fs.appendFileSync(historyFile, JSON.stringify(packet) + "\n", "utf8");

  // Save next_prompt_for_replit to its own file — human must approve before use
  const replitPrompt = String(parsed.next_prompt_for_replit ?? "").trim();
  fs.writeFileSync(LATEST_REPLIT_PROMPT, replitPrompt, "utf8");

  req.log.info({ packet_id: packet.packet_id }, "analyze-export complete");

  res.json({
    ok: true,
    packet_id: packet.packet_id,
    summary: parsed.summary,
    problems_count: (parsed.problems_found as string[])?.length ?? 0,
    changes_count: (parsed.recommended_changes as string[])?.length ?? 0,
    files_count: (parsed.files_to_modify as string[])?.length ?? 0,
    replit_prompt_saved: replitPrompt.length > 0,
  });
});

// ─── GET /api/ai-brain/latest-replit-prompt ──────────────────────────────────

router.get("/ai-brain/latest-replit-prompt", (_req, res) => {
  ensureDirs();
  if (!fs.existsSync(LATEST_REPLIT_PROMPT)) {
    res.status(404).json({ error: "No Replit prompt yet. Run 'Analyze Export' first." });
    return;
  }
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(fs.readFileSync(LATEST_REPLIT_PROMPT, "utf8"));
});

// ─── GET /api/ai-brain/latest-feedback ───────────────────────────────────────

router.get("/ai-brain/latest-feedback", (_req, res) => {
  ensureDirs();
  if (!fs.existsSync(LATEST_FEEDBACK)) {
    res.status(404).json({ error: "No feedback yet. Run 'Analyze Export' first." });
    return;
  }
  try {
    const data = JSON.parse(fs.readFileSync(LATEST_FEEDBACK, "utf8")) as unknown;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
