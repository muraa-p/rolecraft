import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  apiProfileApply,
  apiProfileDelete,
  apiProfileDiff,
  apiProfileImport,
  apiProfileList,
  apiProfileSave,
  apiProfileShow,
} from './profile.js'

let tempDir
let originalHome
let originalCwd

const SERVER = { command: 'npx', args: ['-y', '@test/server'] }

function profileFile(name) {
  return join(tempDir, '.agents', 'profiles', `${name}.json`)
}

async function writeAgentsMcpConfig(mcpServers) {
  await mkdir(join(tempDir, '.agents'), { recursive: true })
  await writeFile(
    join(tempDir, '.agents', 'mcp.json'),
    JSON.stringify({ mcpServers }),
  )
}

async function importProfileObject(data) {
  const file = join(tempDir, `${data.name}.json`)
  await writeFile(file, JSON.stringify(data))
  return apiProfileImport(file)
}

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'rolecraft-api-profile-test-'))
  originalHome = process.env.HOME
  originalCwd = process.cwd()
  process.env.HOME = tempDir
  process.chdir(tempDir)
})

beforeEach(async () => {
  await rm(join(tempDir, '.agents'), { recursive: true, force: true })
})

after(async () => {
  process.chdir(originalCwd)
  process.env.HOME = originalHome
  await rm(tempDir, { recursive: true, force: true })
})

describe('api profile save', () => {
  it('captures the requested agent and writes the profile file', async () => {
    await writeAgentsMcpConfig({ srv: SERVER })

    const result = await apiProfileSave('work', { targets: ['agents'] })

    assert.equal(result.name, 'work')
    assert.equal(result.agents, 1)
    assert.deepEqual(result.profile.agents, {
      agents: { mcpServers: { srv: SERVER } },
    })
    const saved = JSON.parse(readFileSync(profileFile('work'), 'utf-8'))
    assert.equal(saved.name, 'work')
    assert.equal(saved.version, 1)
    assert.deepEqual(saved.agents, { agents: { mcpServers: { srv: SERVER } } })
  })

  it('dry-run returns captured data without writing a file', async () => {
    await writeAgentsMcpConfig({ srv: SERVER })

    const result = await apiProfileSave('dry', {
      targets: ['agents'],
      dryRun: true,
    })

    assert.deepEqual(result, {
      dryRun: true,
      name: 'dry',
      agents: { agents: { mcpServers: { srv: SERVER } } },
    })
    assert.equal(existsSync(profileFile('dry')), false)
  })

  it('throws when there is no agent configuration to save', async () => {
    await assert.rejects(
      () => apiProfileSave('empty', { targets: ['agents'] }),
      /No agent configurations found to save\./,
    )
  })
})

describe('api profile show/list/delete', () => {
  it('shows, lists and deletes a saved profile', async () => {
    await writeAgentsMcpConfig({ srv: SERVER })
    await apiProfileSave('work', { targets: ['agents'] })

    const shown = await apiProfileShow('work')
    assert.equal(shown.name, 'work')
    assert.deepEqual(shown.agents.agents.mcpServers, { srv: SERVER })

    const list = await apiProfileList()
    assert.equal(list.length, 1)
    assert.equal(list[0].name, 'work')
    assert.equal(list[0].agentCount, 1)
    assert.match(list[0].description, /^Saved on /)
    assert.equal(typeof list[0].createdAt, 'string')
    assert.equal(typeof list[0].updatedAt, 'string')

    assert.deepEqual(await apiProfileDelete('work', { dryRun: true }), {
      dryRun: true,
      name: 'work',
      exists: true,
    })
    assert.ok(existsSync(profileFile('work')))

    assert.deepEqual(await apiProfileDelete('work'), {
      name: 'work',
      deleted: true,
    })
    assert.equal(existsSync(profileFile('work')), false)
    assert.deepEqual(await apiProfileList(), [])
  })

  it('throws not-found errors for unknown profiles', async () => {
    await assert.rejects(
      () => apiProfileShow('missing'),
      /Profile "missing" not found\./,
    )
    await assert.rejects(
      () => apiProfileApply('missing'),
      /Profile "missing" not found\./,
    )
    await assert.rejects(
      () => apiProfileDiff('missing'),
      /Profile "missing" not found\./,
    )
    await assert.rejects(
      () => apiProfileDelete('missing'),
      /Profile "missing" not found\./,
    )
    assert.deepEqual(await apiProfileDelete('missing', { dryRun: true }), {
      dryRun: true,
      name: 'missing',
      exists: false,
    })
  })

  it('rejects invalid profile names', async () => {
    await assert.rejects(
      () => apiProfileShow('../escape'),
      /Invalid profile name/,
    )
  })
})

