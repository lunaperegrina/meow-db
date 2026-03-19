import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import {
	addDatabase,
	getState,
	setActiveDatabase,
} from './storage/databases.js';
import { listTableRows, listTables } from './storage/postgres.js';
import type {
	DatabaseEntry,
	DatabaseState,
	TableReference,
	TableRowsPreview,
} from './types/database.js';

const FALLBACK_COLUMNS = 80;
const FALLBACK_ROWS = 24;
const STATUS_BAR_HEIGHT = 1;
const INPUT_BAR_HEIGHT = 5;
const MODAL_HEIGHT = 9;
const SPLIT_GAP = 2;
const SIDEBAR_MIN_WIDTH = 24;
const SIDEBAR_MAX_WIDTH = 44;
const CONTENT_MIN_WIDTH = 20;
const ROWS_PREVIEW_LIMIT = 50;
const ROW_NUMBER_WIDTH = 4;
const CELL_MIN_WIDTH = 8;
const CELL_MAX_WIDTH = 24;
const CELL_SEPARATOR = ' | ';
const MAIN_BACKGROUND = '#0B1020';
const SURFACE_BACKGROUND = '#131A2A';
const PRIMARY_TEXT = '#F3F6FC';
const SECONDARY_TEXT = '#8C97B2';

const getTerminalSize = (stdout: NodeJS.WriteStream) => ({
	columns: stdout.columns && stdout.columns > 0 ? stdout.columns : FALLBACK_COLUMNS,
	rows: stdout.rows && stdout.rows > 0 ? stdout.rows : FALLBACK_ROWS,
});

const getSplitPaneSizes = (
	terminalColumns: number,
	hasActiveDatabase: boolean,
): {
	mainWidth: number;
	sidebarWidth: number;
	contentWidth: number;
} => {
	const mainWidth = Math.max(24, terminalColumns - 2);
	if (!hasActiveDatabase) {
		return {
			mainWidth,
			sidebarWidth: 0,
			contentWidth: mainWidth,
		};
	}

	const preferredSidebar = Math.floor(mainWidth * 0.34);
	const boundedSidebar = Math.min(
		SIDEBAR_MAX_WIDTH,
		Math.max(SIDEBAR_MIN_WIDTH, preferredSidebar),
	);
	const maxSidebarForContent = Math.max(
		SIDEBAR_MIN_WIDTH,
		mainWidth - CONTENT_MIN_WIDTH - SPLIT_GAP,
	);
	const sidebarWidth = Math.min(boundedSidebar, maxSidebarForContent);
	const contentWidth = Math.max(
		CONTENT_MIN_WIDTH,
		mainWidth - sidebarWidth - SPLIT_GAP,
	);

	return {
		mainWidth,
		sidebarWidth,
		contentWidth,
	};
};

type AppMode =
	| 'chat'
	| 'slashMenu'
	| 'addForm'
	| 'listModal';
type AddFormField = 'name' | 'postgresUrl';

type SlashCommand = {
	id: 'add' | 'list' | 'tables';
	label: string;
	description: string;
};

const slashCommands: SlashCommand[] = [
	{ id: 'add', label: 'add', description: 'Add database' },
	{ id: 'list', label: 'list', description: 'List databases' },
	{ id: 'tables', label: 'tables', description: 'Reload tables for active database' },
];

const isNavigationKey = (key: {
	tab?: boolean;
	upArrow?: boolean;
	downArrow?: boolean;
	leftArrow?: boolean;
	rightArrow?: boolean;
	pageUp?: boolean;
	pageDown?: boolean;
	escape?: boolean;
}) =>
	Boolean(
		key.tab ||
			key.upArrow ||
			key.downArrow ||
			key.leftArrow ||
			key.rightArrow ||
			key.pageUp ||
			key.pageDown ||
			key.escape,
	);

const normalizeInput = (value: string) => value.replaceAll(/\r?\n/g, '');
const ESCAPE_INPUT = '\u001B';

const wrapIndex = (index: number, total: number): number => {
	if (total <= 0) {
		return 0;
	}

	if (index < 0) {
		return total - 1;
	}

	if (index >= total) {
		return 0;
	}

	return index;
};

