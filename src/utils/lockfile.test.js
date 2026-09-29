import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import agents from '../agents.js'

let tempDir, lockModule, origHome

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'rolecraft-lock-test-'))
  origHome = process.env.HOME
  process.env.HOME = tempDir
  await mkdir(join(tempDir, '.agents'), { recursive: true })
  lockModule = await import('./lockfile.js')
})

after(async () => {
  await rm(tempDir, { recursive: true, force: true })
  process.env.HOME = origHome
})

describe('lockfile', () => {
  it('normalizeSlug converts path separators to hyphens', () => {
    assert.equal(
      lockModule.normalizeSlug('owner/group/skill'),
      'owner-group-skill',
    )
    assert.equal(
      lockModule.normalizeSlug('already-normalized'),
      'already-normalized',
    )
  })

  it('getGlobalLockPath returns path inside homedir', () => {
    assert.equal(
      lockModule.getGlobalLockPath(),
      join(tempDir, '.agents', '.skill-lock.json'),
    )
  })

  it('getAgentsDir returns path inside homedir', () => {
    assert.equal(lockModule.getAgentsDir(), join(tempDir, '.agents', 'skills'))
  })

  it('getProjectLockPath returns path relative to cwd', () => {
    assert.equal(
      lockModule.getProjectLockPath(process.cwd()),
      join(process.cwd(), '.agents', '.skill-lock.json'),
    )
  })

  // Verify getDirForAgent matches agents.js data for every agent flag
  describe('getDirForAgent', () => {
    for (const agent of agents) {
      it(`resolves ${agent.flag} → ${agent.label}`, () => {
        const expected = agent.getDir()
        assert.equal(lockModule.getDirForAgent(agent.flag), expected)
      })
    }

    it('falls back to ~/.agents/skills for unknown flag', () => {
      assert.equal(
        lockModule.getDirForAgent('nonexistent'),
        join(tempDir, '.agents', 'skills'),
      )
    })
  })

  it('readLock returns default when no file exists', async () => {
    const lock = await lockModule.readLock()
    assert.deepEqual(lock, {
      version: 3,
      skills: {},
      dismissed: {},
      lastSelectedAgents: [],
    })
  })

  it('readLock parses existing lock file', async () => {
    const data = {
      version: 3,
      skills: { test: { name: 'x' } },
      dismissed: {},
      lastSelectedAgents: [],
    }
    await writeFile(
      join(tempDir, '.agents', '.skill-lock.json'),
      JSON.stringify(data),
    )
    const lock = await lockModule.readLock()
    assert.deepEqual(lock, data)
  })

  it('writeLock writes lock file', async () => {
    const data = {
      version: 3,
      skills: { w: {} },
      dismissed: {},
      lastSelectedAgents: [],
    }
    await lockModule.writeLock(data)
    const written = JSON.parse(
      readFileSync(join(tempDir, '.agents', '.skill-lock.json'), 'utf-8'),
    )
    assert.deepEqual(written, data)
  })

  describe('writeLock atomicity', () => {
    let atomicDir, lockPath

    beforeEach(() => {
      atomicDir = mkdtempSync(join(tmpdir(), 'rolecraft-lock-atomic-'))
      lockPath = join(atomicDir, '.skill-lock.json')
    })

    afterEach(() => {
      rmSync(atomicDir, { recursive: true, force: true })
    })

    it('leaves no temp files behind on success', async () => {
      const data = {
        version: 3,
        skills: { 'owner/skill': { name: 'Skill' } },
        dismissed: {},
        lastSelectedAgents: [],
      }
      await lockModule.writeLock(data, lockPath)

      const written = JSON.parse(readFileSync(lockPath, 'utf-8'))
      assert.deepEqual(written, data)
      assert.deepEqual(readdirSync(atomicDir), ['.skill-lock.json'])
    })

    // Windows keeps the destination locked for as long as a reader holds it
    // open, so a concurrent reader can starve the rename indefinitely. The
    // torn-read guarantee this covers is a POSIX atomicity property.
    it('never exposes a partially written file to readers', {
      skip: process.platform === 'win32' ? 'POSIX-only guarantee' : false,
    }, async () => {
      // One entry per write, so each payload is large enough that an
      // unsynchronised write to the final path would be observable.
      const build = (n) => ({
        version: 3,
        skills: Object.fromEntries(
          Array.from({ length: 200 }, (_, i) => [
            `owner/skill-${n}-${i}`,
            { filler: 'x'.repeat(256) },
          ]),
        ),
        dismissed: {},
        lastSelectedAgents: [],
      })

      await lockModule.writeLock(build(0), lockPath)

      let reads = 0
      let sampling = true
      // An async reader that yields between reads, so it samples often but
      // still lets the writers' I/O and retry timers run.
      const reader = (async () => {
        while (sampling) {
          reads++
          // Must always be complete, parseable JSON — never a truncated prefix.
          JSON.parse(readFileSync(lockPath, 'utf-8'))
          await new Promise((resolve) => setImmediate(resolve))
        }
      })()

      try {
        await Promise.all(
          Array.from({ length: 8 }, (_, n) =>
            lockModule.writeLock(build(n + 1), lockPath),
          ),
        )
      } finally {
        sampling = false
        await reader
      }

      // The race is only meaningful if the reader actually ran during it.
      assert.ok(reads > 0, 'reader never sampled during the concurrent writes')
      JSON.parse(readFileSync(lockPath, 'utf-8'))
    })

    it('keeps the previous contents when a write fails', async () => {
      const good = {
        version: 3,
        skills: { 'owner/keep': { name: 'Keep' } },
        dismissed: {},
        lastSelectedAgents: [],
      }
      await lockModule.writeLock(good, lockPath)

      // A value that cannot be serialised throws before anything is renamed,
      // so the existing lockfile must survive intact.
      const cyclic = { version: 3, skills: {} }
      cyclic.skills.self = cyclic

      await assert.rejects(
        () => lockModule.writeLock(cyclic, lockPath),
        /circular|Converting circular structure/i,
      )

      assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf-8')), good)
      assert.deepEqual(readdirSync(atomicDir), ['.skill-lock.json'])
    })

    it('is safe to call concurrently from the same process', async () => {
      const writes = Array.from({ length: 24 }, (_, n) =>
        lockModule.writeLock(
          {
            version: 3,
            skills: { [`owner/skill-${n}`]: { n } },
            dismissed: {},
            lastSelectedAgents: [],
          },
          lockPath,
        ),
      )

      await Promise.all(writes)

      // Last write wins, and it is a complete, valid document.
      const final = JSON.parse(readFileSync(lockPath, 'utf-8'))
      assert.equal(final.version, 3)
      assert.equal(Object.keys(final.skills).length, 1)
      assert.deepEqual(readdirSync(atomicDir), ['.skill-lock.json'])
    })
  })

  it('addSkillToLock adds entry and sets installedAt', async () => {
    await lockModule.addSkillToLock('test/skill', { name: 'Test' })
    const lock = await lockModule.readLock()
    assert.equal(lock.skills['test/skill'].name, 'Test')
    assert.ok(lock.skills['test/skill'].installedAt)
  })

  it('addSkillToLock merges agents instead of overwriting', async () => {
    await lockModule.addSkillToLock('merge-skill', { agents: ['claude-code'] })
    await lockModule.addSkillToLock('merge-skill', {
      agents: ['cursor', 'warp'],
    })
    const lock = await lockModule.readLock()
    const agents = lock.skills['merge-skill'].agents
    assert.ok(agents.includes('claude-code'))
    assert.ok(agents.includes('cursor'))
    assert.ok(agents.includes('warp'))
    assert.equal(agents.length, 3)
  })

  it('removeSkillFromLock removes entry', async () => {
    await lockModule.addSkillToLock('to-remove', {})
    await lockModule.removeSkillFromLock('to-remove')
    const lock = await lockModule.readLock()
    assert.ok(!lock.skills['to-remove'])
  })

  it('computeContentHash produces deterministic hash', () => {
    const h1 = lockModule.computeContentHash({
      'SKILL.md': 'content',
      'helper.js': 'x',
    })
    const h2 = lockModule.computeContentHash({
      'helper.js': 'x',
      'SKILL.md': 'content',
    })
    assert.equal(h1, h2)
    assert.equal(h1.length, 64)
  })

  it('computeContentHash changes when content changes', () => {
    const h1 = lockModule.computeContentHash({
      'SKILL.md': 'same',
      'extra.js': 'a',
    })
    const h2 = lockModule.computeContentHash({
      'SKILL.md': 'same',
      'extra.js': 'b',
    })
    assert.notEqual(h1, h2)
  })

  it('computeContentHash returns different hash for different files', () => {
    const h1 = lockModule.computeContentHash({ 'SKILL.md': 'x' })
    const h2 = lockModule.computeContentHash({
      'SKILL.md': 'x',
      'extra.js': 'y',
    })
    assert.notEqual(h1, h2)
  })

  describe('history', () => {
    const skillSlug = 'test/my-skill'
    const baseEntry = {
      slug: skillSlug,
      contentSha: 'abc123',
      fileHashes: { 'SKILL.md': 'hash1' },
      installedAt: new Date().toISOString(),
      agents: ['cursor'],
      source: 'user/repo',
      sourceType: 'github',
    }

    it('adds history when contentSha changes', async () => {
      await lockModule.addSkillToLock(skillSlug, baseEntry)

      const updatedEntry = {
        ...baseEntry,
        contentSha: 'def456',
        fileHashes: { 'SKILL.md': 'hash2' },
      }
      await lockModule.addSkillToLock(skillSlug, updatedEntry)

      const history = await lockModule.getSkillHistory(skillSlug)
      assert.equal(history.length, 1)
      assert.equal(history[0].contentSha, 'abc123')
      assert.equal(history[0].fileHashes['SKILL.md'], 'hash1')
    })

    it('does not add history when contentSha is the same', async () => {
      const sameEntry = {
        ...baseEntry,
        contentSha: 'def456',
      }
      await lockModule.addSkillToLock(skillSlug, sameEntry)

      const history = await lockModule.getSkillHistory(skillSlug)
      assert.equal(history.length, 1) // Still 1, same contentSha
    })

    it('returns history newest-first', async () => {
      const v3Entry = {
        ...baseEntry,
        contentSha: 'ghi789',
      }
      await lockModule.addSkillToLock(skillSlug, v3Entry)

      const history = await lockModule.getSkillHistory(skillSlug)
      assert.equal(history.length, 2)
      assert.equal(history[0].contentSha, 'def456') // newest first
      assert.equal(history[1].contentSha, 'abc123')
    })

    it('popHistory restores previous version metadata', async () => {
      const prev = await lockModule.popHistory(skillSlug)
      assert.ok(prev)
      assert.equal(prev.contentSha, 'def456')

      // After pop, current entry should have the next oldest contentSha
      const _current = lockModule.readLock().then((l) => l.skills[skillSlug])
      // The current entry was the "ghi789" one, and after pop it should still be
      // but the history was popped
      const lock = await lockModule.readLock()
      assert.equal(lock.skills[skillSlug].contentSha, 'def456')
    })

    it('respects MAX_HISTORY limit', async () => {
      // Push 6 entries to exceed MAX_HISTORY (5)
      for (let i = 0; i < 6; i++) {
        await lockModule.addSkillToLock(skillSlug, {
          ...baseEntry,
          contentSha: `sha-${i}`,
        })
      }

      const history = await lockModule.getSkillHistory(skillSlug)
      assert.equal(history.length, 5) // MAX_HISTORY = 5
    })

    it('returns empty history for never-updated skill', async () => {
      const history = await lockModule.getSkillHistory('nonexistent-slug')
      assert.deepEqual(history, [])
    })

    it('popHistory returns null when no history', async () => {
      const result = await lockModule.popHistory('nonexistent-slug')
      assert.equal(result, null)
    })
  })
})