describe('api profile apply/diff', () => {
  it('dry-run apply filters agents by targets', async () => {
    await importProfileObject({
      name: 'multi',
      agents: {
        agents: { mcpServers: { srv: SERVER } },
        cursor: { mcpServers: { other: SERVER } },
      },
    })

    const result = await apiProfileApply('multi', {
      dryRun: true,
      targets: ['cursor'],
    })

    assert.deepEqual(result, {
      dryRun: true,
      name: 'multi',
      agents: { cursor: { mcpServers: { other: SERVER } } },
    })
    assert.equal(existsSync(join(tempDir, '.cursor', 'mcp.json')), false)
  })

  it('applies MCP servers from the profile to the agent config', async () => {
    await importProfileObject({
      name: 'apply-me',
      agents: { agents: { mcpServers: { srv: SERVER } } },
    })

    const result = await apiProfileApply('apply-me', { skipSkills: true })

    assert.equal(result.name, 'apply-me')
    assert.deepEqual(result.results.agents.mcpServers.applied, ['srv'])
    const config = JSON.parse(
      readFileSync(join(tempDir, '.agents', 'mcp.json'), 'utf-8'),
    )
    assert.deepEqual(config.mcpServers.srv, SERVER)
  })

  it('diff reports no changes right after save and mcpServers after a change', async () => {
    await writeAgentsMcpConfig({ srv: SERVER })
    await apiProfileSave('snap', { targets: ['agents'] })

    const clean = await apiProfileDiff('snap')
    assert.deepEqual(clean, {
      name: 'snap',
      diffs: { agents: { differences: [], hasDiff: false } },
      hasChanges: false,
    })

    await writeAgentsMcpConfig({
      srv: SERVER,
      extra: { command: 'node', args: ['x.js'] },
    })

    const changed = await apiProfileDiff('snap')
    assert.equal(changed.hasChanges, true)
    assert.deepEqual(changed.diffs.agents, {
      differences: ['mcpServers'],
      hasDiff: true,
    })
  })
})

describe('api profile import', () => {
  it('imports a local JSON file and names it after the file', async () => {
    const file = join(tempDir, 'team-setup.json')
    await writeFile(
      file,
      JSON.stringify({ agents: { agents: { mcpServers: { srv: SERVER } } } }),
    )

    const result = await apiProfileImport(file)

    assert.equal(result.name, 'team-setup')
    assert.equal(result.agents, 1)
    assert.ok(existsSync(profileFile('team-setup')))
    assert.deepEqual((await apiProfileShow('team-setup')).agents, {
      agents: { mcpServers: { srv: SERVER } },
    })
  })

  it('rejects invalid JSON', async () => {
    const file = join(tempDir, 'broken.json')
    await writeFile(file, '{ not json')
    await assert.rejects(
      () => apiProfileImport(file),
      /Invalid JSON in profile\./,
    )
  })

  it('rejects profiles that fail validation', async () => {
    const file = join(tempDir, 'bad.json')
    await writeFile(file, JSON.stringify({ name: 'bad', agents: [] }))
    await assert.rejects(
      () => apiProfileImport(file),
      /Invalid profile data:[\s\S]*"agents" must be a non-null object/,
    )
  })

  it('rejects URLs from hosts outside the allow list before fetching', async () => {
    await assert.rejects(
      () => apiProfileImport('https://example.com/profile.json'),
      /URL host "example\.com" is not allowed for profile imports/,
    )
  })
})

