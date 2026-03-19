import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';

const FALLBACK_COLUMNS = 80;
const FALLBACK_ROWS = 24;

const getTerminalSize = (stdout: NodeJS.WriteStream) => ({
	columns: stdout.columns && stdout.columns > 0 ? stdout.columns : FALLBACK_COLUMNS,
	rows: stdout.rows && stdout.rows > 0 ? stdout.rows : FALLBACK_ROWS,
});

export default function App() {
	const { stdout } = useStdout();
	const [messages, setMessages] = useState<string[]>([]);
	const [draft, setDraft] = useState('');
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

	useInput((input, key) => {
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
			key.ctrl ||
			key.meta ||
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

		if (input.length > 0) {
			const normalizedInput = input.replaceAll(/\r?\n/g, '');
			setDraft(previous => previous + normalizedInput);
		}
	});

	const messageViewportRows = Math.max(1, terminalSize.rows - 3);
	const visibleMessages = messages.slice(-messageViewportRows);

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
				backgroundColor={"#000"}
			>
				{visibleMessages.length === 0 ? (
					<Text dimColor>Aguardando mensagem...</Text>
				) : null}
				{visibleMessages.map((message, index) => (
					<Text key={`${index}-${message}`}>{message}</Text>
				))}
			</Box>
			<Box
				width={terminalSize.columns}
				height={1}
				paddingX={1}
				backgroundColor={"#101010"}>
				<Text>{`db: lms-local`}</Text>
			</Box>
			<Box
				width={terminalSize.columns}
				height={3}
				padding={1}
				backgroundColor={"#161616"}>
				<Text>{`› ${draft}`}</Text>
			</Box>
		</Box>
	);
}
