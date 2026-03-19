#!/usr/bin/env node
import process from 'node:process';
import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import App from './app';
import { toCliError } from './errors';
import { executeCommand } from './execute-command';
import {
	formatErrorJsonPayload,
	formatHumanErrorLines,
	formatHumanSuccessLines,
	formatSuccessJsonPayload,
} from './output.js';

const cli = meow(
	`
	Usage
	  $ meow <command>

	Commands
	  db add <name> <url>
	  db list
	  db use <name>
	  db info
	  db remove <name>
	  tables [schema]
	  rows <table> [--schema <schema>] [--limit <n>]

	Options
	  --json   Output structured JSON
	  -q       Quiet mode

	Examples
	  $ meow db add local postgresql://user:pass@localhost:5432/app
	  $ meow db use local
	  $ meow tables
	  $ meow rows users --limit 20
`,
	{
		importMeta: import.meta,
		flags: {
			json: {
				type: 'boolean',
				default: false,
			},
			quiet: {
				type: 'boolean',
				shortFlag: 'q',
				default: false,
			},
			schema: {
				type: 'string',
			},
			limit: {
				type: 'number',
			},
		},
	},
);

try {
	const result = await executeCommand(cli.input, {
		json: cli.flags.json,
		quiet: cli.flags.quiet,
		schema: cli.flags.schema,
		limit: cli.flags.limit,
	});

	if (cli.flags.json) {
		process.stdout.write(`${formatSuccessJsonPayload(result)}\n`);
	} else {
		render(
			React.createElement(App, {
				lines: formatHumanSuccessLines(result, cli.flags.quiet),
			}),
		);
	}
} catch (error: unknown) {
	const cliError = toCliError(error);
	process.exitCode = 1;

	if (cli.flags.json) {
		process.stdout.write(`${formatErrorJsonPayload(cliError)}\n`);
	} else {
		render(
			React.createElement(App, {
				lines: formatHumanErrorLines(cliError, cli.flags.quiet),
			}),
		);
	}
}
