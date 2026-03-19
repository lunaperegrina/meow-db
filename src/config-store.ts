import process from 'node:process';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {CliError} from './errors';

export type ConnectionConfig = {
	url: string;
	createdAt: string;
};

export type CliConfig = {
	version: 1;
	activeDb: string | null;
	connections: Record<string, ConnectionConfig>;
};

export const defaultConfig: CliConfig = {
	version: 1,
	activeDb: null,
	connections: {},
};

export function getConfigPath(
	environment: NodeJS.ProcessEnv = process.env,
): string {
	const root =
		environment['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
	return path.join(root, 'meow-db', 'config.json');
}

export async function readConfig(configPath: string): Promise<CliConfig> {
	let raw: string;
	try {
		raw = await fs.readFile(configPath, 'utf8');
	} catch (error: unknown) {
		if (isMissingFileError(error)) {
			throw new CliError('CONFIG_NOT_FOUND', 'Configuration file not found.', {
				hint: 'Run `meow db add <name> <url>` to create your first connection.',
				cause: error,
			});
		}

		throw error;
	}

	const parsed = JSON.parse(raw) as unknown;
	return validateConfig(parsed);
}

export async function writeConfig(
	configPath: string,
	config: CliConfig,
): Promise<void> {
	await fs.mkdir(path.dirname(configPath), {recursive: true});
	await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
}

export async function loadOrCreateConfig(
	configPath: string,
): Promise<CliConfig> {
	try {
		return await readConfig(configPath);
	} catch (error: unknown) {
		if (error instanceof CliError && error.code === 'CONFIG_NOT_FOUND') {
			await writeConfig(configPath, defaultConfig);
			return {
				version: 1,
				activeDb: null,
				connections: {},
			};
		}

		throw error;
	}
}

function validateConfig(value: unknown): CliConfig {
	if (!value || typeof value !== 'object') {
		throw invalidConfigError();
	}

	const config = value as Partial<CliConfig>;
	if (config.version !== 1) {
		throw invalidConfigError();
	}

	if (config.activeDb !== null && typeof config.activeDb !== 'string') {
		throw invalidConfigError();
	}

	if (!config.connections || typeof config.connections !== 'object') {
		throw invalidConfigError();
	}

	for (const connection of Object.values(config.connections)) {
		if (!connection || typeof connection !== 'object') {
			throw invalidConfigError();
		}

		if (
			typeof connection.url !== 'string' ||
			typeof connection.createdAt !== 'string'
		) {
			throw invalidConfigError();
		}
	}

	return {
		version: 1,
		activeDb: config.activeDb ?? null,
		connections: config.connections,
	};
}

function invalidConfigError() {
	return new CliError('INVALID_ARGUMENT', 'Configuration file is invalid.', {
		hint: 'Delete the config file and run `meow db add <name> <url>` again.',
	});
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
	return Boolean(
		error &&
			typeof error === 'object' &&
			'code' in error &&
			(error as NodeJS.ErrnoException).code === 'ENOENT',
	);
}