/**
 * Minimal fetch stub. Routes map a URL to a handler returning a
 * response-shaped object, and every call is recorded so tests can assert on
 * which URLs were actually requested.
 */
function stubFetch(routes) {
  const original = globalThis.fetch
  const calls = []

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    const handler = routes[url]
    if (!handler) throw new Error(`unexpected fetch to ${url}`)
    return handler()
  }

  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

function bodyResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => body,
  }
}

function redirectResponse(location) {
  return {
    ok: false,
    status: 302,
    headers: new Headers(location ? { location } : {}),
    text: async () => '',
  }
}

const PROFILE_BODY = JSON.stringify({
  name: 'redirected',
  agents: { agents: { mcpServers: { srv: SERVER } } },
})

describe('api profile import redirects', () => {
  let stub = null

  afterEach(() => {
    if (stub) {
      stub.restore()
      stub = null
    }
  })

  it('follows a redirect between allowed hosts', async () => {
    stub = stubFetch({
      'https://github.com/team/p.json': () =>
        redirectResponse('https://raw.githubusercontent.com/team/main/p.json'),
      'https://raw.githubusercontent.com/team/main/p.json': () =>
        bodyResponse(PROFILE_BODY),
    })

    const result = await apiProfileImport('https://github.com/team/p.json')

    assert.equal(result.name, 'redirected')
    assert.equal(result.agents, 1)
    assert.equal(stub.calls.length, 2)
    assert.equal(stub.calls[0].options.redirect, 'manual')
  })

  it('rejects a redirect to a host outside the allow list', async () => {
    stub = stubFetch({
      'https://github.com/team/p.json': () =>
        redirectResponse('https://evil.example.com/p.json'),
    })

    await assert.rejects(
      () => apiProfileImport('https://github.com/team/p.json'),
      /URL host "evil\.example\.com" is not allowed for profile imports/,
    )

    // The disallowed origin must never actually be requested.
    assert.deepEqual(
      stub.calls.map((c) => c.url),
      ['https://github.com/team/p.json'],
    )
  })

  it('resolves a relative redirect against the URL that produced it', async () => {
    stub = stubFetch({
      'https://raw.githubusercontent.com/team/main/old/p.json': () =>
        redirectResponse('/team/main/new/p.json'),
      'https://raw.githubusercontent.com/team/main/new/p.json': () =>
        bodyResponse(PROFILE_BODY),
    })

    const result = await apiProfileImport(
      'https://raw.githubusercontent.com/team/main/old/p.json',
    )

    assert.equal(result.name, 'redirected')
    assert.deepEqual(
      stub.calls.map((c) => c.url),
      [
        'https://raw.githubusercontent.com/team/main/old/p.json',
        'https://raw.githubusercontent.com/team/main/new/p.json',
      ],
    )
  })

  it('stops after too many redirects', async () => {
    stub = stubFetch({
      'https://github.com/loop': () =>
        redirectResponse('https://github.com/loop'),
    })

    await assert.rejects(
      () => apiProfileImport('https://github.com/loop'),
      /Too many redirects while importing profile/,
    )

    // Original request plus the three allowed hops, and no more.
    assert.equal(stub.calls.length, 4)
  })

  it('rejects a redirect with no Location header', async () => {
    stub = stubFetch({
      'https://github.com/team/p.json': () => redirectResponse(null),
    })

    await assert.rejects(
      () => apiProfileImport('https://github.com/team/p.json'),
      /did not include a Location header/,
    )
  })

  it('rejects a redirect to a malformed URL', async () => {
    stub = stubFetch({
      'https://github.com/team/p.json': () => redirectResponse('http://[::1'),
    })

    await assert.rejects(
      () => apiProfileImport('https://github.com/team/p.json'),
      /pointed at an invalid URL/,
    )
  })
})
