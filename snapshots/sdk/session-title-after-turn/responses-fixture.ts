/** Loopback Responses fixture whose title cannot finish before the main SDK turn. */

import { createServer } from 'node:http'
import { expect } from 'vitest'

/**
 * Start the title provider's HTTP endpoint and own its connections until close.
 * @returns subprocess environment, turn barrier, assertions, and teardown.
 */
export async function startTitleResponsesFixture() {
  const requests: { path: string | undefined; body: unknown }[] = []
  const mainTurnEnded = Promise.withResolvers<void>()
  const requestReceived = Promise.withResolvers<void>()
  const title = 'Late durable session title'
  const events = [
    { type: 'response.created', response: { id: 'resp_title' } },
    { type: 'response.output_item.added', output_index: 0,
      item: { type: 'message', id: 'msg_title', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: title },
    { type: 'response.output_item.done', output_index: 0,
      item: { type: 'message', id: 'msg_title', role: 'assistant',
        content: [{ type: 'output_text', text: title, annotations: [] }] } },
    { type: 'response.completed', response: { id: 'resp_title', status: 'completed', output: [],
      usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } },
  ]
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const parsed: unknown = JSON.parse(body)
      requests.push({ path: request.url, body: parsed })
      requestReceived.resolve()
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.flushHeaders()
      void mainTurnEnded.promise.then(() => {
        if (!response.destroyed) response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
      })
    })
  })
  const close = async (): Promise<void> => {
    mainTurnEnded.resolve()
    await new Promise<void>((resolve, reject) => {
      server.close(error => error === undefined ? resolve() : reject(error))
      server.closeAllConnections()
    })
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('title fixture has no TCP address')
    return {
      environment: {
        DSH_SNAPSHOT_TITLE_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        DSH_SNAPSHOT_TITLE_API_KEY: 'snapshot-title-fixture',
      },
      onRootTurnEnd: () => { mainTurnEnded.resolve() },
      verify: async () => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            requestReceived.promise,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('No title Responses request received')), 10_000)
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
        expect(requests).toHaveLength(1)
        expect(requests[0]?.path).toBe('/v1/responses')
        expect(requests[0]?.body).toMatchObject({ model: 'title-model', stream: true, max_output_tokens: 32 })
        expect(requests[0]?.body).not.toHaveProperty('reasoning')
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
