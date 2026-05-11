import type { PluginAPI, PluginToolDefinition } from '@ampcode/plugin'

const CONFIG_API_KEY = 'linearApiKey'
const GRAPHQL_URL = 'https://api.linear.app/graphql'
const API_KEY_URL = 'https://linear.app/diodeinc/settings/account/security'

type Variables = Record<string, unknown>

class UserError extends Error {}

const json = (value: unknown) => JSON.stringify(value, null, 2)

function requiredString(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim()) throw new UserError(`${name} must be a non-empty string.`)
	return value.trim()
}

function optionalString(value: unknown, name: string): string | undefined {
	return value == null || value === '' ? undefined : requiredString(value, name)
}

function optionalBoolean(value: unknown, name: string, fallback = false): boolean {
	if (value == null || value === '') return fallback
	if (typeof value !== 'boolean') throw new UserError(`${name} must be a boolean.`)
	return value
}

function limit(value: unknown, fallback: number): number {
	if (value == null || value === '') return fallback
	if (typeof value !== 'number' || !Number.isFinite(value)) throw new UserError('limit must be a number.')
	return Math.max(1, Math.min(100, Math.floor(value)))
}

function defined(values: Variables): Variables {
	return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined))
}

async function apiKey(amp: PluginAPI): Promise<string> {
	const fromEnv = process.env.LINEAR_API_KEY?.trim()
	if (fromEnv) return fromEnv

	const fromConfig = (await amp.configuration.get())[CONFIG_API_KEY]
	if (typeof fromConfig === 'string' && fromConfig.trim()) return fromConfig.trim()

	throw new UserError('Linear is not configured. Set LINEAR_API_KEY or run “Linear: Configure API key”.')
}

async function graphql<T>(amp: PluginAPI, query: string, variables: Variables = {}): Promise<T> {
	const response = await fetch(GRAPHQL_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: await apiKey(amp),
		},
		body: JSON.stringify({ query, variables }),
	})

	const text = await response.text()
	let payload: { data?: T; errors?: { message?: string }[] }
	try {
		payload = JSON.parse(text)
	} catch {
		throw new UserError(`Linear returned non-JSON (${response.status}): ${text}`)
	}

	const errors = payload.errors?.map((error) => error.message).filter(Boolean).join('; ')
	if (!response.ok || errors) throw new UserError(errors || `Linear request failed (${response.status}).`)
	if (!payload.data) throw new UserError('Linear response did not include data.')
	return payload.data
}

function registerLinearTool(
	amp: PluginAPI,
	definition: Omit<PluginToolDefinition, 'execute'> & {
		execute(input: Record<string, unknown>): Promise<unknown>
	},
) {
	amp.registerTool({
		...definition,
		async execute(input) {
			try {
				return json(await definition.execute(input))
			} catch (error) {
				return `Linear error: ${error instanceof Error ? error.message : String(error)}`
			}
		},
	})
}

const issueFields = `
  id
  identifier
  number
  title
  description
  url
  priority
  priorityLabel
  estimate
  dueDate
  createdAt
  updatedAt
  completedAt
  canceledAt
  archivedAt
  team { id key name }
  state { id name type }
  assignee { id name displayName email }
  creator { id name displayName email }
  project { id name url }
  labels(first: 25) { nodes { id name color } }
`

const issueSummaryFields = `
  id
  identifier
  title
  url
  priority
  priorityLabel
  updatedAt
  team { id key name }
  state { id name type }
  assignee { id name displayName email }
  project { id name url }
`

