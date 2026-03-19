import process from 'node:process';
import {
	type CliConfig,
	type ConnectionConfig,
	defaultConfig,
	getConfigPath,
	loadOrCreateConfig,
	readConfig,
	writeConfig,
} from './config-store';
import { CliError } from './errors';
import {
	getRows as getRowsFromPostgres,
	listTables as listTablesFromPostgres,
} from './postgres';

type Flags = {
	json: boolean;
	quiet: boolean;
	schema?: string;
	limit?: number;
};

type HumanOutput = {
	lines: string[];
	quietLines?: string[];
};

export type CommandSuccess = {
	command: string;
	data: unknown;
	human: HumanOutput;
};

type Dependencies = {
	getNow: () => string;
	getPath: (env?: NodeJS.ProcessEnv) => string;
	loadConfig: (configPath: string) => Promise<CliConfig>;
	readConfig: (configPath: string) => Promise<CliConfig>;
	writeConfig: (configPath: string, config: CliConfig) => Promise<void>;
	listTables: (url: string, schema: string) => Promise<string[]>;
	getRows: (
		url: string,
		schema: string,
		table: string,
		limit: number,
	) => Promise<Array<Record<string, unknown>>>;
};

const defaultDependencies: Dependencies = {
	getNow: () => new Date().toISOString(),
	getPath: getConfigPath,
	loadConfig: loadOrCreateConfig,
	readConfig,
	writeConfig,
	listTables: listTablesFromPostgres,
	getRows: getRowsFromPostgres,
};

const identifierPattern = /^[a-zA-Z_]\w*$/;
const rowsLimitDefault = 20;

export async function executeCommand(
	input: string[],
	flags: Flags,
	overrides: Partial<Dependencies> = {},
	environment: NodeJS.ProcessEnv = process.env,
): Promise<CommandSuccess> {
	const dependencies = { ...defaultDependencies, ...overrides };
	const [command, ...rest] = input;
	const configPath = dependencies.getPath(environment);

	if (!command) {
		throw new CliError('INVALID_ARGUMENT', 'No command provided.', {
			hint: 'Run `meow --help` to see available commands.',
		});
	}

	switch (command) {
		case 'db': {
			return handleDb(rest, configPath, dependencies);
		}

		case 'tables': {
			return handleTables(rest, configPath, dependencies);
		}

		case 'rows': {
			return handleRows(rest, flags, configPath, dependencies);
		}

		default: {
			throw new CliError('INVALID_ARGUMENT', `Unknown command "${command}".`, {
				hint: 'Run `meow --help` to see available commands.',
			});
		}
	}
}

async function handleDb(
	args: string[],
	configPath: string,
	dependencies: Dependencies,
): Promise<CommandSuccess> {
	const [subcommand, ...rest] = args;

	if (!subcommand) {
		throw new CliError('INVALID_ARGUMENT', 'Missing `db` subcommand.', {
			hint: 'Run `meow db --help` for usage.',
		});
	}

	switch (subcommand) {
		case 'add': {
			return handleDbAdd(rest, configPath, dependencies);
		}

		case 'list': {
			return handleDbList(rest, configPath, dependencies);
		}

		case 'use': {
			return handleDbUse(rest, configPath, dependencies);
		}

		case 'info': {
			return handleDbInfo(rest, configPath, dependencies);
		}

		case 'remove': {
			return handleDbRemove(rest, configPath, dependencies);
		}

		default: {
			throw new CliError(
				'INVALID_ARGUMENT',
				`Unknown db subcommand "${subcommand}".`,
				{
					hint: 'Run `meow db --help` for usage.',
				},
			);
		}
	}
}

async function handleDbAdd(
	args: string[],
	configPath: string,
	dependencies: Dependencies,
): Promise<CommandSuccess> {
	assertArgumentCount(args, 2, 'meow db add <name> <url>');
	const name = getRequiredArg(args, 0);
	const url = getRequiredArg(args, 1);
	const normalizedUrl = normalizeDatabaseUrl(url);
	const config = await dependencies.loadConfig(configPath);

	if (name in config.connections) {
		throw new CliError('INVALID_ARGUMENT', `db "${name}" already exists.`, {
			hint: 'Run `meow db list` to inspect available names.',
		});
	}

	config.connections[name] = {
		url: normalizedUrl,
		createdAt: dependencies.getNow(),
	};

	await dependencies.writeConfig(configPath, config);

	return {
		command: 'db add',
		data: {
			name,
			url: normalizedUrl,
		},
		human: {
			lines: [`Added db "${name}".`],
			quietLines: [name],
		},
	};
}

