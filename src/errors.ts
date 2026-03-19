export type CliErrorCode =
	| 'CONFIG_NOT_FOUND'
	| 'DB_NOT_FOUND'
	| 'DB_NOT_SELECTED'
	| 'INVALID_ARGUMENT'
	| 'DB_CONNECTION_FAILED'
	| 'DB_QUERY_FAILED';

type CliErrorOptions = {
	hint?: string;
	cause?: unknown;
};

export class CliError extends Error {
	code: CliErrorCode;
	hint?: string;

	public constructor(
		code: CliErrorCode,
		message: string,
		options: CliErrorOptions = {},
	) {
		super(message, {cause: options.cause});
		this.name = 'CliError';
		this.code = code;
		this.hint = options.hint;
	}
}

export function toCliError(error: unknown): CliError {
	if (error instanceof CliError) {
		return error;
	}

	return new CliError('INVALID_ARGUMENT', 'Unexpected error.', {
		hint: 'Run `meow --help` for usage information.',
		cause: error,
	});
}
