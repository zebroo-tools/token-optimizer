// Part of Zebroo GmbH. See LICENSE file for full copyright and licensing details (www.zebroo.de/license).
import type { EngineInterface, Register } from 'claude-code'

// token-optimizer as a mod: once the context reaches the threshold, the
// session is handed over to a fresh one through /compress -> /clear -> /go
// (or /whats-next with resume off), run with $.command.run. /go picks up the
// work NEXT.md names under "Gerade dran:". The context size comes from the
// engine (session.measure). The engine prefixes every status, log line and
// command output with the plugin's name, so the texts here carry none.

const STEP = 50_000 // no new auto start until the context grew this much
const STALE_MS = 30 * 60_000 // a chain stuck this long is dropped
const RESTORE_MS = 1_500 // wait for the engine's own suggestion before ours
const TRIAGE_MS = 5 * 60_000 // Laya rates up to 60 outputs in batches
const COMPRESSED_MS = 30 * 60_000 // a /clear by hand this soon after /compress resumes
const CLEAR_SETTLE_MS = 500 // let a /clear by hand finish before /go is queued
const LAST_PROMPT_MAX = 1_500 // chars of the last prompt handed to /compress

// What /go gets after /clear; the go skill knows this opening.
const GO_ARGS = 'Fortsetzung nach /clear (token-optimizer): beim Punkt aus „Gerade dran:“ in NEXT.md ' +
  'weitermachen, sonst Punkt 1. Wartet NEXT.md auf den Nutzer, nur dessen Frage stellen.'

type Phase = 'idle' | 'compress' | 'clear' | 'resume'

const k = (n: number) => `${Math.round(n / 1000)}k`

// Module state survives /clear (same process), not a reload.
const chain = {
  phase: 'idle' as Phase,
  since: 0,
  turn: undefined as string | undefined, // the /compress or /whats-next turn
  nextPath: '',
  nextMtime: 0,
  args: '', // the triage handed to /compress, reused when it has to run again
  promptAt: 0, // last prompt the person typed while /compress was pending or running
  base: 0,
  tokens: 0,
  suggestion: undefined as string | undefined, // last dim suggestion while idle
  restore: undefined as string | undefined, // suggestion to put back after the chain
  isAfterClear: false,
  lastPrompt: '', // the last prompt the person typed while idle
  compressedAt: undefined as number | undefined, // when a /compress by hand last finished
}

function reset($: EngineInterface, why?: string) {
  chain.phase = 'idle'
  chain.turn = undefined
  chain.restore = undefined
  if (why) {
    $.ui.toast(why)
    $.ui.log(why)
  }
}

// NEXT.md belongs next to TASK.md (ticket folder), else into the cwd.
async function findNext($: EngineInterface) {
  const cwd = await $.session.cwd()
  for (let dir = cwd; dir.length > 1; dir = dir.slice(0, dir.lastIndexOf('/')) || '/') {
    if (await $.fs.exists(`${dir}/TASK.md`)) return `${dir}/NEXT.md`
  }
  return `${cwd}/NEXT.md`
}

async function mtime($: EngineInterface, path: string) {
  return $.fs.stat(path).then(s => s.mtimeMs, () => 0)
}

// NEXT.md as the note the conversation after /clear starts from ('' if none).
async function nextNote($: EngineInterface) {
  const path = await findNext($)
  const text = await $.fs.read(path).catch(() => '')
  return text.trim() ? `NEXT.md (${path}), written before /clear:\n\n${text}` : ''
}

// The triage table for /compress, or a line saying why there is none.
async function triage($: EngineInterface) {
  const script = `${await $.env.get('HOME')}/.claude/hooks/jev-context-triage.py`
  const session = await $.session.id()
  $.ui.status('Laya-Triage …')
  try {
    const r = await $.process.run(['uv', 'run', '-q', '--script', script, '--session', session], { timeoutMs: TRIAGE_MS })
    const out = r.stdout.trim()
    if (r.exitCode === 0 && out) {
      $.ui.log(`triage: ${out.split('\n').find(l => l.startsWith('Droppable')) ?? 'nothing to judge'}`)
      return `Laya-Triage (vom token-optimizer vor /compress ausgeführt, nicht erneut starten):\n\n${out}`
    }
    const why = (out || r.stderr.trim()).split('\n').pop() || `exit ${r.exitCode}`
    $.ui.log(`triage failed: ${why}`)
    return `Laya-Triage fehlgeschlagen (${why}) - nicht erneut starten, in der Abschlussmeldung erwähnen.`
  } catch (err) {
    $.ui.log(`triage failed: ${err}`)
    return `Laya-Triage fehlgeschlagen (${err}) - nicht erneut starten, in der Abschlussmeldung erwähnen.`
  }
}