async function handleDbList(
	args: string[],
	configPath: string,
	dependencies: Dependencies,
): Promise<CommandSuccess> {
	assertArgumentCount(args, 0, 'meow db list');

	let config = defaultConfig;
	try {
		config = await dependencies.readConfig(configPath);
	} catch (error: unknown) {
		if (!(error instanceof CliError && error.code === 'CONFIG_NOT_FOUND')) {
			throw error;
		}
	}

	const names = Object.keys(config.connections).sort((left, right) =>
		left.localeCompare(right),
	);
	const connections = names.map(name => {
		const connection = config.connections[name];
		if (!connection) {
			throw new CliError('INVALID_ARGUMENT', 'Configuration file is invalid.', {
				hint: 'Run `meow db list` again after fixing configuration.',
			});
		}

		return {
			name,
			url: connection.url,
			createdAt: connection.createdAt,
			active: config.activeDb === name,
		};
	});

	if (connections.length === 0) {
		return {
			command: 'db list',
			data: { activeDb: null, connections: [] },
			human: {
				lines: ['No databases configured.'],
				quietLines: [],
			},
		};
	}

	return {
		command: 'db list',
		data: {
			activeDb: config.activeDb,
			connections,
		},
		human: {
			lines: connections.map(connection => {
				const marker = connection.active ? '*' : '-';
				return `${marker} ${connection.name} (${connection.url})`;
			}),
			quietLines: connections.map(connection =>
				connection.active ? `${connection.name}*` : connection.name,
			),
		},
	};
}

async function handleDbUse(
	args: string[],
	configPath: string,
	dependencies: Dependencies,
): Promise<CommandSuccess> {
	assertArgumentCount(args, 1, 'meow db use <name>');
	const name = getRequiredArg(args, 0);
	const config = await dependencies.readConfig(configPath);

	if (!(name in config.connections)) {
		throw new CliError('DB_NOT_FOUND', `db "${name}" not found.`, {
			hint: 'Run `meow db list` to see available names.',
		});
	}

	config.activeDb = name;
	await dependencies.writeConfig(configPath, config);

	return {
		command: 'db use',
		data: { activeDb: name },
		human: {
			lines: [`Using db "${name}".`],
			quietLines: [name],
		},
	};
}

async function handleDbInfo(
	args: string[],
	configPath: string,
	dependencies: Dependencies,
): Promise<CommandSuccess> {
	assertArgumentCount(args, 0, 'meow db info');
	const config = await dependencies.readConfig(configPath);
	const connection = getActiveConnection(config);

	return {
		command: 'db info',
		data: {
			name: connection.name,
			url: connection.value.url,
			createdAt: connection.value.createdAt,
		},
		human: {
			lines: [
				`Active db: ${connection.name}`,
				`URL: ${connection.value.url}`,
				`Created at: ${connection.value.createdAt}`,
			],
			quietLines: [connection.name],
		},
	};
}

async function handleDbRemove(
	args: string[],
	configPath: string,
	dependencies: Dependencies,
): Promise<CommandSuccess> {
	assertArgumentCount(args, 1, 'meow db remove <name>');
	const name = getRequiredArg(args, 0);
	const config = await dependencies.readConfig(configPath);

	if (!(name in config.connections)) {
		throw new CliError('DB_NOT_FOUND', `db "${name}" not found.`, {
			hint: 'Run `meow db list` to see available names.',
		});
	}

	const { [name]: omittedConnection, ...remainingConnections } =
		config.connections;
	void omittedConnection;
	config.connections = remainingConnections;
	if (config.activeDb === name) {
		config.activeDb = null;
	}

	await dependencies.writeConfig(configPath, config);

	return {
		command: 'db remove',
		data: { name },
		human: {
			lines: [`Removed db "${name}".`],
			quietLines: [name],
		},
	};
}

async function handleTables(
	args: string[],
	configPath: string,
	dependencies: Dependencies,
): Promise<CommandSuccess> {
	assertMaximumArgumentCount(args, 1, 'meow tables [schema]');
	const schema = args[0] ?? 'public';
	assertIdentifier(schema, '--schema');
	const config = await dependencies.readConfig(configPath);
	const connection = getActiveConnection(config);
	const tables = await dependencies.listTables(connection.value.url, schema);

	if (tables.length === 0) {
		return {
			command: 'tables',
			data: { schema, tables: [] },
			human: {
				lines: [`No tables found in schema "${schema}".`],
				quietLines: [],
			},
		};
	}

	return {
		command: 'tables',
		data: { schema, tables },
		human: {
			lines: tables.map(table => `- ${table}`),
			quietLines: tables,
		},
	};
}

