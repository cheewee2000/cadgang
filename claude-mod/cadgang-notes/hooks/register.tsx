import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Notes } from '../types'

const BASE = 'http://localhost:4477/api/view'
const POLL_MS = 3000 // how often a CADgang that cannot hold the request is asked (one older than `rev`)
const WAIT_S = 4 // how long CADgang holds a request for the next markup: a note is heard as it lands
const ASK =
  "Check my notes in CADgang: call cadgang_screen to see my markups, make each open markup's change in the model's source, re-export, check it in CADgang, and mark the ones you did with cadgang_markup_done."

const notes = atom({ plugin: 'cadgang-notes', key: 'notes' } as const, null)

type Markup = { id: string; done?: boolean }
type Markup_ = Markup & { text?: string }
// noted: the open ones that carry text. brief: the notes as Claude reads them, asked for at the moment of
// sending: on a live cell document, with the edges each note points at and the cell that makes that body, so
// Claude's first call is the edit. Absent from an older CADgang.
type File = { subject: string; ids: string[]; noted: string[]; brief?: string }

const inside = (file: string, dir: string) =>
  (file + '/').startsWith(dir.replace(/\/+$/, '') + '/')
const fileName = (subject: string) =>
  (subject.split('|')[0] ?? '').split('/').slice(-2).join('/')
const count = (n: number) => `${n} new ${n === 1 ? 'note' : 'notes'}`

// Module variables: a reload forgets them, so still-open notes are offered once more. Harmless.
const told = new Set<string>() // ids already handed to Claude
const seen = new Set<string>() // ids already announced with a toast
// Sent without a press: a markup that appeared while this session was running, once it carries
// text (an arrow is saved before its text, and Enter saves the text). Markups that were already
// open when the session started wait for the button or the next prompt: reopening a tab must not
// start a turn. While a turn runs, new ones are held and go together when it ends.
const auto = new Set<string>()
let isFirst = true
let isBusy = false
let noted: string[] = []
let rev: number | undefined // CADgang's markup counter: asked with it, the answer waits for a change

// The files with open markups that belong to this session. CADgang decides which (the files inside
// this session's folder, or any unclaimed file when this session last used cadgang's tools). A
// CADgang older than that route answers 404: then every file open in a window that is in this folder.
// how: 'wait' lets CADgang hold the answer until a markup changes; 'brief' asks for the briefs, at once.
async function openFiles($: EngineInterface, how?: 'wait' | 'brief'): Promise<File[]> {
  const [cwd, home] = await Promise.all([$.session.cwd(), $.env.get('HOME')])
  const more =
    how === 'brief' ? '&brief=1' : how === 'wait' && rev !== undefined ? `&since=${rev}&wait=${WAIT_S}` : ''
  const r = await $.http.fetch(`${BASE}/markup/open?dir=${encodeURIComponent(cwd)}${more}`)
  if (r.ok) {
    const answer = JSON.parse(r.text) as { files: File[]; rev?: number }
    if (how !== 'brief') rev = answer.rev
    return answer.files
  }
  if (r.status !== 404 || cwd === home) return []
  const tabs = await $.http.fetch(`${BASE}/tabs`)
  if (!tabs.ok) return []
  const subjects = (JSON.parse(tabs.text) as { tabs: { subject?: string }[] }).tabs
    .map(t => t.subject ?? '')
    .filter(s => s.split('|').some(f => f.startsWith('/') && inside(f, cwd)))
  const files: File[] = []
  for (const subject of subjects) {
    const m = await $.http.fetch(`${BASE}/markup?subject=${encodeURIComponent(subject)}`)
    if (!m.ok) continue
    const open = (JSON.parse(m.text) as { markups: Markup_[] }).markups.filter(x => !x.done)
    files.push({ subject, ids: open.map(x => x.id), noted: open.filter(x => x.text).map(x => x.id) })
  }
  return files
}

// The files with markups Claude has not been handed, those markups only.
async function untold($: EngineInterface, how?: 'wait' | 'brief'): Promise<File[]> {
  return (await openFiles($, how))
    .map(f => ({ ...f, ids: f.ids.filter(id => !told.has(id)) }))
    .filter(f => f.ids.length)
}

async function poll($: EngineInterface, how?: 'wait'): Promise<Notes | null> {
  let found: Notes | null = null
  try {
    const files = await untold($, how)
    if (files.length) {
      found = { subject: files.map(f => f.subject).join('|'), ids: files.flatMap(f => f.ids) }
    }
    noted = files.flatMap(f => f.noted)
    const fresh = found?.ids.filter(id => !seen.has(id)) ?? []
    fresh.forEach(id => seen.add(id))
    if (!isFirst) fresh.forEach(id => auto.add(id))
    isFirst = false
    if (found && fresh.length) {
      $.ui.toast(`CADgang: ${count(fresh.length)} on ${fileName(found.subject)}`)
    }
  } catch {
    rev = undefined // cadgang is not running: nothing to show, and nothing to hold a request
  }
  const before = await read($, notes)
  if (JSON.stringify(before) !== JSON.stringify(found)) await update($, notes, () => found)
  return found
}

// The files' untold notes, counted as told from here, and what Claude is to read of them.
async function hand($: EngineInterface): Promise<string[]> {
  const files = await untold($, 'brief').catch(() => [])
  files.forEach(f => f.ids.forEach(id => told.add(id)))
  if (files.length) await update($, notes, () => null)
  return files.map(
    f =>
      f.brief ??
      `CADgang: the user left ${count(f.ids.length)} (open markups) on ${f.subject} that you have not seen. Call cadgang_screen to see them, make each open markup's change in the model's source, re-export, check it in CADgang, and mark the ones you did with cadgang_markup_done.`,
  )
}

// Sent as the prompt itself: a mod's own prompt does not pass its own prompt.submit hook, so the brief
// cannot ride beside it unseen the way it rides beside a typed prompt (below).
async function send($: EngineInterface, n: Notes) {
  n.ids.forEach(id => auto.delete(id)) // sent once, whatever becomes of the prompt
  const briefs = await hand($)
  void $.prompt.submit({ text: briefs.join('\n\n') || ASK, asUser: true })
}

// One look: send what is ready without a press, then look again (at once when CADgang holds the request).
async function tick($: EngineInterface) {
  const found = await poll($, 'wait')
  if (found && !isBusy && noted.some(id => auto.has(id) && found.ids.includes(id))) await send($, found)
  $.clock.after(rev === undefined ? POLL_MS : 50, () => void tick($))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.clock.after(POLL_MS, () => void tick($))
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) isBusy = true
    return next(e)
  })
  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) isBusy = false // every ending: answered, interrupted, refused, failed
    return next(e)
  })

  // Any prompt you type carries the new notes along, so "check notes" is never needed. Claude reads the
  // brief beside it; you do not see it.
  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    const briefs = await hand($)
    return next(briefs.length ? { ...e, context: [...(e.context ?? []), ...briefs] } : e)
  }).catch(($, e, next) => next(e)) // a failure here must never swallow the prompt

  // Drawn under whatever another mod put in the band, never in its place.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const n = await read($, notes)
    if (e.props.hasSurvey || n === null) return below
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {below}
        <Box>
          <Text dimColor>
            CADgang: {count(n.ids.length)} on {fileName(n.subject)}{' '}
          </Text>
          <Button
            key="send"
            label="Send to Claude"
            onPress={() => void send($, n)}
          />
        </Box>
      </Box>
    )
  })
}
