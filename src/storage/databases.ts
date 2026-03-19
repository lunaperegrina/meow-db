import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {AddDatabaseInput, DatabaseEntry, DatabaseState} from '../types/database.js';

const CONFIG_DIRECTORY = path.join(os.homedir(), '.config', 'meowdb');
const DATABASES_FILE = path.join(CONFIG_DIRECTORY, 'databases.json');

const createDefaultState = (): DatabaseState => ({
	activeDatabaseId: null,
	databases: [],
});

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;

const isDatabaseEntry = (value: unknown): value is DatabaseEntry => {
	if (!isObject(value)) {
		return false;
	}

	return (
		typeof value.id === 'string' &&
		typeof value.name === 'string' &&
		typeof value.postgresUrl === 'string' &&
		typeof value.createdAt === 'string' &&
		typeof value.updatedAt === 'string'
	);
};

const normalizeState = (value: unknown): DatabaseState => {
	if (!isObject(value) || !Array.isArray(value.databases)) {
		throw new Error('Arquivo de databases inválido.');
	}

	const databases = value.databases.filter(isDatabaseEntry);
	const activeDatabaseId =
		typeof value.activeDatabaseId === 'string' ? value.activeDatabaseId : null;
	const hasActiveDatabase =
		activeDatabaseId !== null && databases.some(database => database.id === activeDatabaseId);

	return {
		activeDatabaseId: hasActiveDatabase ? activeDatabaseId : null,
		databases,
	};
};

const ensureStorage = async (): Promise<void> => {
	await fs.mkdir(CONFIG_DIRECTORY, {recursive: true});

	try {
		await fs.access(DATABASES_FILE);
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException;
		if (nodeError.code !== 'ENOENT') {
			throw error;
		}

		await fs.writeFile(DATABASES_FILE, `${JSON.stringify(createDefaultState(), null, 2)}\n`, 'utf8');
	}
};

const readState = async (): Promise<DatabaseState> => {
	await ensureStorage();
	const rawContent = await fs.readFile(DATABASES_FILE, 'utf8');
	const parsedContent = JSON.parse(rawContent) as unknown;
	return normalizeState(parsedContent);
};

const writeState = async (state: DatabaseState): Promise<void> => {
	await ensureStorage();
	await fs.writeFile(DATABASES_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
};

export const getState = async (): Promise<DatabaseState> => readState();

export const loadDatabases = async (): Promise<DatabaseEntry[]> => {
	const state = await readState();
	return state.databases;
};

export const addDatabase = async (input: AddDatabaseInput): Promise<DatabaseState> => {
	const state = await readState();
	const name = input.name.trim();
	const postgresUrl = input.postgresUrl.trim();

	if (name.length === 0) {
		throw new Error('Nome é obrigatório.');
	}

	if (postgresUrl.length === 0) {
		throw new Error('Postgres URL é obrigatória.');
	}

	const hasValidPrefix =
		postgresUrl.startsWith('postgres://') || postgresUrl.startsWith('postgresql://');
	if (!hasValidPrefix) {
		throw new Error('Postgres URL deve começar com postgres:// ou postgresql://.');
	}

	const duplicatedName = state.databases.some(
		database => database.name.toLowerCase() === name.toLowerCase(),
	);
	if (duplicatedName) {
		throw new Error('Já existe uma database com esse nome.');
	}

	const timestamp = new Date().toISOString();
	const newDatabase: DatabaseEntry = {
		id: randomUUID(),
		name,
		postgresUrl,
		createdAt: timestamp,
		updatedAt: timestamp,
	};

	const nextState: DatabaseState = {
		activeDatabaseId: newDatabase.id,
		databases: [...state.databases, newDatabase],
	};

	await writeState(nextState);
	return nextState;
};

export const setActiveDatabase = async (databaseId: string): Promise<DatabaseState> => {
	const state = await readState();

	const hasDatabase = state.databases.some(database => database.id === databaseId);
	if (!hasDatabase) {
		throw new Error('Database selecionada não existe.');
	}

	const nextState: DatabaseState = {
		...state,
		activeDatabaseId: databaseId,
	};

	await writeState(nextState);
	return nextState;
};