export default function (amp: PluginAPI) {
	amp.logger.log('[linear] plugin initialized')

	amp.registerCommand(
		'linear-configure-api-key',
		{
			title: 'Configure API key',
			category: 'Linear',
			description: 'Store a Linear personal API key in global Amp plugin configuration.',
		},
		async (ctx) => {
			const key = await ctx.ui.input({
				title: 'Linear API key',
				helpText: `Paste a Linear personal API key from ${API_KEY_URL}. You can alternatively set LINEAR_API_KEY in your environment.`,
				submitButtonText: 'Save',
			})

			if (!key?.trim()) {
				await ctx.ui.notify('Linear API key was not changed.')
				return
			}

			await amp.configuration.update({ [CONFIG_API_KEY]: key.trim() }, 'global')
			await ctx.ui.notify('Linear API key saved. Run “plugins: reload” if tools do not see it immediately.')
		},
	)

	amp.registerCommand(
		'linear-clear-api-key',
		{
			title: 'Clear API key',
			category: 'Linear',
			description: 'Remove the stored Linear API key from global Amp plugin configuration.',
		},
		async (ctx) => {
			await amp.configuration.delete(CONFIG_API_KEY, 'global')
			await ctx.ui.notify('Stored Linear API key cleared. LINEAR_API_KEY, if set, will still be used.')
		},
	)

	amp.registerCommand(
		'linear-open-api-key-settings',
		{
			title: 'Open API key settings',
			category: 'Linear',
			description: 'Open Linear account security settings to create a personal API key.',
		},
		async (ctx) => ctx.system.open(API_KEY_URL),
	)

	registerLinearTool(amp, {
		name: 'linear_viewer',
		description: 'Return the current Linear user for the configured API key.',
		inputSchema: { type: 'object', properties: {} },
		execute: () => graphql(amp, `query { viewer { id name displayName email url admin active } }`),
	})

	registerLinearTool(amp, {
		name: 'linear_list_teams',
		description: 'List Linear teams visible to the configured API key. Use team IDs when creating issues.',
		inputSchema: {
			type: 'object',
			properties: { limit: { type: 'number', description: 'Maximum teams to return, default 50, max 100.' } },
		},
		execute: (input) => graphql(amp, `query ($first: Int!) { teams(first: $first) { nodes { id key name description private archivedAt } } }`, { first: limit(input.limit, 50) }),
	})

	registerLinearTool(amp, {
		name: 'linear_list_projects',
		description: 'List Linear projects visible to the configured API key.',
		inputSchema: {
			type: 'object',
			properties: {
				limit: { type: 'number', description: 'Maximum projects to return, default 25, max 100.' },
				includeArchived: { type: 'boolean', description: 'Whether to include archived projects. Default false.' },
			},
		},
		execute: (input) => graphql(amp, `
			query ($first: Int!, $includeArchived: Boolean) {
				projects(first: $first, includeArchived: $includeArchived) {
					nodes { id name description url state progress startDate targetDate archivedAt }
				}
			}
		`, { first: limit(input.limit, 25), includeArchived: optionalBoolean(input.includeArchived, 'includeArchived') }),
	})

	registerLinearTool(amp, {
		name: 'linear_search_issues',
		description: 'Search Linear issues by term or issue identifier. Returns matching issues with key metadata.',
		inputSchema: {
			type: 'object',
			properties: {
				term: { type: 'string', description: 'Search term, title words, or identifier such as ENG-123.' },
				teamId: { type: 'string', description: 'Optional Linear team ID.' },
				limit: { type: 'number', description: 'Maximum issues to return, default 10, max 100.' },
				includeArchived: { type: 'boolean', description: 'Whether to include archived issues. Default false.' },
			},
			required: ['term'],
		},
		execute: (input) => graphql(amp, `
			query ($term: String!, $teamId: String, $first: Int!, $includeArchived: Boolean) {
				searchIssues(term: $term, teamId: $teamId, first: $first, includeArchived: $includeArchived) {
					totalCount
					nodes { ${issueSummaryFields} createdAt archivedAt }
				}
			}
		`, {
			term: requiredString(input.term, 'term'),
			teamId: optionalString(input.teamId, 'teamId'),
			first: limit(input.limit, 10),
			includeArchived: optionalBoolean(input.includeArchived, 'includeArchived'),
		}),
	})

	registerLinearTool(amp, {
		name: 'linear_get_issue',
		description: 'Get a Linear issue by UUID or identifier, including metadata, labels, and recent comments.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'Linear issue UUID or identifier, such as ENG-123.' },
				commentLimit: { type: 'number', description: 'Maximum comments to include, default 10, max 100.' },
			},
			required: ['id'],
		},
		execute: (input) => graphql(amp, `
			query ($id: String!, $commentFirst: Int!) {
				issue(id: $id) {
					${issueFields}
					comments(first: $commentFirst) { nodes { id body createdAt updatedAt user { id name displayName email } } }
				}
			}
		`, { id: requiredString(input.id, 'id'), commentFirst: limit(input.commentLimit, 10) }),
	})

	registerLinearTool(amp, {
		name: 'linear_list_my_issues',
		description: 'List issues assigned to the authenticated Linear user.',
		inputSchema: {
			type: 'object',
			properties: {
				limit: { type: 'number', description: 'Maximum issues to return, default 25, max 100.' },
				includeArchived: { type: 'boolean', description: 'Whether to include archived issues. Default false.' },
			},
		},
		execute: (input) => graphql(amp, `
			query ($first: Int!, $includeArchived: Boolean) {
				viewer { assignedIssues(first: $first, includeArchived: $includeArchived) { nodes { ${issueSummaryFields} } } }
			}
		`, { first: limit(input.limit, 25), includeArchived: optionalBoolean(input.includeArchived, 'includeArchived') }),
	})

	registerLinearTool(amp, {
		name: 'linear_create_issue',
		description: 'Create a Linear issue. Requires a team ID; use linear_list_teams first if needed.',
		inputSchema: {
			type: 'object',
			properties: {
				teamId: { type: 'string', description: 'Linear team UUID.' },
				title: { type: 'string', description: 'Issue title.' },
				description: { type: 'string', description: 'Issue description in Markdown.' },
				assigneeId: { type: 'string', description: 'Optional Linear user UUID.' },
				projectId: { type: 'string', description: 'Optional Linear project UUID.' },
				stateId: { type: 'string', description: 'Optional workflow state UUID.' },
				priority: { type: 'number', description: '0 none, 1 urgent, 2 high, 3 medium, 4 low.' },
				labelIds: { type: 'array', items: { type: 'string' }, description: 'Optional label UUIDs.' },
			},
			required: ['teamId', 'title'],
		},
		execute: (input) => graphql(amp, `
			mutation ($input: IssueCreateInput!) {
				issueCreate(input: $input) { success issue { ${issueFields} } }
			}
		`, { input: issueInput(input, true) }),
	})

	registerLinearTool(amp, {
		name: 'linear_update_issue',
		description: 'Update a Linear issue by UUID or identifier. Provide only fields that should change.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'Linear issue UUID or identifier, such as ENG-123.' },
				title: { type: 'string', description: 'New issue title.' },
				description: { type: 'string', description: 'New issue description in Markdown.' },
				assigneeId: { type: 'string', description: 'Linear user UUID.' },
				projectId: { type: 'string', description: 'Linear project UUID.' },
				stateId: { type: 'string', description: 'Workflow state UUID.' },
				priority: { type: 'number', description: '0 none, 1 urgent, 2 high, 3 medium, 4 low.' },
				labelIds: { type: 'array', items: { type: 'string' }, description: 'Replacement label UUIDs.' },
			},
			required: ['id'],
		},
		execute: (input) => {
			const update = issueInput(input, false)
			if (!Object.keys(update).length) throw new UserError('At least one field to update must be provided.')
			return graphql(amp, `
				mutation ($id: String!, $input: IssueUpdateInput!) {
					issueUpdate(id: $id, input: $input) { success issue { ${issueFields} } }
				}
			`, { id: requiredString(input.id, 'id'), input: update })
		},
	})

	registerLinearTool(amp, {
		name: 'linear_create_comment',
		description: 'Create a comment on a Linear issue by UUID or identifier.',
		inputSchema: {
			type: 'object',
			properties: {
				issueId: { type: 'string', description: 'Linear issue UUID or identifier, such as ENG-123.' },
				body: { type: 'string', description: 'Comment body in Markdown.' },
			},
			required: ['issueId', 'body'],
		},
		execute: (input) => graphql(amp, `
			mutation ($input: CommentCreateInput!) {
				commentCreate(input: $input) {
					success
					comment { id body createdAt url user { id name displayName email } issue { id identifier title url } }
				}
			}
		`, { input: { issueId: requiredString(input.issueId, 'issueId'), body: requiredString(input.body, 'body') } }),
	})
}

function issueInput(input: Record<string, unknown>, creating: boolean): Variables {
	return defined({
		teamId: creating ? requiredString(input.teamId, 'teamId') : optionalString(input.teamId, 'teamId'),
		title: creating ? requiredString(input.title, 'title') : optionalString(input.title, 'title'),
		description: optionalString(input.description, 'description'),
		assigneeId: optionalString(input.assigneeId, 'assigneeId'),
		projectId: optionalString(input.projectId, 'projectId'),
		stateId: optionalString(input.stateId, 'stateId'),
		priority: input.priority,
		labelIds: input.labelIds,
	})
}
