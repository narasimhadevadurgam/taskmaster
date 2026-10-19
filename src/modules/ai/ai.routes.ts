import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../../config/env.js';
import { validate } from '../../middleware/validate.js';
import { AppError } from '../../errors/AppError.js';
import { createLlmClient, type LlmClient } from './LlmClient.js';
import { generateDescriptionSchema } from './ai.schemas.js';
import { generateTaskDescription } from './ai.service.js';

/**
 * AI router. Mounted behind the global auth middleware. The module imports no DB
 * pool and no services — only the LlmClient and config — which is the structural
 * prompt-safety boundary: the AI path has no write authority.
 */
export const aiRouter = Router();

/** The configured LLM client, built once from env (defaults to the mock). */
const llmClient: LlmClient = createLlmClient({
  provider: config.LLM_PROVIDER,
  ollamaUrl: config.OLLAMA_URL,
  ollamaModel: config.OLLAMA_MODEL,
});

function requireUser(req: Request): { id: number } {
  if (!req.user) {
    throw new AppError('UNAUTHENTICATED', 'Authentication required');
  }
  return req.user;
}

/**
 * POST /ai/task-description — generate a task description from user input via
 * the pluggable LlmClient. Performs no DB writes. A mock provider never fails;
 * an unreachable Ollama provider -> 502 AI_UNAVAILABLE.
 */
aiRouter.post(
  '/ai/task-description',
  validate(generateDescriptionSchema, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      requireUser(req);
      const description = await generateTaskDescription(llmClient, req.body);
      res.status(200).json({ description });
    } catch (err) {
      next(err);
    }
  }
);
