// Part of Zebroo GmbH. See LICENSE file for full copyright and licensing details (www.zebroo.de/license).
// bun test opencode
import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createChain, contextTokens, findNext } from "./token-optimizer.js"

const answer = n => ({ info: { role: "assistant", tokens: { input: n, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } })

// A ticket folder with TASK.md and a code folder below it, and a client that
// records what the chain asks opencode to do.
function host({ tokens = 200_000, hasTui = true } = {}) {
  const ticket = mkdtempSync(join(tmpdir(), "tokopt-"))
  writeFileSync(join(ticket, "TASK.md"), "# Task")
  const code = join(ticket, "ZO-1-repo")
  mkdirSync(code)
  const h = { ticket, code, tokens, prompts: [], tui: [], created: 0, parents: {} }
  h.client = {
    session: {
      get: async ({ path }) => ({ data: { id: path.id, parentID: h.parents[path.id] } }),
      messages: async () => ({ data: [{ info: { role: "user" } }, answer(h.tokens)] }),
      promptAsync: async ({ path, body }) => void h.prompts.push([path.id, body.parts[0].text]),
      create: async () => ({ data: { id: `new${++h.created}` } }),
    },
    tui: {
      executeCommand: async ({ body }) => {
        if (!hasTui) throw new Error("no tui")
        h.tui.push(body.command)
      },
      appendPrompt: async ({ body }) => void h.tui.push(body.text),
      submitPrompt: async () => void h.tui.push("submit"),
    },
  }
  h.chain = createChain({ client: h.client, directory: code, env: {}, write: async () => {} })
  h.writeNext = () => {
    const p = join(ticket, "NEXT.md")
    writeFileSync(p, "# Next\n\nGerade dran: 1\n")
    utimesSync(p, new Date(), new Date(Date.now() + 5_000))
  }
  return h
}

test("NEXT.md goes next to TASK.md", async () => {
  const h = host()
  expect(await findNext(h.code)).toBe(join(h.ticket, "NEXT.md"))
})

test("context is the last answer's input plus output and cache", () => {
  const t = { input: 10, output: 5, reasoning: 1, cache: { read: 100, write: 4 } }
  expect(contextTokens([{ info: { role: "assistant", tokens: t } }, { info: { role: "user" } }])).toBe(120)
})

test("below the threshold nothing happens", async () => {
  const h = host({ tokens: 100_000 })
  expect(await h.chain.onIdle("s1")).toBe("idle")
  expect(h.prompts).toEqual([])
})

test("compress, then a new session in the TUI that carries on with go", async () => {
  const h = host()
  h.chain.onMessage([{ type: "text", text: "bau den Export" }])
  expect(await h.chain.onIdle("s1")).toBe("compress")
  expect(h.prompts[0][1]).toContain("Skill compress")
  expect(h.prompts[0][1]).toContain("> bau den Export")

  h.writeNext()
  expect(await h.chain.onIdle("s1")).toBe("resume")
  expect(h.tui[0]).toBe("session_new")
  expect(h.tui[1]).toContain("Skill go")
  expect(h.tui[2]).toBe("submit")

  expect(await h.chain.onIdle("s2")).toBe("done")
  expect(await h.chain.onIdle("s2")).toBe("idle")
})

test("without a TUI the go prompt goes to a new session through the API", async () => {
  const h = host({ hasTui: false })
  await h.chain.onIdle("s1")
  h.writeNext()
  expect(await h.chain.onIdle("s1")).toBe("resume")
  expect(h.prompts[1]).toEqual(["new1", expect.stringContaining("Skill go")])
})

test("the chain stops when NEXT.md was not written", async () => {
  const h = host()
  await h.chain.onIdle("s1")
  expect(await h.chain.onIdle("s1")).toBe("stopped")
  expect(h.tui).toEqual([])
  // no new try until the context grew by another 50k
  expect(await h.chain.onIdle("s1")).toBe("idle")
})

test("subagent sessions are left alone", async () => {
  const h = host()
  h.parents.sub = "s1"
  expect(await h.chain.onIdle("sub")).toBe("subagent")
  expect(h.prompts).toEqual([])
})
