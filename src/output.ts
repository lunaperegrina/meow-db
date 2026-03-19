import { type CliError } from './errors';
import { type CommandSuccess } from './execute-command';

export function formatSuccessJsonPayload(result: CommandSuccess): string {
	return JSON.stringify({
		ok: true,
		command: result.command,
		data: result.data,
	});
}

export function formatErrorJsonPayload(error: CliError): string {
	return JSON.stringify({
		ok: false,
		error: {
			message: error.message,
			hint: error.hint,
			code: error.code,
		},
	});
}

export function formatHumanSuccessLines(
	result: CommandSuccess,
	quiet: boolean,
): string[] {
	if (quiet) {
		return result.human.quietLines ?? result.human.lines;
	}

	return result.human.lines;
}

export function formatHumanErrorLines(
	error: CliError,
	quiet: boolean,
): string[] {
	if (quiet) {
		return [`Error: ${error.message}`];
	}

	if (error.hint) {
		return [`Error: ${error.message}`, `Hint: ${error.hint}`];
	}

	return [`Error: ${error.message}`];
}
