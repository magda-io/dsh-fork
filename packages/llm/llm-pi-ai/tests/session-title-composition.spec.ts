/** First-prompt titles use the real Responses adapter and YAML reasoning policy. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import * as FirstPromptTitle from '@deepseek-ai/dsh-session-title-first-prompt-llm'
import { closeMockServers, mockServer, responsesTextEvents } from './mock-server.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  try {
    await context?.fiber.dispose()
  } finally {
    context = undefined
    try {
      if (root !== undefined) await rm(root, { recursive: true, force: true })
    } finally {
      root = undefined
      await closeMockServers()
    }
  }
})

async function loadComposition(baseURL: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-pi-title-composition-'))
  const credentialsPath = join(root, '.credentials.yaml')
  await writeFile(credentialsPath, 'version: 1\nrefs:\n  PI_TITLE_COMPOSITION_KEY: test-key\n', { mode: 0o600 })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(credentialsPath)}`,
    '    debounceMs: 10',
    "- name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    '      title-responses:',
    '        apiKeyEnv: PI_TITLE_COMPOSITION_KEY',
    '        api: openai-responses',
    `        baseURL: ${baseURL}`,
    '        models:',
    '          - id: title-model',
    '            reasoningEfforts:',
    '              off:',
    '              medium: medium',
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-session-title'",
    '  config:',
    '    fallbackMaxWords: 5',
    '    fallbackMaxBytes: 40',
    '    maxTitleBytes: 80',
    "- name: '@deepseek-ai/dsh-session-title-first-prompt-llm'",
    '  config:',
    '    targetWords: 5',
    '    targetCjkCharacters: 10',
    '    maxInputBytes: 1000',
    '    maxOutputTokens: 32',
    '    timeoutMs: 30000',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-session-title', SessionTitleService],
    ['@deepseek-ai/dsh-session-title-first-prompt-llm', FirstPromptTitle],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    import: (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return ctx
}

describe('first-prompt title through llm-pi-ai Loader composition', () => {
  it('accepts a generated title with YAML empty off and sends no Responses reasoning field', async () => {
    const server = await mockServer([{ events: responsesTextEvents }])
    const ctx = await loadComposition(`${server.url}/v1`)
    expect([...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)).toEqual([])

    const session = ctx.sessions.create(SessionId('responses-title'))
    session.append('turn/start', { turn: 1 })
    const message = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Investigate empty reasoning effort configuration' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('request/header', {
      header: { config: { provider: 'title-responses', model: 'title-model' } },
      reason: 'initial',
    })

    await expect.poll(() => ctx.sessionTitle.get(session)).toMatchObject({
      title: 'hello',
      messageSeqs: [message.seq],
      source: {
        kind: 'provider',
        provider: 'session-title-first-prompt-llm',
        model: { provider: 'title-responses', model: 'title-model' },
      },
    })
    expect(session.snapshotEvents().findLast(event => event.type === 'session/title')).toMatchObject({
      data: { title: 'hello', source: { kind: 'provider' }, messageSeqs: [message.seq] },
    })
    expect(server.paths).toEqual(['/v1/responses'])
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toMatchObject({ model: 'title-model', max_output_tokens: 32 })
    expect(server.requests[0]).not.toHaveProperty('reasoning')
  })
})
