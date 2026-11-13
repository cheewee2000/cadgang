import { expect, mock, test } from 'claude-code/testing'

type File = { subject: string; ids: string[]; noted: string[] }

test('a note is sent by itself once it carries text, and held while a turn runs', async ($, on) => {
  // Each hook here stands for the engine, or for CADgang answering over http.
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/Users/me' })
  let files: File[] = [{ subject: '/proj/a.step', ids: ['old'], noted: ['old'] }]
  const sent: string[] = []
  const toasts: string[] = []
  on('http.fetch', () => ({
    value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ files }) },
  }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  // Already open when the session started: announced, never sent without a press.
  await clock.advance(3000)
  expect(toasts.length).toBe(1)
  expect(sent.length).toBe(0)

  // An arrow is saved before its text: not yet.
  files = [{ subject: '/proj/a.step', ids: ['old', 'n1'], noted: ['old'] }]
  await clock.advance(3000)
  expect(sent.length).toBe(0)

  // Enter saves the text: sent, once.
  files = [{ subject: '/proj/a.step', ids: ['old', 'n1'], noted: ['old', 'n1'] }]
  await clock.advance(3000)
  await clock.advance(3000)
  expect(sent.length).toBe(1)
  expect(sent[0]).toMatch(/cadgang_screen/)

  // A note written while Claude works waits for the turn to end.
  await $.turn.start({ text: sent[0] ?? '', turnId: 't1' })
  files = [{ subject: '/proj/a.step', ids: ['old', 'n1', 'n2'], noted: ['old', 'n1', 'n2'] }]
  await clock.advance(3000)
  expect(sent.length).toBe(1)
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(3000)
  expect(sent.length).toBe(2)
})
