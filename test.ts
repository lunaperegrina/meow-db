import * as process from 'node:process';
import * as os from 'node:os';
import * as path from 'node:path';
import {promises as fs} from 'node:fs';
import {spawnSync} from 'node:child_process';
import test from 'ava';
import {CliError} from './dist/errors.js';
import {executeCommand} from './dist/execute-command.js';
import {
	formatErrorJsonPayload,
	formatHumanErrorLines,
	formatHumanSuccessLines,
	formatSuccessJsonPayload,
} from './dist/output.js';

const databaseUrl = 'postgresql://user:pass@localhost:5432/app';

test('db add creates config and db list returns the active marker', async t => {
	const configRoot = await createTemporaryDirectory();
	const configPath = path.join(configRoot, 'config.json');

	await executeCommand(
		['db', 'add', 'local', databaseUrl],
		{json: false, quiet: false},
		{
			getPath: () => configPath,
			getNow: () => '2026-03-18T00:00:00.000Z',
		},
	);

	await executeCommand(
		['db', 'use', 'local'],
		{json: false, quiet: false},
		{getPath: () => configPath},
	);

	const list = await executeCommand(
		['db', 'list'],
		{json: false, quiet: false},
		{getPath: () => configPath},
	);
	t.true(list.human.lines[0].startsWith('* local'));
});

test('rows validates positive integer --limit', async t => {
	const error = await t.throwsAsync(
		executeCommand(['rows', 'users'], {json: false, quiet: false, limit: 0}),
	);

	t.true(error instanceof CliError);
	if (error instanceof CliError) {
		t.is(error.code, 'INVALID_ARGUMENT');
	}
});

test('rows validates schema and table identifiers', async t => {
	const schemaError = await t.throwsAsync(
		executeCommand(['rows', 'users'], {
			json: false,
			quiet: false,
			schema: 'analytics-prod',
		}),
	);

	t.true(schemaError instanceof CliError);
	if (schemaError instanceof CliError) {
		t.is(schemaError.code, 'INVALID_ARGUMENT');
	}

	const tableError = await t.throwsAsync(
		executeCommand(['rows', 'users;drop'], {json: false, quiet: false}),
	);

	t.true(tableError instanceof CliError);
	if (tableError instanceof CliError) {
		t.is(tableError.code, 'INVALID_ARGUMENT');
	}
});

test('tables and rows use active connection with injected db adapter', async t => {
	const configRoot = await createTemporaryDirectory();
	const configPath = path.join(configRoot, 'config.json');

	await executeCommand(
		['db', 'add', 'local', databaseUrl],
		{json: false, quiet: false},
		{
			getPath: () => configPath,
			getNow: () => '2026-03-18T00:00:00.000Z',
		},
	);
	await executeCommand(
		['db', 'use', 'local'],
		{json: false, quiet: false},
		{getPath: () => configPath},
	);

	const tablesCalls: string[] = [];
	const rowsCalls: string[] = [];

	const tablesResult = await executeCommand(
		['tables'],
		{json: false, quiet: false},
		{
			getPath: () => configPath,
			async listTables(url, schema) {
				tablesCalls.push(`${url}|${schema}`);
				return ['users', 'orders'];
			},
		},
	);

	const rowsResult = await executeCommand(
		['rows', 'users'],
		{json: false, quiet: true, limit: 5, schema: 'public'},
		{
			getPath: () => configPath,
			async getRows(url, schema, table, limit) {
				rowsCalls.push(`${url}|${schema}|${table}|${String(limit)}`);
				return [{id: 1, email: 'jane@example.com'}];
			},
		},
	);

	t.deepEqual(tablesCalls, [`${databaseUrl}|public`]);
	t.deepEqual(rowsCalls, [`${databaseUrl}|public|users|5`]);
	t.deepEqual(tablesResult.human.quietLines, ['users', 'orders']);
	t.deepEqual(rowsResult.human.quietLines, [
		'id\temail',
		'1\tjane@example.com',
	]);
});

test('output helpers generate stable json and human messages', t => {
	const successPayload = formatSuccessJsonPayload({
		command: 'db list',
		data: {connections: []},
		human: {lines: ['No databases configured.'], quietLines: []},
	});
	const errorPayload = formatErrorJsonPayload(
		new CliError('DB_NOT_FOUND', 'db "prod" not found.', {
			hint: 'Run `meow db list` to see available names.',
		}),
	);

	t.deepEqual(JSON.parse(successPayload), {
		ok: true,
		command: 'db list',
		data: {connections: []},
	});
	t.deepEqual(JSON.parse(errorPayload), {
		ok: false,
		error: {
			message: 'db "prod" not found.',
			hint: 'Run `meow db list` to see available names.',
			code: 'DB_NOT_FOUND',
		},
	});

	const lines = formatHumanSuccessLines(
		{
			command: 'db add',
			data: {name: 'local'},
			human: {lines: ['Added db "local".'], quietLines: ['local']},
		},
		true,
	);
	t.deepEqual(lines, ['local']);
	t.deepEqual(
		formatHumanErrorLines(
			new CliError('INVALID_ARGUMENT', 'Limit must be a positive integer.', {
				hint: 'Run `meow rows <table> --limit 20`.',
			}),
			false,
		),
		[
			'Error: Limit must be a positive integer.',
			'Hint: Run `meow rows <table> --limit 20`.',
		],
	);
});

test('cli smoke with --json works through entrypoint', async t => {
	const configRoot = await createTemporaryDirectory();
	const environment = {...process.env};
	environment['XDG_CONFIG_HOME'] = configRoot;
	environment['FORCE_COLOR'] = '0';

	const addResult = spawnSync(
		process.execPath,
		[
			'--loader=ts-node/esm',
			'./source/index.ts',
			'db',
			'add',
			'local',
			databaseUrl,
			'--json',
		],
		{
			cwd: process.cwd(),
			env: environment,
			encoding: 'utf8',
		},
	);
	t.is(addResult.status, 0);
	t.true(addResult.stdout.includes('"ok":true'));

	const listResult = spawnSync(
		process.execPath,
		['--loader=ts-node/esm', './source/index.ts', 'db', 'list', '--json'],
		{
			cwd: process.cwd(),
			env: environment,
			encoding: 'utf8',
		},
	);
	t.is(listResult.status, 0);
	t.true(listResult.stdout.includes('"command":"db list"'));
});

async function createTemporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meow-db-test-'));
	return directory;
}
