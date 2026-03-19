import {Client} from 'pg';
import {CliError} from './errors';

export async function listTables(
	url: string,
	schema: string,
): Promise<string[]> {
	const client = new Client({connectionString: url});

	try {
		await client.connect();
		const result = await client.query<{table_name: string}>(
			`
				SELECT table_name
				FROM information_schema.tables
				WHERE table_schema = $1
					AND table_type = 'BASE TABLE'
				ORDER BY table_name ASC
			`,
			[schema],
		);

		return result.rows.map(row => row.table_name);
	} catch (error: unknown) {
		if (isConnectionError(error)) {
			throw new CliError(
				'DB_CONNECTION_FAILED',
				'Could not connect to PostgreSQL.',
				{
					hint: 'Check the active database URL with `meow db info`.',
					cause: error,
				},
			);
		}

		throw new CliError('DB_QUERY_FAILED', 'Could not list tables.', {
			hint: 'Verify schema permissions and try again.',
			cause: error,
		});
	} finally {
		await client.end().catch(() => undefined);
	}
}

export async function getRows(
	url: string,
	schema: string,
	table: string,
	limit: number,
): Promise<Array<Record<string, unknown>>> {
	const client = new Client({connectionString: url});

	try {
		await client.connect();
		const statement = `SELECT * FROM "${schema}"."${table}" LIMIT $1`;
		const result = await client.query<Record<string, unknown>>(statement, [
			limit,
		]);
		return result.rows;
	} catch (error: unknown) {
		if (isConnectionError(error)) {
			throw new CliError(
				'DB_CONNECTION_FAILED',
				'Could not connect to PostgreSQL.',
				{
					hint: 'Check the active database URL with `meow db info`.',
					cause: error,
				},
			);
		}

		throw new CliError('DB_QUERY_FAILED', 'Could not fetch rows.', {
			hint: 'Check table/schema names and permissions.',
			cause: error,
		});
	} finally {
		await client.end().catch(() => undefined);
	}
}

function isConnectionError(error: unknown): boolean {
	if (!error || typeof error !== 'object') {
		return false;
	}

	if (!('code' in error) || typeof error.code !== 'string') {
		return false;
	}

	return ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(error.code);
}
