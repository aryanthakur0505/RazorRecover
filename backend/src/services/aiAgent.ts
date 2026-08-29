import OpenAI from "openai";
import type { ChatCompletionTool, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { env } from "../env";
import { toolImplementations, ToolName } from "./aiTools";
import { aiRecommendationJsonSchema, aiRecommendationSchema, AIRecommendation } from "../schemas/ai";

const client = env.aiEnabled ? new OpenAI({ apiKey: env.GROQ_API_KEY, baseURL: env.GROQ_BASE_URL }) : null;

const TOOL_DEFS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_payment",
      description: "Get operational details of a payment (no card/bank data).",
      parameters: {
        type: "object",
        properties: { paymentId: { type: "string" } },
        required: ["paymentId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_customer_profile",
      description: "Get non-PII operational stats about a customer's payment behavior.",
      parameters: {
        type: "object",
        properties: { customerId: { type: "string" } },
        required: ["customerId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_payment_history",
      description: "Get a customer's recent payment outcomes (status, category, amount, time).",
      parameters: {
        type: "object",
        properties: { customerId: { type: "string" } },
        required: ["customerId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recovery_history",
      description: "Get prior recovery attempts already made on this payment.",
      parameters: {
        type: "object",
        properties: { paymentId: { type: "string" } },
        required: ["paymentId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculate_recovery_score",
      description: "Recompute the deterministic 0-100 recovery score with its explainable factors.",
      parameters: {
        type: "object",
        properties: { paymentId: { type: "string" } },
        required: ["paymentId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "flag_payment",
      description: "Record a risk flag/observation about this payment for the audit trail.",
      parameters: {
        type: "object",
        properties: { paymentId: { type: "string" }, reason: { type: "string" } },
        required: ["paymentId", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_merchant_approval",
      description: "Indicate this case should be routed to a human merchant for approval.",
      parameters: {
        type: "object",
        properties: { paymentId: { type: "string" }, reason: { type: "string" } },
        required: ["paymentId", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: aiRecommendationJsonSchema.name,
      description: aiRecommendationJsonSchema.description,
      parameters: aiRecommendationJsonSchema.schema as unknown as Record<string, unknown>,
    },
  },
];

const SYSTEM_PROMPT = `You are the reasoning layer of RazorRecover, a payment-recovery system.
You NEVER execute financial operations. You only investigate a single ambiguous payment failure
using the read-only tools provided, then submit ONE structured recommendation by calling
"submit_recovery_recommendation". A separate deterministic policy engine decides whether your
recommendation is actually allowed to run — treat your output as advisory only.
Only use the tools given. Do not ask for or reference card numbers, bank details, or any
customer PII — none is available to you and none is needed.
Call at most 4 investigative tools before submitting your recommendation.`;

export interface AIAgentResult {
  recommendation: AIRecommendation;
  toolCallCount: number;
  estimatedCostPaise: number;
}

/**
 * Runs a single bounded tool-calling loop for one ambiguous payment and returns a validated
 * structured recommendation, or null if the agent is unavailable / repeatedly returns invalid
 * output (caller should then fall back to the deterministic decision + human escalation).
 */
export async function getAIRecommendation(
  paymentId: string,
  merchantId: string,
): Promise<AIAgentResult | null> {
  if (!client) return null; // agent unavailable — no GROQ_API_KEY configured

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Investigate payment ${paymentId} (merchant ${merchantId}) and submit a recovery recommendation.`,
    },
  ];

  let toolCallCount = 0;
  const MAX_STEPS = 6;

  for (let step = 0; step < MAX_STEPS; step++) {
    let completion;
    try {
      completion = await client.chat.completions.create({
        model: env.GROQ_MODEL,
        messages,
        tools: TOOL_DEFS,
        tool_choice: step === MAX_STEPS - 1 ? { type: "function", function: { name: aiRecommendationJsonSchema.name } } : "auto",
      });
    } catch (err) {
      console.error("[aiAgent] AI provider call failed:", err);
      return null;
    }

    const choice = completion.choices[0];
    const message = choice.message;
    messages.push(message as ChatCompletionMessageParam);

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      // Model answered in plain text instead of calling a tool — treat as failure, let caller escalate.
      return null;
    }

    for (const call of calls) {
      if (call.type !== "function") continue;
      toolCallCount++;

      if (call.function.name === aiRecommendationJsonSchema.name) {
        const parsed = safeJsonParse(call.function.arguments);
        const validated = aiRecommendationSchema.safeParse(parsed);
        if (!validated.success) {
          // Give the model one chance to correct itself.
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: `Invalid output: ${validated.error.message}. Please re-submit matching the schema exactly.`,
          });
          continue;
        }
        return {
          recommendation: validated.data,
          toolCallCount,
          estimatedCostPaise: 50,
        };
      }

      const toolName = call.function.name as ToolName;
      const impl = toolImplementations[toolName];
      if (!impl) {
        messages.push({ role: "tool", tool_call_id: call.id, content: "Unknown tool." });
        continue;
      }
      try {
        const args = safeJsonParse(call.function.arguments) ?? {};
        const result = await (impl as (input: any, merchantId: string) => Promise<unknown>)(
          args,
          merchantId,
        );
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `Tool error: ${err instanceof Error ? err.message : "unknown error"}`,
        });
      }
    }
  }

  return null; // exhausted steps without a valid recommendation
}

function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
