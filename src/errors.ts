import type { ApiErrorBody } from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type: string,
    readonly code: string | null,
    readonly param: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        message: this.message,
        type: this.type,
        code: this.code,
        param: this.param,
      },
    };
  }
}

export function invalidRequest(message: string, code: string, param: string | null = null): ApiError {
  return new ApiError(message, 400, 'invalid_request_error', code, param);
}

export function serviceUnavailable(message = 'The service is temporarily unavailable. Please retry shortly.'): ApiError {
  return new ApiError(message, 503, 'server_error', 'all_models_failed');
}
