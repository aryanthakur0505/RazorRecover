import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default("4000"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  FRONTEND_URL: z.string().min(1, "FRONTEND_URL is required"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Groq (console.groq.com) — free, no card required, and speaks the identical OpenAI-style
  // chat-completions + tool-calling API this app's AI layer already uses, so the same client
  // code works unchanged. GROQ_BASE_URL is only there in case you ever want to point at a
  // different OpenAI-compatible provider instead (e.g. Gemini's compatibility layer) without
  // touching code.
  GROQ_API_KEY: z.string().optional().default(""),
  GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),
  GROQ_BASE_URL: z.string().default("https://api.groq.com/openai/v1"),
  SESSION_SECRET: z.string().min(8, "SESSION_SECRET must be at least 8 characters"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment variables — see .env.example");
}

export const env = {
  ...parsed.data,
  PORT: Number(parsed.data.PORT),
  isProduction: parsed.data.NODE_ENV === "production",
  aiEnabled: parsed.data.GROQ_API_KEY.length > 0,
};
