// Part of Zebroo GmbH. See LICENSE file for full copyright and licensing details (www.zebroo.de/license).
// The token-optimizer chain for opencode.
//
// Claude Code runs the chain in a mod (plugin/), Codex in a Stop hook
// (codex_chain.py). opencode has plugins: this file, linked to
// ~/.config/opencode/plugin/token-optimizer.js by `token_optimizer.py install`.
// On every session.idle of a main session it checks the context size (tokens
// of the last answer) and, from the threshold on, runs:
//
//   compress prompt -> the session writes its state into NEXT.md
//   new session     -> fresh conversation (opencode's /new)
//   go prompt       -> the new conversation carries on with the work NEXT.md
//                      names under "Gerade dran:"
//
// opencode reads the skills from ~/.claude/skills itself. The Laya triage
// reads Claude/Codex transcripts only, so it does not run here.
//
// Like every hook: this must never break a session, every error is swallowed.

import { stat, readFile, access, appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const THRESHOLD = 180_000 // opencode compacts on its own near the end of the window
const STEP = 50_000 // after the chain (or a failed try) wait for this much growth
const STALE_MS = 30 * 60_000 // a chain stuck this long is dropped
const LAST_PROMPT_MAX = 1_500

export const COMPRESS = (k, lastPrompt) =>
  `Kontext ist voll (${k}): Führe jetzt den Skill compress aus (~/.claude/skills/compress/SKILL.md) — ` +
  "schreib Stand, offene Punkte, Begründungen und Freigaben in NEXT.md im Ticket-Ordner; woran du " +
  "gerade arbeitest, gehört in die Zeile „Gerade dran:“. Laya-Triage gibt es unter opencode nicht, " +
  "nicht starten. Danach nichts weiter." +
  (lastPrompt
    ? "\n\nLetzter Auftrag des Nutzers (wörtlich, ggf. gekürzt):\n\n> " +
      lastPrompt.slice(0, LAST_PROMPT_MAX).replace(/\n/g, "\n> ")
    : "")

export const GO =
  "Fortsetzung nach /clear (token-optimizer, opencode: neue Sitzung): Führe den Skill go aus " +
  "(~/.claude/skills/go/SKILL.md) — lies TASK.md und NEXT.md im Ticket-Ordner und mach beim Punkt " +
  "aus „Gerade dran:“ weiter, sonst Punkt 1. Wartet NEXT.md auf den Nutzer, nur dessen Frage stellen."

const exists = p => access(p).then(() => true, () => false)
const mtime = p => stat(p).then(s => s.mtimeMs, () => 0)

// NEXT.md belongs next to TASK.md (ticket folder), else into the directory.
export async function findNext(dir) {
  for (let d = dir; ; d = dirname(d)) {
    if (await exists(join(d, "TASK.md"))) return join(d, "NEXT.md")
    if (d === dirname(d) || d === homedir()) return join(dir, "NEXT.md")
  }
}

// Context after the last model call: everything the last answer was given
// plus what it wrote.
export function contextTokens(messages) {
  for (let i = (messages ?? []).length - 1; i >= 0; i--) {
    const t = messages[i]?.info?.role === "assistant" && messages[i].info.tokens
    if (!t) continue
    const n = (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
    if (n) return n
  }
  return 0
}

function threshold(env) {
  return Number(env.TOKEN_OPTIMIZER_OPENCODE_THRESHOLD) || THRESHOLD
}

async function log(msg) {
  try {
    const dir = join(homedir(), ".config", "opencode", "token-optimizer")
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, "log"), `${new Date().toISOString()} ${msg}\n`)
  } catch {}
}

// The chain for one opencode instance (one directory). Exported for the tests.
export function createChain({ client, directory, env = process.env, now = Date.now, write = log }) {
  const st = { phase: "idle", session: "", since: 0, base: 0, nextPath: "", nextMtime: 0, lastPrompt: "" }

  async function isMain(sessionID) {
    const r = await client.session.get({ path: { id: sessionID } })
    return !r?.data?.parentID
  }

  // A new session with the go prompt: through the TUI so it shows the new
  // session, else (opencode serve/run) as a plain session.
  async function resume() {
    try {
      await client.tui.executeCommand({ body: { command: "session_new" } })
      await client.tui.appendPrompt({ body: { text: GO } })
      await client.tui.submitPrompt()
      return "tui"
    } catch (err) {
      await write(`${directory}: TUI not reachable (${err}), new session through the API`)
      const s = await client.session.create({ body: { title: "Fortsetzung (token-optimizer)" } })
      await client.session.promptAsync({ path: { id: s.data.id }, body: { parts: [{ type: "text", text: GO }] } })
      return "api"
    }
  }

  async function onIdle(sessionID) {
    if (st.phase !== "idle" && now() - st.since > STALE_MS) {
      await write(`${directory}: chain stuck in ${st.phase}, dropped`)
      st.phase = "idle"
    }
    if (!(await isMain(sessionID))) return "subagent"

    if (st.phase === "compress") {
      if (sessionID !== st.session) return "other session"
      if ((await mtime(st.nextPath)) > st.nextMtime) {
        st.phase = "resume"
        st.since = now()
        st.base = 0
        const how = await resume()
        await write(`${directory}: NEXT.md written, new session + go (${how})`)
        return "resume"
      }
      st.phase = "idle"
      await write(`${directory}: NEXT.md not written in the compress turn, chain stopped`)
      return "stopped"
    }

    const r = await client.session.messages({ path: { id: sessionID } })
    const tokens = contextTokens(r?.data)
    if (st.phase === "resume") {
      // The first turn of the fresh conversation: its size is the new base.
      st.phase = "idle"
      st.base = tokens
      return "done"
    }

    const limit = threshold(env)
    if (tokens < limit || (st.base && tokens < st.base + STEP)) return "idle"
    st.phase = "compress"
    st.session = sessionID
    st.since = now()
    st.base = tokens
    st.nextPath = await findNext(directory)
    st.nextMtime = await mtime(st.nextPath)
    const k = `${Math.round(tokens / 1000)}k/${Math.round(limit / 1000)}k`
    await client.session.promptAsync({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text: COMPRESS(k, st.lastPrompt) }] },
    })
    await write(`${directory}: context ${tokens} >= ${limit}, compress (NEXT.md = ${st.nextPath})`)
    return "compress"
  }

  return {
    state: st,
    onIdle,
    // The last thing the person asked for: /compress keeps it as "Gerade dran".
    onMessage(parts) {
      if (st.phase !== "idle") return
      const text = (parts ?? []).filter(p => p?.type === "text" && !p.synthetic).map(p => p.text).join("\n").trim()
      if (text) st.lastPrompt = text
    },
  }
}

export default {
  id: "token-optimizer",
  server: async ({ client, directory, worktree }) => {
    const dir = directory || worktree
    if (!dir || !client) return {}
    const chain = createChain({ client, directory: dir })
    return {
      "chat.message": async (_input, output) => {
        try {
          chain.onMessage(output?.parts)
        } catch {}
      },
      event: async ({ event }) => {
        if (event?.type !== "session.idle") return
        try {
          await chain.onIdle(event.properties.sessionID)
        } catch (err) {
          await log(`${dir}: session.idle failed: ${err}`)
        }
      },
    }
  },
}
