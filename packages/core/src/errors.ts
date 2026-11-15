export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'CONFIG_FORBIDDEN'
  | 'INSTANCE_LOCK_HELD'
  | 'DB_UNAVAILABLE'
  | 'VALIDATION_FAILED'
  | 'INTERNAL';

export class SunnyError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

export class ConfigError extends SunnyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CONFIG_INVALID', message, details);
  }
}

export class ForbiddenConfigError extends SunnyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CONFIG_FORBIDDEN', message, details);
  }
}

export class InstanceLockError extends SunnyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('INSTANCE_LOCK_HELD', message, details);
  }
}

export class DatabaseUnavailableError extends SunnyError {
  constructor(message: string, cause?: unknown) {
    super('DB_UNAVAILABLE', message, undefined, cause);
  }
}
