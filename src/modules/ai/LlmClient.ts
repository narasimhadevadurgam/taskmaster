import { AppError } from '../../errors/AppError.js';
import { logger } from '../../utils/logger.js';

/**
 * The pluggable LLM client. A single `complete` method takes a fully-built
 * prompt string and returns generated text. Implementations never touch the DB
 * or any service — the AI module's only capability is turning a prompt into
 * text, which is the structural prompt-safety boundary.
 */
export interface LlmClient {
  complete(prompt: string): Promise<string>;
}

/** Config consumed by the factory (mirrors the relevant env keys). */
export interface LlmConfig {
  provider: 'mock' | 'ollama';
  ollamaUrl: string;
  ollamaModel: string;
}

/**
 * Deterministic, offline mock. Default provider so tests and `docker compose`
 * run with no network and reproducible assertions. Produces a stable templated
 * description derived from the prompt's trailing user content — never random, no
 * key, no network.
 */
export class MockLlmClient implements LlmClient {
  async complete(prompt: string): Promise<string> {
    // Deterministic transform: collapse whitespace, take the leading words, and
    // frame them in a fixed template. Same input -> same output, always.
    const normalized = prompt.replace(/\s+/g, ' ').trim();
    const words = normalized.split(' ').filter(Boolean).slice(0, 40);
    const summary = words.join(' ');
    return `Task summary: ${summary}`;
  }
}

/** The Ollama /api/generate response shape we read. */
interface OllamaGenerateResponse {
  response?: string;
}

/**
 * Ollama HTTP implementation. POSTs to `${ollamaUrl}/api/generate` with the
 * configured model and `stream:false`, under a bounded timeout. Any non-200,
 * timeout, or connection error becomes AppError('AI_UNAVAILABLE') (502) so the
 * caller can retry or type manually.
 */
export class OllamaLlmClient implements LlmClient {
  private readonly url: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(url: string, model: string, timeoutMs = 20_000) {
    this.url = url;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async complete(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.url}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt, stream: false }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw unavailable(`Ollama responded with status ${res.status}`);
      }
      const data = (await res.json()) as OllamaGenerateResponse;
      return (data.response ?? '').trim();
    } catch (err) {
      if (err instanceof AppError) {
        throw err;
      }
      logger.warn('ollama complete failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw unavailable('AI provider is unreachable or timed out');
    } finally {
      clearTimeout(timer);
    }
  }
}

function unavailable(message: string): AppError {
  return new AppError('AI_UNAVAILABLE', message);
}

/** Build the configured LLM client. Defaults to the deterministic mock. */
export function createLlmClient(cfg: LlmConfig): LlmClient {
  if (cfg.provider === 'ollama') {
    return new OllamaLlmClient(cfg.ollamaUrl, cfg.ollamaModel);
  }
  return new MockLlmClient();
}