const truncateText = (value: string, maxLength: number): string => {
	if (maxLength <= 1) {
		return value.length > 0 ? '…' : '';
	}

	if (value.length <= maxLength) {
		return value;
	}

	return `${value.slice(0, maxLength - 1)}…`;
};

const padCell = (value: string, width: number): string =>
	truncateText(value, width).padEnd(width, ' ');

const formatCellValue = (value: unknown): string => {
	if (value === null) {
		return 'null';
	}

	if (value === undefined) {
		return 'undefined';
	}

	if (typeof value === 'string') {
		return value.replaceAll(/\r?\n/g, ' ');
	}

	if (
		typeof value === 'number' ||
		typeof value === 'boolean' ||
		typeof value === 'bigint'
	) {
		return String(value);
	}

	if (value instanceof Date) {
		return value.toISOString();
	}

	try {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) {
			return String(value);
		}

		return serialized.replaceAll(/\r?\n/g, ' ');
	} catch {
		return String(value);
	}
};

const getErrorMessage = (error: unknown): string => {
	if (error instanceof Error) {
		return error.message;
	}

	return 'Erro desconhecido.';
};

const getRowsViewport = (
	terminalColumns: number,
	totalColumns: number,
	requestedOffset: number,
): {
	cellWidth: number;
	visibleColumnCount: number;
	maxOffset: number;
	offset: number;
} => {
	if (totalColumns <= 0) {
		return {
			cellWidth: CELL_MIN_WIDTH,
			visibleColumnCount: 0,
			maxOffset: 0,
			offset: 0,
		};
	}

	const innerWidth = Math.max(24, terminalColumns - 8);
	const availableForCells = Math.max(
		1,
		innerWidth - ROW_NUMBER_WIDTH - CELL_SEPARATOR.length,
	);
	const maxVisibleColumnCount = Math.max(
		1,
		Math.floor(
			(availableForCells + CELL_SEPARATOR.length)
				/ (CELL_MIN_WIDTH + CELL_SEPARATOR.length),
		),
	);
	const visibleColumnCount = Math.min(totalColumns, maxVisibleColumnCount);
	const separatorsWidth = CELL_SEPARATOR.length * Math.max(0, visibleColumnCount - 1);
	const cellWidth = Math.min(
		CELL_MAX_WIDTH,
		Math.max(
			CELL_MIN_WIDTH,
			Math.floor((availableForCells - separatorsWidth) / visibleColumnCount),
		),
	);
	const maxOffset = Math.max(0, totalColumns - visibleColumnCount);
	const offset = Math.min(Math.max(0, requestedOffset), maxOffset);

	return {
		cellWidth,
		visibleColumnCount,
		maxOffset,
		offset,
	};
};

const INITIAL_DATABASE_STATE: DatabaseState = {
	activeDatabaseId: null,
	databases: [],
};