async function startChain($: EngineInterface) {
  if (chain.phase !== 'idle') return
  chain.nextPath = await findNext($)
  chain.nextMtime = await mtime($, chain.nextPath)
  chain.phase = 'compress'
  chain.since = await $.clock.now()
  chain.turn = undefined
  chain.promptAt = 0
  chain.base = chain.tokens
  chain.restore = chain.suggestion
  $.ui.status('/compress …')
  $.ui.log(`start at ${k(chain.tokens)}, NEXT.md = ${chain.nextPath}` +
    (chain.restore ? `, suggestion kept: ${chain.restore}` : ''))
  chain.args = await triage($)
  if (chain.lastPrompt) {
    chain.args = 'Letzter Auftrag des Nutzers vor diesem /compress (wörtlich, ggf. gekürzt) — ' +
      'woran gerade gearbeitet wird, gehört in „Gerade dran:“:\n\n> ' +
      chain.lastPrompt.slice(0, LAST_PROMPT_MAX).replace(/\n/g, '\n> ') + '\n\n' + chain.args
  }
  $.ui.status('/compress …')
  void $.command.run({ command: 'compress', args: chain.args }).catch(err => reset($, `/compress failed: ${err}`))
}

// Prompts typed while /compress runs land in its turn, and the turn works on
// them: NEXT.md written before them misses that work. Run /compress again
// (same triage) before /clear rather than handing over a stale NEXT.md.
async function compressAgain($: EngineInterface, written: number) {
  chain.nextMtime = written
  chain.since = await $.clock.now()
  chain.turn = undefined
  chain.promptAt = 0
  $.ui.status('/compress (again) …')
  $.ui.log('prompts arrived during /compress, NEXT.md is older: running /compress again')
  const args = 'Nachtrag vom token-optimizer: Während des letzten /compress kamen neue Aufträge dazu. ' +
    'NEXT.md auf den aktuellen Stand bringen (knapp halten).\n\n' + chain.args
  void $.command.run({ command: 'compress', args }).catch(err => reset($, `/compress failed: ${err}`))
}

async function finishChain($: EngineInterface, isResume: boolean) {
  chain.phase = 'clear'
  $.ui.status('/clear …')
  try {
    await $.command.run({ command: 'clear' })
  } catch (err) {
    reset($, `/clear failed: ${err}`)
    return
  }
  await resume($, isResume)
}

// The conversation after /clear: NEXT.md as a note, then /go carries on with
// the work (or /whats-next only lists it).
async function resume($: EngineInterface, isResume: boolean) {
  const command = isResume ? 'go' : 'whats-next'
  try {
    if (chain.isAfterClear) {
      chain.isAfterClear = false
      const note = await nextNote($)
      if (note) {
        await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
        $.ui.log('NEXT.md handed to the new conversation')
      }
    }
    chain.phase = 'resume'
    chain.since = await $.clock.now()
    chain.turn = undefined
    chain.base = 0
    $.ui.status(`/${command} …`)
    await $.command.run(isResume ? { command, args: GO_ARGS } : { command })
  } catch (err) {
    reset($, `/${command} failed: ${err}`)
  }
}

// Fallback when the engine proposes nothing after /whats-next.
async function restoreSuggestion($: EngineInterface) {
  const text = chain.restore
  chain.restore = undefined
  if (text === undefined) return
  const { isShown } = await $.prompt.suggest({ text })
  $.ui.log(isShown ? `suggestion restored: ${text}` : 'suggestion not restored (box not empty)')
}