async function handleRows(
	args: string[],
	flags: Flags,
	configPath: string,
	dependencies: Dependencies,
): Promise<CommandSuccess> {
	assertArgumentCount(
		args,
		1,
		'meow rows <table> [--schema <schema>] [--limit <n>]',
	);
	const table = getRequiredArg(args, 0);
	const schema = flags.schema ?? 'public';
	const limit = flags.limit ?? rowsLimitDefault;

	assertIdentifier(schema, '--schema');
	assertIdentifier(table, '<table>');
	assertPositiveLimit(limit);

	const config = await dependencies.readConfig(configPath);
	const connection = getActiveConnection(config);
	const rows = await dependencies.getRows(
		connection.value.url,
		schema,
		table,
		limit,
	);

	return {
		command: 'rows',
		data: {
			table,
			schema,
			limit,
			rows,
		},
		human: {
			lines: formatRowsForHuman(rows),
			quietLines: formatRowsForQuiet(rows),
		},
	};
}

function assertArgumentCount(
	args: string[],
	expected: number,
	usage: string,
): void {
	if (args.length !== expected) {
		throw new CliError(
			'INVALID_ARGUMENT',
			`Invalid arguments for \`${usage}\`.`,
			{
				hint: `Usage: ${usage}`,
			},
		);
	}
}

function assertMaximumArgumentCount(
	args: string[],
	max: number,
	usage: string,
): void {
	if (args.length > max) {
		throw new CliError(
			'INVALID_ARGUMENT',
			`Invalid arguments for \`${usage}\`.`,
			{
				hint: `Usage: ${usage}`,
			},
		);
	}
}

function normalizeDatabaseUrl(value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch (error: unknown) {
		throw new CliError('INVALID_ARGUMENT', 'Database URL is invalid.', {
			hint: 'Use a valid URL like `postgresql://user:pass@host:5432/db`.',
			cause: error,
		});
	}

	if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
		throw new CliError(
			'INVALID_ARGUMENT',
			'Database URL protocol must be postgres.',
			{
				hint: 'Use `postgresql://...`.',
			},
		);
	}

	return parsed.toString();
}

function getActiveConnection(config: CliConfig): {
	name: string;
	value: ConnectionConfig;
} {
	if (!config.activeDb) {
		throw new CliError('DB_NOT_SELECTED', 'No active db selected.', {
			hint: 'Run `meow db use <name>` to select one.',
		});
	}

	const connection = config.connections[config.activeDb];
	if (!connection) {
		throw new CliError('DB_NOT_FOUND', `db "${config.activeDb}" not found.`, {
			hint: 'Run `meow db list` to see available names.',
		});
	}

	return {
		name: config.activeDb,
		value: connection,
	};
}

function assertIdentifier(value: string, label: string): void {
	if (!identifierPattern.test(value)) {
		throw new CliError(
			'INVALID_ARGUMENT',
			`Invalid SQL identifier for ${label}.`,
			{
				hint: 'Use only letters, numbers, and underscore, starting with a letter or underscore.',
			},
		);
	}
}

function assertPositiveLimit(value: number): void {
	if (!Number.isInteger(value) || value <= 0) {
		throw new CliError(
			'INVALID_ARGUMENT',
			'Limit must be a positive integer.',
			{
				hint: 'Run `meow rows <table> --limit 20`.',
			},
		);
	}
}

function formatRowsForHuman(rows: Array<Record<string, unknown>>): string[] {
	if (rows.length === 0) {
		return ['No rows found.'];
	}

	const headers = new Set<string>();
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			headers.add(key);
		}
	}

	const orderedHeaders = [...headers];
	const widths = orderedHeaders.map(header => header.length);

	const serializedRows = rows.map(row =>
		orderedHeaders.map((header, index) => {
			const value = stringifyCell(row[header]);
			const currentWidth = widths[index] ?? 0;
			widths[index] = Math.max(currentWidth, value.length);
			return value;
		}),
	);

	const headerLine = orderedHeaders
		.map((header, index) => header.padEnd(widths[index] ?? 0))
		.join(' | ');
	const separatorLine = widths.map(width => '-'.repeat(width)).join('-|-');
	const rowLines = serializedRows.map(serialized =>
		serialized
			.map((cell, index) => cell.padEnd(widths[index] ?? 0))
			.join(' | '),
	);

	return [headerLine, separatorLine, ...rowLines];
}

function formatRowsForQuiet(rows: Array<Record<string, unknown>>): string[] {
	if (rows.length === 0) {
		return [];
	}

	const firstRow = rows[0];
	if (!firstRow) {
		return [];
	}

	const headers = Object.keys(firstRow);
	const lines = [headers.join('\t')];

	for (const row of rows) {
		lines.push(headers.map(header => stringifyCell(row[header])).join('\t'));
	}

	return lines;
}

function stringifyCell(value: unknown): string {
	if (value === null) {
		return 'null';
	}

	if (typeof value === 'object') {
		return JSON.stringify(value);
	}

	return String(value);
}

function getRequiredArg(args: string[], index: number): string {
	const argument = args[index];
	if (!argument) {
		throw new CliError('INVALID_ARGUMENT', 'Required argument is missing.', {
			hint: 'Run `meow --help` to see command usage.',
		});
	}

	return argument;
}
