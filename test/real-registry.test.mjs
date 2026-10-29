/**
 * Real-registry integration proof. Skips unless DONSETCH_BIN points at
 * a real donsetch binary AND the real host packages are resolvable.
 *
 * The gate: apply the plugin into an ACTUAL @deepseek-ai/dsh-tools
 * ToolRuntime on a real @deepseek-ai/cordis context, push the
 * registered parameter specs through the real validateArgs, and run a
 * live search through the complete registry pipeline. A fake harness
 * cannot catch contract drift here; this is the definitive contract
 * test of the plugin's harness-facing surface.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

const BIN = process.env.DONSETCH_BIN?.trim()
if (!BIN || !existsSync(BIN)) {
  test('real-registry proof', { skip: 'DONSETCH_BIN not set or missing' }, () => {})
} else {
  test('real-registry proof: register, validateArgs, live search through the real pipeline', async () => {
    let cordis = null
    let dshTools = null
    let dshWeb = null
    try {
      cordis = await import('@deepseek-ai/cordis')
      dshTools = await import('@deepseek-ai/dsh-tools')
      dshWeb = await import('@deepseek-ai/dsh-web')
    } catch {
      assert.fail('real-registry proof requires @deepseek-ai/cordis, @deepseek-ai/dsh-tools and @deepseek-ai/dsh-web (npm i them in the test env)')
      return
    }
    const { Context, Service } = cordis
    const { ToolRuntime, assertSupportedJsonSchema, validateJsonSchemaValue } = dshTools
    const { apply } = await import('../dist/index.js')
    const { assertWireSchema } = await import('./wire-schema.mjs')

    class StubSystemPrompt extends Service {
      constructor(ctx) {
        super(ctx, 'systemPrompt')
      }

      tools() {
        return () => {}
      }

      section() {
        return () => {}
      }

      getSectionOrder() {
        return 0
      }

      collapseSection() {
        return () => {}
      }
    }

    class CapturingRuntime extends ToolRuntime {
      constructor(ctx) {
        super(ctx)
        globalThis.__tools = this
      }
    }

    const cwdBefore = process.env.DONSETCH_DSH_AUTOUPDATE
    process.env.DONSETCH_DSH_AUTOUPDATE = 'off'
    const ctx = new Context()
    const keepAlive = []
    keepAlive.push(ctx.plugin(StubSystemPrompt))
    keepAlive.push(ctx.plugin(CapturingRuntime))
    // The web seam, configured the way the bundle patch configures it:
    // searchProvider pinned to the provider this plugin registers.
    keepAlive.push(ctx.plugin(dshWeb.WebRuntime, { searchProvider: 'donsetch' }))
    await Promise.all(keepAlive)
    Object.defineProperty(ctx, 'tools', { value: globalThis.__tools, configurable: true })
    const pluginHandle = apply(ctx, {
      toolPrefix: 'donsetch',
      fallbackToPath: false,
      callTimeoutMs: 180_000,
      bootTimeoutMs: 30_000,
    })

    const deadline = Date.now() + 60_000
    let got = []
    while (Date.now() < deadline) {
      got = ['web_fetch', 'web_search', 'web_crawl', 'status'].map((suffix) => {
        const name = `donsetch_${suffix}`
        return { name, def: ctx.tools.get(name) }
      }).filter((entry) => entry.def !== undefined)
      if (got.length === 4) break
      await new Promise((r) => setTimeout(r, 250))
    }
    try {
      assert.equal(got.length, 4, `expected the four donsetch tools, got: ${got.map((t) => t.name).join(', ') || '(none)'}`)

      const samples = {
        donsetch_web_fetch: { url: 'https://example.com', max_chars: 1000 },
        donsetch_web_search: { query: 'what is the rust programming language', max_results: 3, query_variants: ['rust lang'] },
        donsetch_web_crawl: { url: 'https://example.com', max_pages: 2 },
        donsetch_status: {},
      }

      // The contract that actually breaks in production: the registry stores
      // `parameters` untouched and schemaOf() copies it onto the model
      // request, so it must be a JSON Schema document inside the supported
      // subset. A bare property map is accepted here and rejected upstream
      // with HTTP 400 / DeepSeek 11129, killing the whole request.
      const projected = new Map(ctx.tools.schemas().map((schema) => [schema.name, schema]))
      for (const { name, def } of got) {
        assertWireSchema(def.parameters, name)
        assertSupportedJsonSchema(def.parameters)
        const onTheWire = projected.get(name)
        assert.ok(onTheWire, `${name} must appear in the model-facing schema projection`)
        assertWireSchema(onTheWire.parameters, `${name} (model-facing)`)
        // The model-facing copy must be a detached snapshot, not the same object.
        assert.notEqual(onTheWire.parameters, def.parameters, `${name} parameters must be detached for the model`)
      }

      // Argument validation against the registered parameters, using the same
      // raw-JSON-Schema validator the harness applies to schema documents.
      for (const { name, def } of got) {
        const violations = validateJsonSchemaValue(def.parameters, samples[name] ?? {}, 'args')
        assert.deepEqual(violations, [], `${name} args rejected: ${violations.join('; ')}`)
      }

      // The validator cannot gate the batch union: "[A, B]" IS a string,
      // so it passes here, reaches the binary, and comes back as
      // `url must be http(s)`, an error that never mentions arrays. That
      // is why the guard lives in execute(): the real pipeline must show
      // it rejecting, with the shape named and the fix stated.
      const fetchDef = got.find((entry) => entry.name === 'donsetch_web_fetch')?.def
      assert.ok(fetchDef, 'web_fetch must be registered for the url-shape proof')
      const stringified = { url: '[S88c0S5zH, SGsKUg6Lx]' }
      assert.deepEqual(
        validateJsonSchemaValue(fetchDef.parameters, stringified, 'args'),
        [],
        'the harness validator is expected to accept a stringified array; the guard owns it',
      )
      const guarded = await ctx.tools.execute({
        name: 'donsetch_web_fetch',
        arguments: stringified,
        signal: new AbortController().signal,
      })
      const guardedText = (guarded?.content ?? []).map((b) => (typeof b?.text === 'string' ? b.text : '')).join(' ')
      assert.equal(guarded?.isError, true, `a stringified array must not reach the binary: ${guardedText}`)
      assert.match(guardedText, /url looks like a stringified array/, `unexpected rejection: ${guardedText}`)
      assert.match(guardedText, /pass a real JSON array, or one http\(s\) URL\/handle per call/, `unexpected rejection: ${guardedText}`)

      const result = await ctx.tools.execute({
        name: 'donsetch_web_search',
        arguments: { query: 'what is the rust programming language' },
        signal: new AbortController().signal,
      })
      const text = (result?.content ?? []).map((b) => (typeof b?.text === 'string' ? b.text : '')).join(' ')
      assert.equal(result?.isError, false, `search errored: ${text}`)
      assert.ok(text.length > 40, `search returned empty through the real pipeline: ${JSON.stringify(result).slice(0, 400)}`)

      // The native web_search path (donsetch-dsh#4): ctx.web.search with the
      // seam configured to the donsetch provider must resolve through OUR
      // registered provider and return mapped sources, with no DeepSeek key
      // anywhere in the environment.
      const webSearch = await ctx.web.search({
        query: 'what is the rust programming language',
        maxResults: 4,
      })
      assert.ok(
        Array.isArray(webSearch.sources) && webSearch.sources.length > 0,
        `ctx.web.search resolved no sources through the donsetch provider: ${JSON.stringify(webSearch).slice(0, 300)}`,
      )
      assert.ok(
        webSearch.sources.every((s) => typeof s.url === 'string' && s.url.startsWith('http')),
        `sources must carry URLs: ${JSON.stringify(webSearch.sources).slice(0, 300)}`,
      )
    } finally {
      await pluginHandle.dispose()
      for (const fiber of keepAlive) {
        try {
          fiber.dispose()
        } catch {
          // Already disposed.
        }
      }
      if (cwdBefore === undefined) delete process.env.DONSETCH_DSH_AUTOUPDATE
      else process.env.DONSETCH_DSH_AUTOUPDATE = cwdBefore
    }
  })
}