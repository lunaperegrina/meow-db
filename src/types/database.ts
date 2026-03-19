export type DatabaseEntry = {
	id: string;
	name: string;
	postgresUrl: string;
	createdAt: string;
	updatedAt: string;
};

export type DatabaseState = {
	activeDatabaseId: string | null;
	databases: DatabaseEntry[];
};

export type AddDatabaseInput = {
	name: string;
	postgresUrl: string;
};
