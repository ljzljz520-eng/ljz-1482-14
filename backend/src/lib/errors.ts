/** 统一业务异常，错误码与 HTTP 状态映射，前端可定位失败原因。 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number = 400,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const ErrorCodes = {
  VALIDATION: "VALIDATION_ERROR",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  CHUNK_MISMATCH: "CHUNK_MISMATCH",
  CHUNK_CHECKSUM: "CHUNK_CHECKSUM_FAILED",
  ASSET_TOO_LARGE: "ASSET_TOO_LARGE",
  SESSION_EXPIRED: "UPLOAD_SESSION_EXPIRED",
  UNSUPPORTED_MEDIA: "UNSUPPORTED_MEDIA_TYPE",
  URL_BLOCKED: "REMOTE_URL_BLOCKED",
  REMOTE_TOO_LARGE: "REMOTE_RESOURCE_TOO_LARGE",
  REMOTE_FETCH_FAILED: "REMOTE_FETCH_FAILED",
  TRANSCODE_FAILED: "TRANSCODE_FAILED",
  ASSET_NOT_READY: "ASSET_NOT_READY",
  STALE_REQUEST: "STALE_REQUEST",
  INTERNAL: "INTERNAL_ERROR"
} as const;
