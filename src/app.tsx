import {Box, Text} from 'ink';

type Props = {
	readonly lines: string[];
};

export default function App({lines}: Props) {
	return (
		<Box flexDirection="column">
			{lines.map(line => (
				<Text key={line}>{line}</Text>
			))}
		</Box>
	);
}
