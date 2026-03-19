import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import {
	addDatabase,
	getState,
	setActiveDatabase,
} from './storage/databases.js';
import type { DatabaseState } from './types/database.js';

const FALLBACK_COLUMNS = 80;
const FALLBACK_ROWS = 24;
const STATUS_BAR_HEIGHT = 1;
const INPUT_BAR_HEIGHT = 5;
const MODAL_HEIGHT = 9;

const getTerminalSize = (stdout: NodeJS.WriteStream) => ({
	columns: stdout.columns && stdout.columns > 0 ? stdout.columns : FALLBACK_COLUMNS,
	rows: stdout.rows && stdout.rows > 0 ? stdout.rows : FALLBACK_ROWS,
});

type AppMode = 'chat' | 'slashMenu' | 'addForm' | 'listModal';
type AddFormField = 'name' | 'postgresUrl';

type SlashCommand = {
	id: 'add' | 'list';
	label: string;
	description: string;
};

const slashCommands: SlashCommand[] = [
	{ id: 'add', label: 'add', description: 'Add database' },
	{ id: 'list', label: 'list', description: 'List databases' },
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

const getErrorMessage = (error: unknown): string => {
	if (error instanceof Error) {
		return error.message;
	}

	return 'Erro desconhecido.';
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
	const [terminalSize, setTerminalSize] = useState(() => getTerminalSize(stdout));

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

	const activeDatabase = useMemo(
		() =>
			databaseState.databases.find(
				database => database.id === databaseState.activeDatabaseId,
			) ?? null,
		[databaseState],
	);

	const openListModal = () => {
		const activeIndex = databaseState.databases.findIndex(
			database => database.id === databaseState.activeDatabaseId,
		);
		setListIndex(activeIndex >= 0 ? activeIndex : 0);
		setMode('listModal');
		setDraft('');
		setSlashQuery('');
	};

	const closeSlashMenu = () => {
		setMode('chat');
		setSlashQuery('');
		setSlashIndex(0);
	};

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
			return;
		}

		openListModal();
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
		if (key.ctrl || key.meta) {
			return;
		}

		const cleanedInput = normalizeInput(input);

		if (mode === 'slashMenu') {
			if (key.escape) {
				closeSlashMenu();
				return;
			}

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
			if (key.escape) {
				setMode('chat');
				setFormField('name');
				return;
			}

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
			if (key.escape) {
				setMode('chat');
				return;
			}

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
			}

			setDraft('');
			return;
		}

		if (key.backspace || key.delete) {
			setDraft(previous => previous.slice(0, -1));
			return;
		}

		if (
			key.escape ||
			key.tab ||
			key.upArrow ||
			key.downArrow ||
			key.leftArrow ||
			key.rightArrow ||
			key.pageUp ||
			key.pageDown
		) {
			return;
		}

		if (cleanedInput.length > 0) {
			setDraft(previous => previous + cleanedInput);
		}
	});

	const modalRows = mode === 'chat' ? 0 : MODAL_HEIGHT;
	const messageViewportRows = Math.max(
		1,
		terminalSize.rows - INPUT_BAR_HEIGHT - STATUS_BAR_HEIGHT - modalRows - 2,
	);
	const visibleMessages = messages.slice(-messageViewportRows);
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
				backgroundColor="#000"
			>
				{visibleMessages.length === 0 ? (
					<Text dimColor>Digite / para abrir o slash menu.</Text>
				) : null}
				{visibleMessages.map((message, index) => (
					<Text key={`${index}-${message}`}>{message}</Text>
				))}
			</Box>

			{mode === 'slashMenu' ? (
				<Box width={terminalSize.columns} paddingX={1} paddingBottom={1} backgroundColor="#000">
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
										<Text color={isSelected ? 'cyan' : undefined}>
											{`${isSelected ? '›' : ' '} /${command.label}`}
										</Text>
										<Text dimColor>{command.description}</Text>
									</Box>
								);
							})
						)}
					</Box>
				</Box>
			) : null}

			{mode === 'addForm' ? (
				<Box width={terminalSize.columns} paddingX={1} paddingBottom={1} backgroundColor="#000">
					<Box
						flexDirection="column"
						borderStyle="round"
						borderColor="green"
						paddingX={1}
						width={Math.max(24, terminalSize.columns - 2)}
						height={MODAL_HEIGHT}
					>
						<Box justifyContent="space-between">
							<Text bold>Add database</Text>
							<Text dimColor>esc</Text>
						</Box>
						<Text color={formField === 'name' ? 'green' : undefined}>
							{`name: ${formField === 'name' ? '›' : ' '} ${formName.length > 0 ? formName : '...'}`}
						</Text>
						<Text color={formField === 'postgresUrl' ? 'green' : undefined}>
							{`postgresURL: ${formField === 'postgresUrl' ? '›' : ' '} ${formPostgresUrl.length > 0 ? formPostgresUrl : '...'}`}
						</Text>
						<Text dimColor>tab alterna campo • enter salva • esc cancela</Text>
						<Text dimColor>
							{isSavingDatabase ? 'Salvando database...' : 'URL aceita: postgres:// ou postgresql://'}
						</Text>
					</Box>
				</Box>
			) : null}

			{mode === 'listModal' ? (
				<Box width={terminalSize.columns} paddingX={1} paddingBottom={1} backgroundColor="#000">
					<Box
						flexDirection="column"
						borderStyle="round"
						borderColor="yellow"
						paddingX={1}
						width={Math.max(24, terminalSize.columns - 2)}
						height={MODAL_HEIGHT}
					>
						<Box justifyContent="space-between">
							<Text bold>Databases</Text>
							<Text dimColor>esc</Text>
						</Box>
						{listEntries.length === 0 ? (
							<Text dimColor>Nenhuma database cadastrada.</Text>
						) : (
							listEntries.map((database, index) => {
								const isSelected = index === listIndex;
								const isActive = database.id === databaseState.activeDatabaseId;
								return (
									<Box key={database.id} flexDirection="column">
										<Text color={isSelected ? 'yellow' : undefined}>
											{`${isSelected ? '›' : ' '} ${database.name}${isActive ? ' (active)' : ''}`}
										</Text>
										<Text dimColor>
											{`   ${truncateText(database.postgresUrl, listMaxUrlLength)}`}
										</Text>
									</Box>
								);
							})
						)}
						<Text dimColor>
							{isSettingActive
								&& 'Ativando database...'}
						</Text>
					</Box>
				</Box>
			) : null}


			<Box
				width={terminalSize.columns}
				height={INPUT_BAR_HEIGHT}
				padding={1}
				backgroundColor="#161616"
				flexDirection="column"
				justifyContent='space-between'
			>
				<Text>{inputLabel}</Text>
				<Text>
					<Text color="green">Database </Text>
					{dbIndicator}
				</Text>
			</Box>
		</Box>
	);
}
