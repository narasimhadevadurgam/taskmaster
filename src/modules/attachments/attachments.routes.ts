import { Router, type NextFunction, type Request, type Response } from 'express';
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import multer, { MulterError } from 'multer';
import { config } from '../../config/env.js';
import { validate } from '../../middleware/validate.js';
import { AppError } from '../../errors/AppError.js';
import { logger } from '../../utils/logger.js';
import {
  attachmentIdParamSchema,
  attachmentTaskIdParamSchema,
  listAttachmentsQuerySchema,
} from './attachments.schemas.js';
import {
  createAttachment,
  getAttachmentForDownload,
  listAttachments,
} from './attachments.service.js';

/**
 * Attachments router. Mounted behind the global auth middleware, so req.user is
 * always present.
 */
export const attachmentsRouter = Router();

function requireUser(req: Request): { id: number } {
  if (!req.user) {
    throw new AppError('UNAUTHENTICATED', 'Authentication required');
  }
  return req.user;
}

// multer stores uploads to UPLOAD_DIR with a random on-disk name (its default
// disk storage names files with a random hex id), size-capped at
// MAX_UPLOAD_BYTES. The relative on-disk filename is persisted as the DB path.
const upload = multer({
  dest: config.UPLOAD_DIR,
  limits: { fileSize: config.MAX_UPLOAD_BYTES },
});
const singleFile = upload.single('file');

/**
 * Wrap multer so its errors map into the uniform error shape. Mapping is
 * Content-Type-driven first (mutually exclusive branches):
 *   - non-multipart Content-Type        -> 415 UNSUPPORTED_MEDIA_TYPE (before multer)
 *   - multipart but no `file` field      -> 400 VALIDATION_ERROR
 *   - MulterError LIMIT_FILE_SIZE        -> 413 PAYLOAD_TOO_LARGE
 *   - other MulterError                  -> 400 VALIDATION_ERROR
 */
function uploadFile(req: Request, res: Response, next: NextFunction): void {
  const contentType = req.header('Content-Type') ?? '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    next(new AppError('UNSUPPORTED_MEDIA_TYPE', 'Expected multipart/form-data upload'));
    return;
  }
  singleFile(req, res, (err: unknown) => {
    if (err instanceof MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        next(new AppError('PAYLOAD_TOO_LARGE', 'Uploaded file exceeds the maximum size'));
        return;
      }
      next(new AppError('VALIDATION_ERROR', `Upload error: ${err.code}`));
      return;
    }
    if (err) {
      next(err);
      return;
    }
    if (!req.file) {
      next(new AppError('VALIDATION_ERROR', 'A single `file` field is required'));
      return;
    }
    next();
  });
}

/** POST /tasks/:id/attachments — upload a file (task-visibility required). */
attachmentsRouter.post(
  '/tasks/:id/attachments',
  validate(attachmentTaskIdParamSchema, 'params'),
  uploadFile,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const { id } = req.params as unknown as { id: number };
      const file = req.file as Express.Multer.File;
      const attachment = await createAttachment(id, user.id, {
        filename: file.originalname,
        mime: file.mimetype,
        size: file.size,
        // multer disk storage sets `filename` to the random on-disk name.
        path: file.filename,
      });
      res.status(201).json({ attachment });
    } catch (err) {
      next(err);
    }
  }
);

/** GET /tasks/:id/attachments — list attachment metadata (never the path). */
attachmentsRouter.get(
  '/tasks/:id/attachments',
  validate(attachmentTaskIdParamSchema, 'params'),
  validate(listAttachmentsQuerySchema, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const { id } = req.params as unknown as { id: number };
      const { limit, offset } = req.query as unknown as { limit: number; offset: number };
      const result = await listAttachments(id, user.id, limit, offset);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

/** Strip anything that could break the Content-Disposition filename quoting. */
function sanitizeFilename(name: string): string {
  // Drop path separators and control/quote chars; keep a safe display name.
  const base = name.replace(/[\\/]/g, '_').replace(/["\r\n\u0000-\u001f]/g, '');
  return base.length > 0 ? base : 'download';
}

/** GET /attachments/:id/download — stream the file (task-visibility re-checked). */
attachmentsRouter.get(
  '/attachments/:id/download',
  validate(attachmentIdParamSchema, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const { id } = req.params as unknown as { id: number };
      const file = await getAttachmentForDownload(id, user.id);

      const baseDir = resolve(config.UPLOAD_DIR);
      const abs = isAbsolute(file.path) ? file.path : resolve(baseDir, file.path);
      try {
        await access(abs);
      } catch {
        // Row exists but the disk file is gone -> 404 (data drift), logged.
        logger.error('attachment file missing on disk', { attachment_id: id });
        throw new AppError('NOT_FOUND', 'Attachment not found');
      }

      res.setHeader('Content-Type', file.mime);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${sanitizeFilename(file.filename)}"`
      );
      const stream = createReadStream(abs);
      stream.on('error', (err) => {
        logger.error('attachment stream error', {
          attachment_id: id,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) {
          next(new AppError('NOT_FOUND', 'Attachment not found'));
        } else {
          res.destroy();
        }
      });
      stream.pipe(res);
    } catch (err) {
      next(err);
    }
  }
);