export const register: Register = (on, options) => {
  const auto = options.auto === true
  const threshold = Number(options.threshold ?? 250_000)
  const injectNext = options.injectNext === true
  const isResume = options.resume === true

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tokopt-chain',
      description: `Hand the session over now: /compress, /clear, ${isResume ? '/go' : '/whats-next'}`,
    })
    return next(e)
  })

  // A command.run hook may not run another command itself (it would wait on
  // its own turn): answer at once and start the chain from a timer.
  on('command.run', { command: 'tokopt-chain' }, async $ => {
    if (chain.phase !== 'idle') return { text: `chain already running (${chain.phase})` }
    $.clock.after(0, () => void startChain($))
    return { text: `starting /compress → /clear → ${isResume ? '/go' : '/whats-next'}` }
  })

  on('session.measure', async ($, e, next) => {
    if (e.context.tokens !== undefined) {
      chain.tokens = e.context.tokens
      if (chain.phase === 'idle') {
        $.ui.status(`ctx ${k(chain.tokens)}/${k(threshold)}${auto ? '' : ' (manual)'}`)
      }
    }
    // Only a command no turn picked up goes stale: a running turn ends on its own.
    if ((chain.phase === 'compress' || chain.phase === 'resume') && chain.turn === undefined &&
      (await $.clock.now()) - chain.since > STALE_MS) {
      reset($, `chain stuck in ${chain.phase}, dropped`)
    }
    if (auto && chain.phase === 'idle' && chain.tokens >= Math.max(threshold, chain.base + STEP)) {
      await startChain($)
    }
    return next(e)
  })

  // The first main-loop turn after queueing a command is that command's turn;
  // a subagent's turn must not claim it (its complete is never ours).
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && (chain.phase === 'compress' || chain.phase === 'resume') &&
      chain.turn === undefined) {
      chain.turn = e.turnId
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    // A /compress by hand ends on this line (see the compress skill): a /clear
    // by hand soon after it carries on with /go.
    if (chain.phase === 'idle' && /Jetzt \/clear eingeben/.test(e.answer)) chain.compressedAt = await $.clock.now()
    if (e.turnId !== chain.turn) return result

    if (chain.phase === 'compress') {
      const written = await mtime($, chain.nextPath)
      const isWritten = written > chain.nextMtime
      // The skill's closing line names /clear: that counts as done too.
      const isClaimed = /\/clear/.test(e.answer)
      if (!e.isAborted && chain.promptAt > 0 && written <= chain.promptAt) {
        await compressAgain($, written)
      } else if (e.isAborted || !(isWritten || isClaimed)) {
        reset($, 'NEXT.md was not written, chain stopped')
      } else {
        void finishChain($, isResume)
      }
    } else if (chain.phase === 'resume') {
      chain.phase = 'idle'
      chain.turn = undefined
      $.ui.status(`ctx ${k(chain.tokens)}/${k(threshold)}${auto ? '' : ' (manual)'}`)
      if (chain.restore !== undefined) $.clock.after(RESTORE_MS, () => void restoreSuggestion($))
    }
    return result
  })

  // Remember the engine's dim suggestion while idle; after the chain, put the
  // remembered one in place of the engine's next guess.
  on('prompt.suggest', async ($, e, next) => {
    if (e.origin.kind !== 'suggestion') return next(e)
    if (chain.phase === 'idle' && chain.restore !== undefined) {
      const text = chain.restore
      chain.restore = undefined
      $.ui.log(`suggestion restored: ${text}`)
      return next({ ...e, text })
    }
    const shown = await next(e)
    if (chain.phase === 'idle' && shown.isShown) chain.suggestion = e.text
    // The auto start fires on the turn's measurement, which may come before
    // the engine's guess for that same turn: take it while /compress waits.
    if (chain.phase === 'compress' && chain.turn === undefined) chain.restore = e.text
    return shown
  })

  // A prompt the person sent makes the old suggestion stale.
  // After a /clear by hand, the first prompt carries NEXT.md as context.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer') {
      chain.suggestion = undefined
      if (chain.phase === 'compress') chain.promptAt = await $.clock.now()
      if (chain.phase === 'idle') chain.lastPrompt = e.text
    }
    if (!chain.isAfterClear || chain.phase !== 'idle') return next(e)
    chain.isAfterClear = false
    const note = await nextNote($)
    if (!note) return next(e)
    $.ui.log('NEXT.md handed to the new conversation')
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  // After /clear the new conversation gets NEXT.md. prompt.context does not
  // fire again after /clear, so the chain appends a row and a /clear by hand
  // hands it over with the first prompt. A /clear by hand right after a
  // /compress by hand resumes like the chain does.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      if (injectNext) chain.isAfterClear = true
      chain.lastPrompt = ''
      const now = await $.clock.now()
      if (isResume && chain.phase === 'idle' && chain.compressedAt !== undefined && now - chain.compressedAt < COMPRESSED_MS) {
        chain.compressedAt = undefined
        $.ui.log('/clear after /compress: carrying on with /go')
        $.clock.after(CLEAR_SETTLE_MS, () => void resume($, true))
      }
    }
    return next(e)
  })
}