export default function App() {
	const { stdout } = useStdout();
	const [messages, setMessages] = useState<string[]>([]);
	const [draft, setDraft] = useState('');
	const [mode, setMode] = useState<AppMode>('chat');
	const [slashQuery, setSlashQuery] = useState('');
	const [slashIndex, setSlashIndex] = useState(0);
	const [formField, setFormField] = useState<AddFormField>('name');
	const [formName, setFormName] = useState('');
	const [formPostgresUrl, setFormPostgresUrl] = useState('');
	const [listIndex, setListIndex] = useState(0);
	const [databaseState, setDatabaseState] = useState<DatabaseState>(INITIAL_DATABASE_STATE);
	const [isLoadingDatabases, setIsLoadingDatabases] = useState(true);
	const [isSavingDatabase, setIsSavingDatabase] = useState(false);
	const [isSettingActive, setIsSettingActive] = useState(false);
	const [tables, setTables] = useState<TableReference[]>([]);
	const [tablesIndex, setTablesIndex] = useState(0);
	const [isLoadingTables, setIsLoadingTables] = useState(false);
	const [tablesError, setTablesError] = useState<string | null>(null);
	const [selectedTable, setSelectedTable] = useState<TableReference | null>(null);
	const [rowsPreview, setRowsPreview] = useState<TableRowsPreview | null>(null);
	const [rowsError, setRowsError] = useState<string | null>(null);
	const [rowsColumnOffset, setRowsColumnOffset] = useState(0);
	const [isLoadingRows, setIsLoadingRows] = useState(false);
	const tablesLoadIdRef = useRef(0);
	const rowsLoadIdRef = useRef(0);
	const [terminalSize, setTerminalSize] = useState(() => getTerminalSize(stdout));

	const rowsCount = rowsPreview?.rows.length ?? 0;
	const rowsColumnCount = rowsPreview?.columns.length ?? 0;

	useEffect(() => {
		const handleResize = () => {
			setTerminalSize(getTerminalSize(stdout));
		};

		stdout.on('resize', handleResize);
		return () => {
			stdout.off('resize', handleResize);
		};
	}, [stdout]);

	useEffect(() => {
		let mounted = true;

		const bootstrapDatabaseState = async () => {
			try {
				const state = await getState();
				if (!mounted) {
					return;
				}

				setDatabaseState(state);
			} catch (error) {
				if (!mounted) {
					return;
				}

				setMessages(previous => [
					...previous,
					`Erro ao carregar databases: ${getErrorMessage(error)}`,
				]);
			} finally {
				if (mounted) {
					setIsLoadingDatabases(false);
				}
			}
		};

		void bootstrapDatabaseState();

		return () => {
			mounted = false;
		};
	}, []);

	const pushMessage = (message: string) => {
		setMessages(previous => [...previous, message]);
	};

	const filteredCommands = useMemo(() => {
		const query = slashQuery.trim().toLowerCase();

		if (query.length === 0) {
			return slashCommands;
		}

		return slashCommands.filter(command =>
			command.label.toLowerCase().includes(query),
		);
	}, [slashQuery]);

	useEffect(() => {
		setSlashIndex(previous => wrapIndex(previous, filteredCommands.length));
	}, [filteredCommands.length]);

	useEffect(() => {
		setListIndex(previous => wrapIndex(previous, databaseState.databases.length));
	}, [databaseState.databases.length]);

	useEffect(() => {
		setTablesIndex(previous => wrapIndex(previous, tables.length));
	}, [tables.length]);

	useEffect(() => {
		if (rowsColumnCount === 0) {
			if (rowsColumnOffset !== 0) {
				setRowsColumnOffset(0);
			}
			return;
		}

		const splitPaneSizes = getSplitPaneSizes(
			terminalSize.columns,
			databaseState.activeDatabaseId !== null,
		);
		const viewport = getRowsViewport(
			splitPaneSizes.contentWidth,
			rowsColumnCount,
			rowsColumnOffset,
		);
		if (viewport.offset !== rowsColumnOffset) {
			setRowsColumnOffset(viewport.offset);
		}
	}, [
		databaseState.activeDatabaseId,
		rowsColumnCount,
		rowsColumnOffset,
		terminalSize.columns,
	]);

	const activeDatabase = useMemo(
		() =>
			databaseState.databases.find(
				database => database.id === databaseState.activeDatabaseId,
			) ?? null,
		[databaseState],
	);

	const resetRowsState = useCallback(() => {
		rowsLoadIdRef.current += 1;
		setSelectedTable(null);
		setRowsPreview(null);
		setRowsError(null);
		setRowsColumnOffset(0);
		setIsLoadingRows(false);
	}, []);

	const loadTablesForDatabase = useCallback(
		async (database: DatabaseEntry | null) => {
			const loadId = tablesLoadIdRef.current + 1;
			tablesLoadIdRef.current = loadId;

			setTables([]);
			setTablesIndex(0);
			setTablesError(null);
			resetRowsState();

			if (!database) {
				setIsLoadingTables(false);
				return;
			}

			setIsLoadingTables(true);
			try {
				const nextTables = await listTables(database.postgresUrl);
				if (tablesLoadIdRef.current !== loadId) {
					return;
				}

				setTables(nextTables);
				setTablesIndex(0);
			} catch (error) {
				if (tablesLoadIdRef.current !== loadId) {
					return;
				}

				setTablesError(getErrorMessage(error));
			} finally {
				if (tablesLoadIdRef.current === loadId) {
					setIsLoadingTables(false);
				}
			}
		},
		[resetRowsState],
	);

	useEffect(() => {
		void loadTablesForDatabase(activeDatabase);
	}, [activeDatabase, loadTablesForDatabase]);

	const openListModal = () => {
		const activeIndex = databaseState.databases.findIndex(
			database => database.id === databaseState.activeDatabaseId,
		);
		setListIndex(activeIndex >= 0 ? activeIndex : 0);
		setMode('listModal');
		setDraft('');
		setSlashQuery('');
		setSlashIndex(0);
	};

	const closeSlashMenu = () => {
		setMode('chat');
		setSlashQuery('');
		setSlashIndex(0);
	};

	const loadRowsForSelectedTable = useCallback(async () => {
		if (!activeDatabase) {
			return;
		}

		const table = tables[tablesIndex];
		if (!table) {
			return;
		}

		const loadId = rowsLoadIdRef.current + 1;
		rowsLoadIdRef.current = loadId;

		setSelectedTable(table);
		setRowsPreview(null);
		setRowsError(null);
		setRowsColumnOffset(0);
		setIsLoadingRows(true);

		try {
			const preview = await listTableRows(
				activeDatabase.postgresUrl,
				table.schema,
				table.name,
				ROWS_PREVIEW_LIMIT,
			);
			if (rowsLoadIdRef.current !== loadId) {
				return;
			}

			setRowsPreview(preview);
		} catch (error) {
			if (rowsLoadIdRef.current !== loadId) {
				return;
			}

			setRowsError(getErrorMessage(error));
		} finally {
			if (rowsLoadIdRef.current === loadId) {
				setIsLoadingRows(false);
			}
		}
	}, [activeDatabase, tables, tablesIndex]);

	const selectSlashCommand = () => {
		const selectedCommand = filteredCommands[slashIndex];
		if (!selectedCommand) {
			pushMessage('Nenhum comando encontrado.');
			closeSlashMenu();
			return;
		}

		if (selectedCommand.id === 'add') {
			setMode('addForm');
			setFormField('name');
			setFormName('');
			setFormPostgresUrl('');
			setDraft('');
			setSlashQuery('');
			setSlashIndex(0);
			return;
		}

		if (selectedCommand.id === 'list') {
			openListModal();
			return;
		}

		closeSlashMenu();
		if (!activeDatabase) {
			pushMessage('Nenhuma database ativa. Use /add ou /list para selecionar uma database.');
			return;
		}

		void loadTablesForDatabase(activeDatabase);
	};

	const submitAddForm = async () => {
		if (isSavingDatabase) {
			return;
		}

		setIsSavingDatabase(true);
		try {
			const state = await addDatabase({
				name: formName,
				postgresUrl: formPostgresUrl,
			});
			const createdDatabase =
				state.databases.find(database => database.id === state.activeDatabaseId) ?? null;

			setDatabaseState(state);
			setMode('chat');
			setFormField('name');
			setFormName('');
			setFormPostgresUrl('');
			pushMessage(
				createdDatabase
					? `Database "${createdDatabase.name}" salva e ativada.`
					: 'Database salva e ativada.',
			);
		} catch (error) {
			pushMessage(`Erro ao salvar database: ${getErrorMessage(error)}`);
		} finally {
			setIsSavingDatabase(false);
		}
	};

	const activateSelectedDatabase = async () => {
		if (isSettingActive || databaseState.databases.length === 0) {
			return;
		}

		const selectedDatabase = databaseState.databases[listIndex];
		if (!selectedDatabase) {
			return;
		}

		setIsSettingActive(true);
		try {
			const state = await setActiveDatabase(selectedDatabase.id);
			setDatabaseState(state);
			setMode('chat');
			pushMessage(`Database ativa: ${selectedDatabase.name}`);
		} catch (error) {
			pushMessage(`Erro ao ativar database: ${getErrorMessage(error)}`);
		} finally {
			setIsSettingActive(false);
		}
	};

	useInput((input, key) => {
		const isEscapePressed = key.escape || input === ESCAPE_INPUT;

		if (isEscapePressed) {
			if (mode === 'slashMenu') {
				closeSlashMenu();
				return;
			}

			if (mode === 'addForm') {
				setMode('chat');
				setFormField('name');
				return;
			}

			if (mode === 'listModal') {
				setMode('chat');
				return;
			}
		}

		if (key.ctrl || key.meta) {
			return;
		}

		const cleanedInput = normalizeInput(input);

		if (mode === 'slashMenu') {
			if (key.return) {
				selectSlashCommand();
				return;
			}

			if (key.upArrow) {
				setSlashIndex(previous => wrapIndex(previous - 1, filteredCommands.length));
				return;
			}

			if (key.downArrow || key.tab) {
				setSlashIndex(previous => wrapIndex(previous + 1, filteredCommands.length));
				return;
			}

			if (key.backspace || key.delete) {
				if (slashQuery.length === 0) {
					closeSlashMenu();
					return;
				}

				setSlashQuery(previous => previous.slice(0, -1));
				setSlashIndex(0);
				return;
			}

			if (isNavigationKey(key)) {
				return;
			}

			if (cleanedInput.length > 0 && cleanedInput !== '/') {
				setSlashQuery(previous => previous + cleanedInput);
				setSlashIndex(0);
			}

			return;
		}

		if (mode === 'addForm') {
			if (key.tab || key.upArrow || key.downArrow) {
				setFormField(previous => (previous === 'name' ? 'postgresUrl' : 'name'));
				return;
			}

			if (key.return) {
				void submitAddForm();
				return;
			}

			if (key.backspace || key.delete) {
				if (formField === 'name') {
					setFormName(previous => previous.slice(0, -1));
				} else {
					setFormPostgresUrl(previous => previous.slice(0, -1));
				}
				return;
			}

			if (isNavigationKey(key)) {
				return;
			}

			if (cleanedInput.length > 0) {
				if (formField === 'name') {
					setFormName(previous => previous + cleanedInput);
				} else {
					setFormPostgresUrl(previous => previous + cleanedInput);
				}
			}

			return;
		}

		if (mode === 'listModal') {
			if (key.upArrow) {
				setListIndex(previous => wrapIndex(previous - 1, databaseState.databases.length));
				return;
			}

			if (key.downArrow || key.tab) {
				setListIndex(previous => wrapIndex(previous + 1, databaseState.databases.length));
				return;
			}

			if (key.return) {
				void activateSelectedDatabase();
			}

			return;
		}

		if (key.upArrow) {
			if (!isLoadingTables && tables.length > 0) {
				setTablesIndex(previous => wrapIndex(previous - 1, tables.length));
			}
			return;
		}

		if (key.downArrow || key.tab) {
			if (!isLoadingTables && tables.length > 0) {
				setTablesIndex(previous => wrapIndex(previous + 1, tables.length));
			}
			return;
		}

		if (key.leftArrow) {
			if (rowsPreview) {
				setRowsColumnOffset(previous => Math.max(0, previous - 1));
			}
			return;
		}

		if (key.rightArrow) {
			if (rowsPreview) {
				setRowsColumnOffset(previous => Math.min(rowsViewport.maxOffset, previous + 1));
			}
			return;
		}

		if (input === '/' && draft.length === 0) {
			setMode('slashMenu');
			setSlashQuery('');
			setSlashIndex(0);
			return;
		}

		if (key.return) {
			const message = draft.trim();
			if (message.length > 0) {
				setMessages(previous => [...previous, message]);
				setDraft('');
				return;
			}

			if (!isLoadingRows && !isLoadingTables && activeDatabase && tables.length > 0) {
				void loadRowsForSelectedTable();
			}
			return;
		}

		if (key.backspace || key.delete) {
			setDraft(previous => previous.slice(0, -1));
			return;
		}

		if (
			key.escape ||
			key.pageUp ||
			key.pageDown
		) {
			return;
		}

		if (cleanedInput.length > 0) {
			setDraft(previous => previous + cleanedInput);
		}
	});

	const modalRows =
		mode === 'slashMenu' || mode === 'addForm' || mode === 'listModal'
			? MODAL_HEIGHT
			: 0;
	const mainViewportRows = Math.max(
		1,
		terminalSize.rows - INPUT_BAR_HEIGHT - STATUS_BAR_HEIGHT - modalRows - 2,
	);
	const visibleMessages = messages.slice(-mainViewportRows);
	const hasActiveDatabase = activeDatabase !== null;
	const splitPaneSizes = useMemo(
		() => getSplitPaneSizes(terminalSize.columns, hasActiveDatabase),
		[hasActiveDatabase, terminalSize.columns],
	);
	const inputLabel =
		mode === 'chat'
			? `› ${draft}`
			: mode === 'slashMenu'
				? `› /${slashQuery}`
				: mode === 'addForm'
					? '› preenchendo formulário de database'
					: '› selecionando database ativa';

	const dbIndicator = isLoadingDatabases
		? 'loading...'
		: activeDatabase
			? `${activeDatabase.name}`
			: 'none';

	const listEntries = databaseState.databases;
	const listMaxUrlLength = Math.max(12, terminalSize.columns - 18);
	const tableNameMaxLength = Math.max(10, splitPaneSizes.sidebarWidth - 4);
	const selectedSidebarTable = tables[tablesIndex] ?? null;

	const rowsViewport = useMemo(() => {
		if (!rowsPreview) {
			return {
				cellWidth: CELL_MIN_WIDTH,
				visibleColumnCount: 0,
				maxOffset: 0,
				offset: 0,
				visibleColumns: [] as string[],
			};
		}

		const viewport = getRowsViewport(
			splitPaneSizes.contentWidth,
			rowsPreview.columns.length,
			rowsColumnOffset,
		);
		return {
			...viewport,
			visibleColumns: rowsPreview.columns.slice(
				viewport.offset,
				viewport.offset + viewport.visibleColumnCount,
			),
		};
	}, [rowsPreview, rowsColumnOffset, splitPaneSizes.contentWidth]);

	const rowsHeaderLine = useMemo(() => {
		if (rowsViewport.visibleColumns.length === 0) {
			return '';
		}

		const headerColumns = rowsViewport.visibleColumns
			.map(column => padCell(column, rowsViewport.cellWidth))
			.join(CELL_SEPARATOR);
		return `${padCell('row', ROW_NUMBER_WIDTH)}${CELL_SEPARATOR}${headerColumns}`;
	}, [rowsViewport]);

	const rowsWindowSize = Math.max(1, mainViewportRows - 6);
	const rowsWindowStart = 0;
	const visibleRows = rowsPreview
		? rowsPreview.rows.slice(rowsWindowStart, rowsWindowStart + rowsWindowSize)
		: [];

	const tablesWindowSize = Math.max(1, mainViewportRows - 4);
	const maxTablesWindowStart = Math.max(0, tables.length - tablesWindowSize);
	const tablesWindowStart = Math.min(
		maxTablesWindowStart,
		Math.max(0, tablesIndex - Math.floor(tablesWindowSize / 2)),
	);
	const visibleTables = tables.slice(
		tablesWindowStart,
		tablesWindowStart + tablesWindowSize,
	);

	return (
		<Box
			flexDirection="column"
			width={terminalSize.columns}
			height={terminalSize.rows}
		>
			<Box
				flexDirection="column"
				flexGrow={1}
				width={terminalSize.columns}
				padding={1}
				overflow="hidden"
				backgroundColor={MAIN_BACKGROUND}
			>
				{hasActiveDatabase ? (
					<Box flexDirection="row" flexGrow={1} overflow="hidden">
						<Box
							flexDirection="column"
							width={splitPaneSizes.sidebarWidth}
							overflow="hidden"
						>
							<Text bold color={PRIMARY_TEXT}>
								{`Tables • ${truncateText(activeDatabase?.name ?? '', Math.max(10, splitPaneSizes.sidebarWidth - 12))}`}
							</Text>
							{isLoadingTables ? (
								<Text color={SECONDARY_TEXT}>Carregando tabelas...</Text>
							) : tablesError ? (
								<Text color="red">{`Erro ao carregar tabelas: ${tablesError}`}</Text>
							) : tables.length === 0 ? (
								<Text color={SECONDARY_TEXT}>Nenhuma tabela encontrada.</Text>
							) : (
								visibleTables.map((table, index) => {
									const absoluteIndex = tablesWindowStart + index;
									const isSelected = absoluteIndex === tablesIndex;
									return (
										<Text key={table.qualifiedName} color={isSelected ? 'magenta' : PRIMARY_TEXT}>
											{`${isSelected ? '›' : ' '} ${truncateText(table.qualifiedName, tableNameMaxLength)}`}
										</Text>
									);
								})
							)}
							<Text color={SECONDARY_TEXT}>
								{tables.length > 0
									? `${tablesIndex + 1}/${tables.length} • enter carrega rows`
									: 'use /tables para recarregar'}
							</Text>
						</Box>

						<Box width={SPLIT_GAP} />

						<Box
							flexDirection="column"
							flexGrow={1}
							width={splitPaneSizes.contentWidth}
							overflow="hidden"
						>
							<Text bold color={PRIMARY_TEXT}>
								{selectedTable
									? `Rows • ${truncateText(selectedTable.qualifiedName, Math.max(10, splitPaneSizes.contentWidth - 12))}`
									: selectedSidebarTable
										? `Rows • ${truncateText(selectedSidebarTable.qualifiedName, Math.max(10, splitPaneSizes.contentWidth - 12))}`
										: 'Rows'}
							</Text>
							{isLoadingRows ? (
								<Text color={SECONDARY_TEXT}>Carregando rows...</Text>
							) : rowsError ? (
								<Text color="red">{`Erro ao carregar rows: ${rowsError}`}</Text>
							) : !selectedTable || !rowsPreview ? (
								<Text color={SECONDARY_TEXT}>
									Selecione uma table na sidebar e pressione Enter.
								</Text>
							) : rowsViewport.visibleColumns.length === 0 ? (
								<Text color={SECONDARY_TEXT}>Não há colunas para exibir.</Text>
							) : (
								<>
									<Text color="cyan">{rowsHeaderLine}</Text>
									{rowsPreview.rows.length === 0 ? (
										<Text color={SECONDARY_TEXT}>Sem rows para exibir.</Text>
									) : (
										visibleRows.map((row, index) => {
											const absoluteIndex = rowsWindowStart + index;
											const rowLabel = padCell(String(absoluteIndex + 1), ROW_NUMBER_WIDTH);
											const rowCells = rowsViewport.visibleColumns
												.map(column => padCell(formatCellValue(row[column]), rowsViewport.cellWidth))
												.join(CELL_SEPARATOR);
											const rowLine = `${rowLabel}${CELL_SEPARATOR}${rowCells}`;

											return (
												<Text key={`${absoluteIndex}-${rowLine}`} color={PRIMARY_TEXT}>
													{rowLine}
												</Text>
											);
										})
									)}
									<Text color={SECONDARY_TEXT}>
										{`mostrando ${visibleRows.length}/${rowsCount} rows (limit ${rowsPreview.limit})`}
									</Text>
									<Text color={SECONDARY_TEXT}>
										{`colunas ${rowsViewport.offset + 1}-${rowsViewport.offset + rowsViewport.visibleColumns.length}/${rowsPreview.columns.length}`}
									</Text>
								</>
							)}
							<Text color={SECONDARY_TEXT}>
								↑/↓ tables • enter carrega rows • ←/→ colunas
							</Text>
						</Box>
					</Box>
				) : (
					<>
						{visibleMessages.length === 0 ? (
							<Text color={SECONDARY_TEXT}>Digite / para abrir o slash menu.</Text>
						) : null}
						{visibleMessages.map((message, index) => (
							<Text key={`${index}-${message}`} color={PRIMARY_TEXT}>
								{message}
							</Text>
						))}
					</>
				)}
			</Box>

			{mode === 'slashMenu' ? (
				<Box
					width={terminalSize.columns}
					paddingX={1}
					paddingBottom={1}
					backgroundColor={MAIN_BACKGROUND}
				>
					<Box
						flexDirection="column"
						borderStyle="round"
						borderColor="cyan"
						paddingX={1}
						width={Math.max(24, terminalSize.columns - 2)}
						height={MODAL_HEIGHT}
					>
						{filteredCommands.length === 0 ? (
							<Text color="red">Nenhum comando encontrado.</Text>
						) : (
							filteredCommands.map((command, index) => {
								const isSelected = index === slashIndex;
								return (
									<Box key={command.id} justifyContent="space-between">
										<Text color={isSelected ? 'cyan' : PRIMARY_TEXT}>
											{`${isSelected ? '›' : ' '} /${command.label}`}
										</Text>
										<Text color={SECONDARY_TEXT}>{command.description}</Text>
									</Box>
								);
							})
						)}
					</Box>
				</Box>
			) : null}

			{mode === 'addForm' ? (
				<Box
					width={terminalSize.columns}
					paddingX={1}
					paddingBottom={1}
					backgroundColor={MAIN_BACKGROUND}
				>
					<Box
						flexDirection="column"
						borderStyle="round"
						borderColor="green"
						paddingX={1}
						width={Math.max(24, terminalSize.columns - 2)}
						height={MODAL_HEIGHT}
					>
						<Box justifyContent="space-between">
							<Text bold color={PRIMARY_TEXT}>
								Add database
							</Text>
							<Text color={SECONDARY_TEXT}>esc</Text>
						</Box>
						<Text color={formField === 'name' ? 'green' : PRIMARY_TEXT}>
							{`name: ${formField === 'name' ? '›' : ' '} ${formName.length > 0 ? formName : '...'}`}
						</Text>
						<Text color={formField === 'postgresUrl' ? 'green' : PRIMARY_TEXT}>
							{`postgresURL: ${formField === 'postgresUrl' ? '›' : ' '} ${formPostgresUrl.length > 0 ? formPostgresUrl : '...'}`}
						</Text>
						<Text color={SECONDARY_TEXT}>tab alterna campo • enter salva • esc cancela</Text>
						<Text color={SECONDARY_TEXT}>
							{isSavingDatabase
								? 'Salvando database...'
								: 'URL aceita: postgres:// ou postgresql://'}
						</Text>
					</Box>
				</Box>
			) : null}

			{mode === 'listModal' ? (
				<Box
					width={terminalSize.columns}
					paddingX={1}
					paddingBottom={1}
					backgroundColor={MAIN_BACKGROUND}
				>
					<Box
						flexDirection="column"
						borderStyle="round"
						borderColor="yellow"
						paddingX={1}
						width={Math.max(24, terminalSize.columns - 2)}
						height={MODAL_HEIGHT}
					>
						<Box justifyContent="space-between">
							<Text bold color={PRIMARY_TEXT}>
								Databases
							</Text>
							<Text color={SECONDARY_TEXT}>esc</Text>
						</Box>
						{listEntries.length === 0 ? (
							<Text color={SECONDARY_TEXT}>Nenhuma database cadastrada.</Text>
						) : (
							listEntries.map((database, index) => {
								const isSelected = index === listIndex;
								const isActive = database.id === databaseState.activeDatabaseId;
								return (
									<Box key={database.id} flexDirection="column">
										<Text color={isSelected ? 'yellow' : PRIMARY_TEXT}>
											{`${isSelected ? '›' : ' '} ${database.name}${isActive ? ' (active)' : ''}`}
										</Text>
										<Text color={SECONDARY_TEXT}>
											{`   ${truncateText(database.postgresUrl, listMaxUrlLength)}`}
										</Text>
									</Box>
								);
							})
						)}
						<Text color={SECONDARY_TEXT}>{isSettingActive && 'Ativando database...'}</Text>
					</Box>
				</Box>
			) : null}

			<Box
				width={terminalSize.columns}
				height={INPUT_BAR_HEIGHT}
				padding={1}
				backgroundColor={SURFACE_BACKGROUND}
				flexDirection="column"
				justifyContent="space-between"
			>
				<Text color={PRIMARY_TEXT}>{inputLabel}</Text>
				<Text color={PRIMARY_TEXT}>
					<Text color="green">Database </Text>
					{dbIndicator}
				</Text>
			</Box>
		</Box>
	);
}
