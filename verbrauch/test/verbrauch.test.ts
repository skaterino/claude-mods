import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const START = Date.parse('2026-10-12T15:00:00Z')

const usage = (tokens: number | undefined, fiveHour: number, sevenDay: number, usd = 4.2, fiveReset = '2026-10-12T16:30:00Z') => ({
  startedAt: Date.parse('2026-10-12T07:14:00Z'),
  context: { tokens, window: 1_000_000 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: fiveHour, resetsAt: fiveReset },
    { kind: 'seven_day', percentUsed: sevenDay, resetsAt: '2026-10-19T07:00:00Z' },
  ],
  cost: { usd },
})

type Row = { role: 'user' | 'assistant'; text: string; toolUses: never[] }

const lastOf = (list: (string | undefined)[]): string | undefined => list[list.length - 1]

// Steht unter dem Plugin für die Engine: beantwortet seine Aufrufe und sammelt, was es zeigt.
// Calls on $ are answered with { value } beneath the plugin, events with their own result.
const engine = (on: On, rows: Row[] = [], stored: Record<string, unknown> = {}) => {
  const seen = {
    usage: usage(120_000, 42, 63),
    status: [] as (string | undefined)[],
    toasts: [] as string[],
    fills: [] as string[],
    entered: [] as string[],
    panes: [] as string[],
    // Der Store des Plugins, damit der Test hineinsehen kann.
    store: new Map(Object.entries(stored)),
    // Dateien, die das Plugin liest und schreibt: die geteilte Limit-Ablage.
    files: new Map<string, string>(),
    commands: [] as string[],
    failCommand: false,
    // Das Modell, wie $.session.model() es nennt; undefined: der Aufruf scheitert.
    model: 'claude-opus-5-5' as string | undefined,
    // Die Session-ID; ein /clear gibt eine neue.
    id: 's1',
    // Solange gesetzt, wartet jedes Lesen aus dem Store darauf: so lässt sich ein Wettlauf nachstellen.
    gate: undefined as Promise<void> | undefined,
  }
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/mike' : undefined }))
  on('session.model', () => {
    if (seen.model === undefined) throw new Error('kein Modell')
    return { value: seen.model }
  })
  on('fs.read', ($, e) => {
    const text = seen.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    seen.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  // Der sessions-Mod unter dem Knopf: /pause selbst antwortet mit seinem Text, ein Fehler mit "kaputt".
  on('command.run', ($, e) => {
    seen.commands.push(`${e.command} ${e.args}`)
    if (seen.failCommand) throw new Error('kein solcher Befehl: /pause')
    return { text: 'Diese Session sichert ihren Stand in project_webshop_ui.md …' }
  })
  on('store.get', async ($, e) => {
    if (seen.gate) await seen.gate
    return { value: seen.store.get(e.key) }
  })
  on('store.set', ($, e) => {
    seen.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    seen.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...seen.store.keys()] }))
  on('session.usage', () => ({ value: seen.usage }))
  on('session.id', () => ({ value: seen.id }))
  on('session.messages', () => ({ value: rows }))
  on('command.register', () => ({ value: undefined }))
  on('ui.panes', () => ({
    value: seen.panes.map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('ui.open', ($, e) => {
    if (!seen.panes.includes(e.id)) seen.panes.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    seen.panes = seen.panes.filter(id => id !== e.id)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.fill', ($, e) => {
    seen.fills.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', ($, e) => {
    seen.entered.push(e.text)
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  return seen
}

const TURN = { answer: 'ok', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' } as const
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as const
const START_ARGS = { cwd: 'C:/test', surface: 'terminal', isInteractive: true } as const
const COMMAND = {
  command: 'verbrauch',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const
const PANE_PROPS = {
  title: 'Verbrauch',
  isFocused: false,
  bodyColumns: 60,
  placement: 'inline',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

test('Statuszeile zeigt Balken, Limits und Kontext, der Wächter meldet jede Schwelle einmal', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const seen = engine(on)

  await $.session.start(START_ARGS)
  expect(lastOf(seen.status)).toBe('5h ▰▰▰▱▱▱▱▱ 42% ↻18:30 │ 7T ▰▰▰▰▰▱▱▱ 63% ↻Mo 09:00 │ Ctx ▰▰▱▱▱▱▱▱ 120k')
  expect(seen.toasts).toEqual([])

  seen.usage = usage(312_000, 42, 63)
  await clock.advance(15_000)
  expect(lastOf(seen.status)).toMatch(/│ Ctx ▰▰▰▰▰▰▱▱ 312k ⚠$/)
  expect(seen.toasts.length).toBe(1)

  // Gleicher Stand: keine zweite Meldung.
  await clock.advance(15_000)
  expect(seen.toasts.length).toBe(1)

  seen.usage = usage(450_000, 96, 63)
  await clock.advance(15_000)
  expect(lastOf(seen.status)).toMatch(/^5h ▰▰▰▰▰▰▰▰ 96% .+ │ Ctx ▰▰▰▰▰▰▰▰ 450k ⚠ wechseln$/)
  // Kontext-Alarm und 5h-Limit, das 7T-Fenster bleibt still.
  expect(seen.toasts.length).toBe(3)
  expect(seen.toasts[2]).toMatch(/^5h-Limit bei 96 %/)
})

test('In claude -p (Skripte) bleibt alles still', async ($, on) => {
  mock.clock(on)
  const seen = engine(on)
  seen.usage = usage(300_000, 50, 50)

  await $.session.start({ cwd: 'C:/test', surface: null, isInteractive: false })
  expect(seen.status).toEqual([])
})

test('Cache in der Statuszeile: aktiv während des Turns, danach warm mit Restzeit, dann kalt', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const seen = engine(on)
  seen.usage = usage(200_000, 10, 20)
  await $.session.start(START_ARGS)

  await $.turn.start({ text: 'los', turnId: 't1' })
  expect(lastOf(seen.status)).toMatch(/│ ● aktiv$/)
  await clock.advance(5 * MIN)
  await $.turn.complete(TURN)
  expect(lastOf(seen.status)).toMatch(/│ ● warm 60′$/)

  await clock.advance(22 * MIN)
  expect(lastOf(seen.status)).toMatch(/│ ● warm 38′$/)
  await clock.advance(40 * MIN)
  expect(lastOf(seen.status)).toMatch(/│ ❄ kalt 62′$/)
})

test('Cache-Sperre hält nach über einer Stunde Pause einmal an, das zweite Enter geht durch', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const seen = engine(on, [
    { role: 'user', text: '<local-command-caveat>Caveat</local-command-caveat>', toolUses: [] },
    { role: 'user', text: 'mods pickup', toolUses: [] },
  ])
  seen.usage = usage(446_000, 10, 20)
  await $.session.start(START_ARGS)
  await $.turn.complete(TURN)

  // Nach einer halben Stunde ist der Cache noch warm.
  await clock.advance(30 * MIN)
  expect(await $.prompt.submit(typed('weiter'))).toEqual({ text: 'weiter' })
  await $.turn.complete(TURN)

  // 61 Minuten später: Statuszeile zeigt kalt, der Prompt wird angehalten und kommt zurück ins Feld.
  await clock.advance(61 * MIN)
  expect(lastOf(seen.status)).toMatch(/Ctx ▰▰▰▰▰▰▰▰ 446k ⚠ wechseln │ ❄ kalt 61′$/)
  const held = await $.prompt.submit(typed('ja'))
  expect(held.drop).toMatch(/^Cache abgelaufen, letzte Antwort vor 61 Min\.: Dieser Prompt schreibt 446k Kontext neu/)
  expect(held.drop).toMatch(/Enter sendet ihn trotzdem\. Günstiger: Ctrl\+C, \/clear und „mods pickup“\.$/)
  await clock.advance(200)
  expect(seen.fills).toEqual(['ja'])

  // Zweites Enter: bewusst gesendet.
  expect(await $.prompt.submit(typed('ja'))).toEqual({ text: 'ja' })
  expect(seen.entered).toEqual(['weiter', 'ja'])

  // Nach dem nächsten Turn ist der Cache wieder warm.
  await $.turn.complete(TURN)
  await clock.advance(15_000)
  expect(lastOf(seen.status)).toMatch(/446k ⚠ wechseln │ ● warm 60′$/)
})

test('Cache-Sperre nennt den Faktor des laufenden Modells', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const seen = engine(on)
  seen.usage = usage(446_000, 10, 20)
  await $.session.start(START_ARGS)

  const cases = [
    ['claude-opus-5-5', 40],
    ['claude-opus-5-5[1m]', 40],
    // Sonnet 5.5 liest zu $0.20 bei $2 Input: 0,1×, also der übliche Faktor.
    ['claude-sonnet-5-5', 20],
    ['claude-fable-5-1', 80],
    ['claude-mythos-5-1', 80],
    // Die Vorgänger lesen zum üblichen Preis.
    ['claude-fable-5', 20],
    ['claude-mythos-5', 20],
    ['claude-opus-5', 20],
    ['claude-sonnet-5', 20],
    ['claude-haiku-5-5', 20],
    ['claude-opus-4-8', 20],
    // Ohne Modellnamen: der übliche Faktor, die Sperre greift trotzdem.
    [undefined, 20],
  ] as const
  for (const [model, factor] of cases) {
    seen.model = model
    await $.turn.complete(TURN)
    await clock.advance(61 * MIN)
    const held = await $.prompt.submit(typed('weiter'))
    expect(held.drop).toContain(`446k Kontext neu, etwa ${factor}-mal so teuer wie das Lesen aus dem warmen Cache.`)
  }
  expect(seen.entered).toEqual([])
})

test('Keine Sperre bei kleinem Kontext, Benachrichtigungen und Prompts mit Bild', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const seen = engine(on)
  await $.session.start(START_ARGS)
  await $.turn.complete(TURN)
  await clock.advance(2 * HOUR)

  // 120k: der Neuschreib ist billig, kein Anhalten.
  expect(await $.prompt.submit(typed('a'))).toEqual({ text: 'a' })

  seen.usage = usage(446_000, 10, 20)
  // Eine Hintergrund-Benachrichtigung hat Mike nicht abgeschickt.
  const note = { text: 'task done', wait: false, origin: { kind: 'task-notification' } } as const
  expect(await $.prompt.submit(note)).toEqual({ text: 'task done' })

  // Mit Bild: nur melden, denn das Bild käme nicht zurück ins Feld.
  const shot = { ...typed('schau'), attachments: [{ type: 'image', mediaType: 'image/png' }] } as const
  expect(await $.prompt.submit(shot)).toEqual({ text: 'schau' })
  expect(lastOf(seen.toasts)).toMatch(/^Cache abgelaufen, letzte Antwort vor 2 h/)

  // Ohne Bild und ohne Pickup-Phrase in der Session: anhalten, Hinweis auf die Liste.
  const held = await $.prompt.submit(typed('und jetzt'))
  expect(held.drop).toMatch(/die Pickup-Phrase \(Liste: \/pickups\)\.$/)
  expect(seen.entered).toEqual(['a', 'task done', 'schau'])
})

test('Nach --resume zählt das Turn-Ende aus dem Store, alte Sessions fallen heraus', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const seen = engine(on, [], { 'turn:s1': START - 3 * DAY, 'turn:alt': START - 40 * DAY })
  seen.usage = usage(300_000, 10, 20)

  await $.session.start(START_ARGS)
  expect(lastOf(seen.status)).toMatch(/Ctx ▰▰▰▰▰▰▱▱ 300k ⚠ │ ❄ kalt 3T$/)
  expect([...seen.store.keys()]).toEqual(['turn:s1'])
  const held = await $.prompt.submit(typed('weiter'))
  expect(held.drop).toMatch(/^Cache abgelaufen, letzte Antwort vor 3 Tagen:/)
  await clock.advance(200)
  expect(seen.fills).toEqual(['weiter'])
})

test('/verbrauch öffnet und schliesst das Pane', async ($, on) => {
  mock.clock(on, { now: START })
  const seen = engine(on)
  await $.session.start(START_ARGS)

  expect((await $.command.run(COMMAND)).text).toMatch(/^Verbrauch offen/)
  expect(seen.panes).toEqual(['verbrauch'])
  expect((await $.command.run(COMMAND)).text).toBe('Verbrauch geschlossen.')
  expect(seen.panes).toEqual([])
})

test('Pane zeigt Balken, Prognose, Kontext und Cache auf jeder Oberfläche', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const seen = engine(on)
  await $.session.start(START_ARGS)
  await $.turn.complete(TURN)
  // 15:22Z: vom 5-h-Fenster (11:30–16:30Z) sind 232 Min. vorbei, von den 7 Tagen erst 8 h.
  await clock.advance(22 * MIN)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'verbrauch', surface, component: 'Pane', requestId: 'verbrauch', props: PANE_PROPS })
    const shown = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    expect(shown).toMatch(/5 Stunden/)
    expect(shown).toMatch(/42 %/)
    expect(shown).toMatch(/Reset 18:30, in 1h08/)
    // 42 % nach 232 von 300 Min. → ~54 % beim Reset.
    expect(shown).toMatch(/Tempo → ~54 % beim Reset ✓/)
    expect(shown).toMatch(/Reset Mo 09:00, in 6T 15h/)
    expect(shown).toMatch(/für eine Prognose noch zu früh/)
    expect(shown).toMatch(/120k/)
    expect(shown).toMatch(/Warnung ab 250k · wechseln ab 400k/)
    expect(shown).toMatch(/● warm, läuft in 38 Min\. ab/)
    expect(shown).toMatch(/seit 09:14 · API-Gegenwert \$4\.20/)
    // Der Balken ist in Farbzonen geteilt: gefüllt grün, leer gedämpft bis rot.
    const bars = await ui.findAll({ type: 'Text', text: /^[█░]+$/ })
    expect(bars.some(b => b.props.color === 'success' && !b.props.dimColor)).toBe(true)
    expect(bars.some(b => b.props.color === 'error' && b.props.dimColor)).toBe(true)
    await ui.unmount()
  }

  // Bei 90 % nach 232 Min. reicht es nicht bis zum Reset.
  seen.usage = usage(420_000, 90, 63)
  await clock.advance(15_000)
  const ui = await $.ui.mount({ plugin: 'verbrauch', surface: 'terminal', component: 'Pane', requestId: 'verbrauch', props: PANE_PROPS })
  const shown = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(shown).toMatch(/Tempo → Limit um 17:4\d, vor dem Reset ✖/)
  expect(shown).toMatch(/über 400k: Pickup sichern und neu starten/)
  await ui.unmount()
})

const SHARED = '/home/mike/.claude/mod-daten/verbrauch/limits.json'
type Shared = { kind: string; percent: number; resetsAt?: string; at?: number; session?: string }
const sharedOf = (seen: { files: Map<string, string> }) =>
  (JSON.parse(seen.files.get(SHARED) ?? '{"limits":[]}') as { limits: Shared[] }).limits
const putShared = (seen: { files: Map<string, string> }, limits: unknown[]) =>
  seen.files.set(SHARED, JSON.stringify({ limits }))
// Was die Engine nach einer Antwort meldet; die Zahlen liest das Plugin über usage().
const measure = (changed: ('context' | 'rateLimits' | 'cost')[] = ['rateLimits', 'cost']) => ({
  context: { tokens: 120_000, window: 1_000_000 },
  rateLimits: [],
  changed,
})
const FIVE = '2026-10-12T16:30:00Z'
const SEVEN = '2026-10-19T07:00:00Z'
const paneText = async ($: Parameters<Parameters<typeof test>[1]>[0], surface: 'terminal' | 'desktop' = 'terminal') => {
  const ui = await $.ui.mount({ plugin: 'verbrauch', surface, component: 'Pane', requestId: 'verbrauch', props: PANE_PROPS })
  const shown = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  await ui.unmount()
  return shown
}

test('Nach einer API-Antwort landet die Messung mit Zeit und Session in der Ablage, die jüngste gilt', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const seen = engine(on)
  await $.session.start(START_ARGS)
  // Was beim Start schon da ist, kann alt sein: nichts ablegen.
  await clock.advance(15_000)
  expect(seen.files.has(SHARED)).toBe(false)

  seen.usage = usage(130_000, 44, 64, 4.5)
  await $.session.measure(measure())
  const t1 = START + 15_000
  expect(sharedOf(seen)).toEqual([
    { kind: 'five_hour', percent: 44, resetsAt: FIVE, at: t1, session: 's1' },
    { kind: 'seven_day', percent: 64, resetsAt: SEVEN, at: t1, session: 's1' },
  ])

  // Eine andere Session misst danach: ihr Stand gilt, die ruhende Session überschreibt ihn nicht.
  putShared(seen, [
    { kind: 'five_hour', percent: 55, resetsAt: FIVE, at: t1 + MIN, session: 's2' },
    { kind: 'seven_day', percent: 65, resetsAt: SEVEN, at: t1 + MIN, session: 's2' },
  ])
  await clock.advance(2 * MIN)
  expect(sharedOf(seen)[0]).toMatchObject({ percent: 55, session: 's2' })
  expect(lastOf(seen.status)).toMatch(/^5h ▰▰▰▰▱▱▱▱ 55% ↻18:30 │ 7T ▰▰▰▰▰▱▱▱ 65% ↻Mo 09:00 │/)

  // Neue Antwort hier, jetzt mit neuem 5-h-Fenster: die jüngste Messung gilt, auch mit weniger Prozent.
  seen.usage = usage(140_000, 3, 66, 4.8, '2026-10-12T21:30:00Z')
  await clock.advance(15_000)
  expect(sharedOf(seen)[0]).toMatchObject({ percent: 3, resetsAt: '2026-10-12T21:30:00Z', session: 's1' })
  expect(lastOf(seen.status)).toMatch(/^5h ▱▱▱▱▱▱▱▱ 3% ↻23:30 │ 7T ▰▰▰▰▰▱▱▱ 66% ↻Mo 09:00 │/)
})

test('Eine ruhende Session zeigt nach spätestens 15 s, was eine andere gemessen hat, später mit Alter', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const seen = engine(on)
  await $.session.start(START_ARGS)
  expect(lastOf(seen.status)).toMatch(/^5h ▰▰▰▱▱▱▱▱ 42% ↻18:30 │ 7T ▰▰▰▰▰▱▱▱ 63% ↻Mo 09:00 │ Ctx/)

  putShared(seen, [
    { kind: 'five_hour', percent: 71, resetsAt: FIVE, at: START + 10_000, session: 's2' },
    { kind: 'seven_day', percent: 66, resetsAt: SEVEN, at: START + 10_000, session: 's2' },
  ])
  await clock.advance(15_000)
  expect(lastOf(seen.status)).toMatch(/^5h ▰▰▰▰▰▰▱▱ 71% ↻18:30 │ 7T ▰▰▰▰▰▱▱▱ 66% ↻Mo 09:00 │ Ctx/)
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await paneText($, surface)).toMatch(/Stand aus einer anderen Session/)
  }

  // Nach 5 Minuten ohne neue Messung steht das Alter einmal hinter den Limits.
  await clock.advance(5 * MIN)
  expect(lastOf(seen.status)).toMatch(/^5h ▰▰▰▰▰▰▱▱ 71% ↻18:30 │ 7T ▰▰▰▰▰▱▱▱ 66% ↻Mo 09:00 \(vor 5′\) │ Ctx/)
  for (const surface of ['terminal', 'desktop'] as const) {
    const shown = await paneText($, surface)
    expect(shown).toMatch(/71 %/)
    expect(shown).toMatch(/Stand vor 5 Min\., aus einer anderen Session/)
  }
})

test('Ohne neue Antwort bleibt die eigene Messung alt, auch wenn die Engine sonst etwas misst', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const seen = engine(on)
  await $.session.start(START_ARGS)
  seen.usage = usage(130_000, 44, 64, 4.5)
  await $.session.measure(measure())
  expect(lastOf(seen.status)).not.toMatch(/\(vor/)

  // Eine Stunde später ändert sich nur der Kontext (etwa /compact ohne Antwort): kein frischer Stempel.
  await clock.advance(HOUR)
  seen.usage = { ...usage(90_000, 44, 64, 4.5) }
  await $.session.measure(measure(['context']))
  expect(sharedOf(seen)[0]).toMatchObject({ at: START, session: 's1' })
  expect(lastOf(seen.status)).toMatch(/64% ↻Mo 09:00 \(vor 60′\) │ Ctx/)
  const shown = await paneText($)
  expect(shown).toMatch(/Stand vor 60 Min\./)
  expect(shown).not.toMatch(/anderen Session/)
})

test('Während eines langen Turns zählt jede Antwort als frisch, auch ohne Messung der Engine', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const seen = engine(on)
  await $.session.start(START_ARGS)
  await $.turn.start({ text: 'los', turnId: 't1' })
  for (let i = 1; i <= 4; i++) {
    seen.usage = usage(130_000, 44, 64, 4.2 + i / 10)
    await clock.advance(5 * MIN)
  }
  // Gestempelt beim ersten Takt nach der letzten Antwort.
  expect(sharedOf(seen)[1]).toMatchObject({ percent: 64, at: START + 15 * MIN + 15_000 })
  expect(lastOf(seen.status)).not.toMatch(/\(vor/)
})

test('Ein abgelaufenes Fenster zeigt 0 % statt des alten Stands', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-12T17:00:00Z') })
  const seen = engine(on)
  seen.usage = { ...usage(undefined, 0, 0), rateLimits: [] }
  putShared(seen, [
    { kind: 'five_hour', percent: 90, resetsAt: FIVE, at: START, session: 's2' },
    { kind: 'seven_day', percent: 63, resetsAt: SEVEN, at: START, session: 's2' },
  ])
  await $.session.start(START_ARGS)
  expect(lastOf(seen.status)).toMatch(/^5h ▱▱▱▱▱▱▱▱ 0% │ 7T ▰▰▰▰▰▱▱▱ 63% ↻Mo 09:00 \(vor 2h\) │ Ctx –$/)
  // Die Ablage selbst bleibt, wie sie ist.
  expect(sharedOf(seen)[0]).toMatchObject({ percent: 90 })
})

test('In claude -p wird nichts abgelegt', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const seen = engine(on)
  await $.session.start({ cwd: 'C:/test', surface: null, isInteractive: false })
  seen.usage = usage(130_000, 44, 64, 4.5)
  await $.session.measure(measure())
  await clock.advance(15_000)
  expect(seen.files.size).toBe(0)
  expect(seen.status).toEqual([])
})

test('Kaputte Ablage stört nicht: dann gilt der eigene Stand, die nächste Antwort schreibt sie neu', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const seen = engine(on)
  seen.files.set(SHARED, '{"limits":[{"kind":"five_hour","perc')
  await $.session.start(START_ARGS)
  expect(lastOf(seen.status)).toMatch(/^5h ▰▰▰▱▱▱▱▱ 42% ↻18:30 │/)
  putShared(seen, [{ kind: 'five_hour', percent: 'viel' }, null])
  await clock.advance(15_000)
  expect(lastOf(seen.status)).toMatch(/^5h ▰▰▰▱▱▱▱▱ 42% ↻18:30 │/)
  seen.usage = usage(130_000, 43, 63, 4.5)
  await clock.advance(15_000)
  expect(sharedOf(seen).map(l => l.percent)).toEqual([43, 63])
})

test('Steigen nur die Kosten (Hintergrund-Call), schlägt ein alter Stand keinen höheren im selben Fenster', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const seen = engine(on)
  await $.session.start(START_ARGS)
  // Diese Session ruht bei 42 %, eine andere hat danach 70 % gemessen.
  putShared(seen, [
    { kind: 'five_hour', percent: 70, resetsAt: FIVE, at: START + MIN, session: 's2' },
    { kind: 'seven_day', percent: 66, resetsAt: SEVEN, at: START + MIN, session: 's2' },
  ])
  await clock.advance(2 * MIN)
  seen.usage = usage(120_000, 42, 63, 4.3)
  await clock.advance(15_000)
  expect(sharedOf(seen).map(l => [l.percent, l.session])).toEqual([[70, 's2'], [66, 's2']])
  expect(lastOf(seen.status)).toMatch(/^5h ▰▰▰▰▰▰▱▱ 70% ↻18:30 │ 7T ▰▰▰▰▰▱▱▱ 66% ↻Mo 09:00 │/)
})

const MARKER = '/home/mike/.claude/mod-daten/sessions/s1.json'
const WEBSHOP = '/home/mike/.claude/projects/-home-mike/memory/project_webshop_ui.md'

test('Pane zeigt die Pickup-Datei; Knopf fragt nach, erst „Ja“ lässt sessions sichern und neu starten', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const seen = engine(on)
  seen.files.set(MARKER, JSON.stringify({ at: START, pickup: 'webshop pickup', file: WEBSHOP }))
  await $.session.start(START_ARGS)

  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await paneText($, surface)).toMatch(/webshop pickup → project_webshop_ui\.md/)
  }
  const ui = await $.ui.mount({ plugin: 'verbrauch', surface: 'terminal', component: 'Pane', requestId: 'verbrauch', props: PANE_PROPS })
  // Nur die Knöpfe von „Sichern & neu starten“; die des Auto-Neustarts prüfen eigene Tests.
  const RESTART_KEYS = ['neustart', 'abbrechen', 'ja']
  const labels = async () =>
    (await ui.findAll({ type: 'Button' })).filter(b => RESTART_KEYS.includes(b.key ?? '')).map(b => b.props.label)
  expect(await labels()).toEqual(['Sichern & neu starten'])
  // Der erste Knopf hat keine Taste: Tippen im fokussierten Fenster löst nichts aus.
  expect((await ui.findAll({ type: 'Button' }))[0]?.props.hotkey).toBeUndefined()
  await ui.press({ key: 'neustart' })
  expect(seen.commands).toEqual([])
  expect(await labels()).toEqual(['Abbrechen', 'Ja, sichern & neu starten'])
  // Ein sofortiger zweiter Druck (doppelter Klick, Enter) zählt nicht.
  await ui.press({ key: 'ja' })
  expect(seen.commands).toEqual([])
  // Abbrechen setzt zurück.
  await ui.press({ key: 'abbrechen' })
  expect(await labels()).toEqual(['Sichern & neu starten'])
  // Nachfrage verfällt nach 5 s.
  await ui.press({ key: 'neustart' })
  await clock.advance(5_000)
  expect(await labels()).toEqual(['Sichern & neu starten'])
  // Richtig: fragen, kurz warten, Ja.
  await ui.press({ key: 'neustart' })
  await clock.advance(1_000)
  await ui.press({ key: 'ja' })
  expect(seen.commands).toEqual(['pause selbst'])
  // Die Antwort steht im Verlauf; ein Toast kommt nur bei einem Fehler.
  expect(seen.toasts).toEqual([])
  expect(await labels()).toEqual(['Sichern & neu starten'])
  await ui.unmount()
})

test('Kein Knopf während eines Turns oder ohne Pickup-Datei; ein Fehler kommt als Meldung', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const seen = engine(on)
  await $.session.start(START_ARGS)
  expect(await paneText($)).toMatch(/unbekannt: keine Marke vom sessions-Mod/)

  seen.files.set(MARKER, JSON.stringify({ at: START, pickup: '', file: '' }))
  await $.turn.complete(TURN)
  expect(await paneText($)).toMatch(/keine Pickup-Datei \(Session begann ohne Pickup-Phrase\)/)
  seen.files.set(MARKER, JSON.stringify({ at: START, pickup: 'garten pickup', file: '' }))
  await $.turn.complete(TURN)
  expect(await paneText($)).toMatch(/keine Pickup-Datei: „garten pickup“ hat keine 🔑-Zeile in MEMORY\.md/)

  seen.files.set(MARKER, JSON.stringify({ at: START, pickup: 'webshop pickup', file: WEBSHOP }))
  await $.turn.start({ text: 'los', turnId: 't2' })
  expect(await paneText($)).toMatch(/Sichern & neu starten: nach dem laufenden Turn/)
  await $.turn.complete({ ...TURN, turnId: 't2' })

  seen.failCommand = true
  const ui = await $.ui.mount({ plugin: 'verbrauch', surface: 'terminal', component: 'Pane', requestId: 'verbrauch', props: PANE_PROPS })
  await ui.press({ key: 'neustart' })
  await clock.advance(1_000)
  await ui.press({ key: 'ja' })
  expect(lastOf(seen.toasts)).toMatch(/^Sichern & Neustart ging nicht: .*(kein solcher Befehl|no implementation for command\.run)/)
  await ui.unmount()
})

// Hintergrund: Agenten aus $.agent.list(), API-Aufrufe über turn.step, Shells über Bash und das Turn-Ende.
type Agent = { id: string; description: string; type: string; status: string }
type Usage = { model: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

const background = (on: On) => {
  const bg = { agents: [] as Agent[], backgroundTaskId: undefined as string | undefined, usage: null as Usage | null }
  on('agent.list', () => ({ value: bg.agents }))
  // Der API-Aufruf beneath: antwortet mit der Nutzung, die der Test gerade setzt.
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: bg.usage } as const
  })
  on('tool.call', ($, e) => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: bg.backgroundTaskId },
    ...('command' in e && e.command === 'kaputt' ? { isError: true } : {}),
  }))
  on('classic.SubagentStop', () => ({}))
  on('prompt.suggest', () => ({ isShown: true }))
  on('classic.Stop', () => ({}))
  return bg
}

const usageOf = (model: string, input: number, write: number, read: number, output: number): Usage => ({
  model,
  input_tokens: input,
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read,
  output_tokens: output,
})

// Ein API-Aufruf, wie die Engine ihn streamt: der Hook darunter antwortet mit `usage`.
const step = async (
  $: Parameters<Parameters<typeof test>[1]>[0],
  bg: ReturnType<typeof background>,
  usage: Usage | null,
  agentId?: string,
) => {
  bg.usage = usage
  const stream = $.turn.step({ turnId: 't1', index: 0, model: usage?.model ?? 'x', messageCount: 1, ...(agentId ? { agentId } : {}) })
  // Bis zum Ende lesen: der Rückgabewert des Streams ist das Ergebnis des Aufrufs.
  for (;;) {
    const r = await stream.next()
    if (r.done) return r.value
  }
}

test('Hintergrund: Kosten je Agent nach Preisliste, Statuszeile solange er läuft, danach gedimmt', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const seen = engine(on)
  const bg = background(on)
  await $.session.start(START_ARGS)
  expect(lastOf(seen.status)).not.toMatch(/⏳/)
  expect(await paneText($)).toMatch(/nichts läuft/)

  bg.agents = [{ id: 'a1', description: 'Review verbrauch-Mod', type: 'Explore', status: 'running' }]
  // Opus 5.5: 1k Input $4, 10k Cache-Schreiben zu 2× $8, 100k Cache-Lesen $0.20, 2k Output $20 → $0.144.
  const got = await step($, bg, usageOf('claude-opus-5-5', 1_000, 10_000, 100_000, 2_000), 'a1')
  // Der Aufruf selbst kommt unverändert durch.
  expect(got.answer).toBe('ok')
  expect(got.usage?.output_tokens).toBe(2_000)
  // Haupt-Loop, Sonnet 5.5: 1k Output zu $10 → $0.01.
  await step($, bg, usageOf('claude-sonnet-5-5', 0, 0, 0, 1_000))
  await clock.advance(15_000)
  expect(lastOf(seen.status)).toMatch(/│ ⏳ 1 Agent \$0\.14$/)

  let shown = await paneText($)
  expect(shown).toMatch(/Session wartet auf 1 Agent/)
  expect(shown).toMatch(/Review verbrauch-Mod/)
  expect(shown).toMatch(/\$0\.14 · 15″ · läuft · 1 Aufruf · Explore/)
  // Kein Häkchen, solange er läuft (das ✓ der Limit-Prognose zählt nicht).
  expect(shown).not.toMatch(/✓ \nReview verbrauch-Mod/)
  expect(shown).toMatch(/Agenten \$0\.14 · Haupt-Loop \$0\.01 · Nebenaufrufe der Engine \$0\.00 · seit 17:00, zusammen \$0\.00 wie die Engine/)
  // Ein Aufruf ohne Nutzungsangabe (abgebrochen, keine Antwort) zählt nicht.
  await step($, bg, null, 'a1')
  await clock.advance(0)
  expect(await paneText($)).toMatch(/1 Aufruf · Explore/)

  // Während eines Haupt-Turns heisst es „läuft“, nicht „wartet“.
  await $.turn.start({ text: 'los', turnId: 't9' })
  expect(await paneText($)).toMatch(/läuft: 1 Agent/)
  await $.turn.complete({ ...TURN, turnId: 't9' })

  bg.agents = [{ ...bg.agents[0]!, status: 'completed' }]
  await clock.advance(15_000)
  expect(lastOf(seen.status)).not.toMatch(/⏳/)
  shown = await paneText($)
  expect(shown).toMatch(/nichts läuft/)
  expect(shown).toMatch(/✓ \nReview verbrauch-Mod/)
  expect(shown).toMatch(/\$0\.14 · 30″ · fertig/)

  // Was die Engine mehr zählt, steht als Nebenaufrufe da, mit den Vorschlägen nach dem Turn.
  await $.prompt.suggest({ text: 'weiter', origin: { kind: 'suggestion' } })
  await $.prompt.suggest({ text: 'weiter', origin: { kind: 'suggestion' } })
  seen.usage = usage(120_000, 42, 63, 4.2 + 0.25)
  await clock.advance(15_000)
  expect(await paneText($)).toMatch(/Haupt-Loop \$0\.01 · Nebenaufrufe der Engine \$0\.10 \(u\. a\. 2 Vorschläge nach dem Turn\) · seit 17:00, zusammen \$0\.25 wie die Engine/)

  // Nach einer halben Stunde fällt die Zeile weg, die Summe bleibt.
  await clock.advance(31 * MIN)
  shown = await paneText($)
  expect(shown).not.toMatch(/Review verbrauch-Mod/)
  expect(shown).toMatch(/Agenten \$0\.14/)
})

test('Hintergrund: Loop ohne Listeneintrag, Modell ohne Preis, Agent fällt aus der Liste', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const seen = engine(on)
  const bg = background(on)
  await $.session.start(START_ARGS)

  // Ein Loop ohne Listeneintrag (Workflow-Agent, interner Fork) mit einem Modell, das die Preisliste
  // nicht kennt: zählt bei den Kosten, aber die Session wartet nicht auf ihn.
  await step($, bg, usageOf('claude-opus-4-5', 1_000, 0, 0, 1_000), 'w1')
  // Haiku 5.5 über 100k Prompt: der lange Tarif, $0.50 Input → 200k Input $0.10.
  bg.agents = [{ id: 'a2', description: 'Suche', type: 'general-purpose', status: 'running' }]
  await step($, bg, usageOf('claude-haiku-5-5', 200_000, 0, 0, 0), 'a2')
  await clock.advance(15_000)
  expect(lastOf(seen.status)).toMatch(/│ ⏳ 1 Agent \$0\.10$/)
  let shown = await paneText($)
  expect(shown).toMatch(/ohne Listeneintrag \(Workflow oder intern\)/)
  expect(shown).toMatch(/\$0\.00\+\? · 15″ · aktiv · 1 Aufruf · opus-4-5/)
  expect(shown).toMatch(/\$0\.10 · 15″ · läuft · 1 Aufruf · general-purpose/)

  // Der Agent verschwindet aus der Liste, ohne dass ein Ende zu sehen war; der Workflow ruht 2 Min.
  bg.agents = []
  await clock.advance(2 * MIN)
  expect(lastOf(seen.status)).not.toMatch(/⏳/)
  shown = await paneText($)
  expect(shown).toMatch(/nichts läuft/)
  expect(shown).toMatch(/\$0\.10 · 30″ · fertig/)
  expect(shown).toMatch(/\$0\.00\+\? · 0″ · ruht/)
})

test('Hintergrund: Shell ab dem Bash-Aufruf, beendet laut Liste der Engine beim Turn-Ende', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const seen = engine(on)
  const bg = background(on)
  await $.session.start(START_ARGS)

  bg.backgroundTaskId = 'b1'
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Tests laufen lassen', run_in_background: true })
  await clock.advance(15_000)
  expect(lastOf(seen.status)).toMatch(/│ ⏳ 1 Shell$/)
  expect(await paneText($)).toMatch(/Shell: Tests laufen lassen/)

  // Ein Bash-Aufruf im Vordergrund ändert nichts, ein fehlgeschlagener auch nicht.
  bg.backgroundTaskId = undefined
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  bg.backgroundTaskId = 'b9'
  await $.tool.call({ tool: 'Bash', command: 'kaputt', run_in_background: true })
  bg.backgroundTaskId = undefined
  await clock.advance(0)
  expect(lastOf(seen.status)).toMatch(/│ ⏳ 1 Shell$/)

  // Turn-Ende: die Shell läuft noch, dazu ein Monitor; Subagenten zählt die Agentenliste, nicht diese.
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [
      { id: 'b1', type: 'shell', status: 'running', description: 'Tests laufen lassen', command: 'npm test' },
      { id: 'm1', type: 'monitor', status: 'running', description: 'CI beobachten' },
      { id: 's1', type: 'subagent', status: 'running', description: 'Suche', agent_type: 'Explore' },
    ],
  })
  await clock.advance(15_000)
  expect(lastOf(seen.status)).toMatch(/│ ⏳ 1 Shell 1 Task$/)

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await clock.advance(15_000)
  expect(lastOf(seen.status)).not.toMatch(/⏳/)
  const shown = await paneText($)
  expect(shown).toMatch(/Shell: Tests laufen lassen/)
  expect(shown).toMatch(/30″ · fertig/)
  expect(shown).toMatch(/monitor: CI beobachten/)

  // Die Benachrichtigung der Engine beendet eine Shell schon vor dem Turn-Ende; eine laufende bleibt.
  bg.backgroundTaskId = 'b3'
  await $.tool.call({ tool: 'Bash', command: 'make', run_in_background: true })
  await clock.advance(15_000)
  expect(lastOf(seen.status)).toMatch(/│ ⏳ 1 Shell$/)
  const note = (id: string, status: string) =>
    `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>t</tool-use-id>\n<status>${status}</status>\n</task-notification>`
  await $.prompt.submit({ text: note('b3', 'running'), wait: false, origin: { kind: 'task-notification' } })
  await clock.advance(0)
  expect(lastOf(seen.status)).toMatch(/│ ⏳ 1 Shell$/)
  // Getippt zählt nicht, nur was die Engine als Benachrichtigung schickt.
  await $.prompt.submit(typed(note('b3', 'completed')))
  await clock.advance(0)
  expect(lastOf(seen.status)).toMatch(/│ ⏳ 1 Shell$/)
  await $.prompt.submit({ text: note('b3', 'completed'), wait: false, origin: { kind: 'task-notification' } })
  await clock.advance(0)
  expect(lastOf(seen.status)).not.toMatch(/⏳/)

  // Ohne Liste (ältere Engine) bleibt der Stand, wie er ist: die neue Shell läuft weiter.
  bg.backgroundTaskId = 'b2'
  await $.tool.call({ tool: 'Bash', command: 'sleep 99', run_in_background: true })
  await clock.advance(15_000)
  expect(lastOf(seen.status)).toMatch(/│ ⏳ 1 Shell$/)
  await $.classic.Stop({ stop_hook_active: false })
  await clock.advance(15_000)
  expect(lastOf(seen.status)).toMatch(/│ ⏳ 1 Shell$/)
  // Über SubagentStop gleicht es genauso ab.
  await $.classic.SubagentStop({ stop_hook_active: false, agent_id: 'x', agent_transcript_path: '', agent_type: 'Explore', background_tasks: [] })
  await clock.advance(15_000)
  expect(lastOf(seen.status)).not.toMatch(/⏳/)
})

test('Hintergrund: In claude -p zählt nichts, der Aufruf kommt trotzdem durch', async ($, on) => {
  mock.clock(on, { now: START })
  const seen = engine(on)
  const bg = background(on)
  await $.session.start({ cwd: 'C:/test', surface: null, isInteractive: false })
  const got = await step($, bg, usageOf('claude-opus-5-5', 1_000, 0, 0, 1_000), 'a1')
  expect(got.answer).toBe('ok')
  expect(seen.status).toEqual([])
})

// Auto-Neustart: Schalter im Store (auto:<id>), Auslöser kurz nach dem Turn-Ende, Countdown, /pause auto.
type T$ = Parameters<Parameters<typeof test>[1]>[0]
type Seen = ReturnType<typeof engine>
type Clock = ReturnType<typeof mock.clock>
const AFTER_TURN = 600
const autoCmd = (args: string, kind: 'composer' | 'bridge' = 'composer') =>
  ({ ...COMMAND, command: 'auto', args, origin: { kind } }) as const
const markerOf = (id: string) => `/home/mike/.claude/mod-daten/sessions/${id}.json`
const autoIn = (seen: Seen, id = 's1') => seen.store.get(`auto:${id}`) as Record<string, unknown> | undefined

// Session mit Pickup-Datei und Auto-Neustart an (Grenze 400k, Max 3, falls nicht anders gesagt).
const autoSetup = async ($: T$, on: Parameters<Parameters<typeof test>[1]>[1], args = 'an') => {
  const clock = mock.clock(on, { now: START })
  const seen = engine(on)
  const bg = background(on)
  seen.files.set(MARKER, JSON.stringify({ at: START, pickup: 'webshop pickup', file: WEBSHOP }))
  await $.session.start(START_ARGS)
  const said = await $.command.run(autoCmd(args))
  return { clock, seen, bg, said }
}

// Ein ganzer Haupt-Turn: Kontext danach `tokens`, classic.Stop mit `stop` (sonst nichts im Hintergrund).
const fullTurn = async (
  $: T$,
  seen: Seen,
  clock: Clock,
  tokens: number,
  turnId = 't1',
  stop: Record<string, unknown> = {},
  end: Record<string, unknown> = {},
) => {
  seen.usage = usage(tokens, 10, 20)
  await $.turn.start({ text: 'weiter', turnId })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [], ...stop })
  await $.turn.complete({ ...TURN, turnId, ...end })
  await clock.advance(AFTER_TURN)
}

// Derselbe Turn, ohne auf den verzögerten Auslöser zu warten (der Sicherungs-Turn vor dem /clear).
const fullTurnNoWait = async ($: T$, seen: Seen, tokens: number, turnId: string) => {
  seen.usage = usage(tokens, 10, 20)
  await $.turn.start({ text: 'Pause (Auto-Neustart): …', turnId })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [] })
  await $.turn.complete({ ...TURN, turnId })
}

test('Auto-Neustart: an + über der Grenze + nichts läuft → Countdown, dann /pause auto; Statuszeile zählt die Kette', async ($, on) => {
  const { clock, seen, said } = await autoSetup($, on)
  expect(said.text).toMatch(/^Auto-Neustart an: ab 400k Kontext sichert diese Session am Turn-Ende ihren Stand in project_webshop_ui\.md, startet frisch mit „webshop pickup“ und arbeitet weiter, höchstens 3-mal in Folge ohne dich\./)
  expect(autoIn(seen)).toMatchObject({ an: true, grenze: 400_000, max: 3, kette: 0 })
  expect(lastOf(seen.status)).toMatch(/│ 🔁 auto$/)

  // Unter der Grenze: nichts.
  await fullTurn($, seen, clock, 380_000)
  await clock.advance(31_000)
  expect(seen.commands).toEqual([])

  await fullTurn($, seen, clock, 410_000, 't2')
  expect(seen.toasts.some(t => t.startsWith('Auto-Neustart in 30 s: Die Session sichert ihren Stand und startet frisch.'))).toBe(true)
  expect(await paneText($)).toMatch(/Auto-Neustart in 30 s/)
  await clock.advance(4_000)
  expect(await paneText($)).toMatch(/Auto-Neustart in 26 s/)
  expect(seen.commands).toEqual([])
  await clock.advance(26_000)
  expect(seen.commands).toEqual(['pause auto'])
  expect(autoIn(seen)).toMatchObject({ an: true, kette: 1 })
  // Beginn des Neustarts: 500 ms nach dem Turn-Ende plus 30 s Countdown.
  expect(autoIn(seen)?.letzter).toBe(START + AFTER_TURN + 31_000 + 500 + 30_000)
  expect(await paneText($)).not.toMatch(/Auto-Neustart in/)
  await clock.advance(15_000)
  expect(lastOf(seen.status)).toMatch(/│ 🔁 auto 1\/3$/)
})

for (const [name, setupTurn] of [
  ['ein Agent läuft', async (_$: T$, _seen: Seen, bg: ReturnType<typeof background>) => {
    bg.agents = [{ id: 'a1', description: 'Suche', type: 'Explore', status: 'running' }]
    return {}
  }],
  ['eine Shell läuft', async () => ({ stop: { background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'npm test' }] } })],
  ['ein Monitor läuft', async () => ({ stop: { background_tasks: [{ id: 'm1', type: 'monitor', status: 'running', description: 'CI' }] } })],
  ['ein Teammate auf eine Nachricht wartet (idle)', async (_$: T$, _seen: Seen, bg: ReturnType<typeof background>) => {
    bg.agents = [{ id: 'a2', description: 'Reviewer', type: 'general-purpose', status: 'idle' }]
    return {}
  }],
  ['ein Subagent in den Hintergrund-Tasks steht', async () => ({ stop: { background_tasks: [{ id: 's1', type: 'subagent', status: 'running', description: 'Suche', agent_type: 'Explore' }] } })],
  ['ein Cron ist geplant (/loop)', async () => ({ stop: { session_crons: [{ id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'check' }] } })],
  ['Crons unbekannt (kein session_crons)', async () => ({ stop: { session_crons: undefined } })],
  ['der Turn wurde abgebrochen', async () => ({ end: { reason: 'aborted', isAborted: true } })],
  ['der Turn endete mit Fehler', async () => ({ end: { reason: 'error' } })],
  ['es ist ein Subagent-Turn', async () => ({ end: { agentId: 'a9' } })],
] as const) {
  test(`Auto-Neustart löst nicht aus, wenn ${name}`, async ($, on) => {
    const { clock, seen, bg } = await autoSetup($, on)
    const extra = (await setupTurn($, seen, bg)) as { stop?: Record<string, unknown>; end?: Record<string, unknown> }
    await fullTurn($, seen, clock, 450_000, 't1', extra.stop ?? {}, extra.end ?? {})
    await clock.advance(31_000)
    expect(seen.commands).toEqual([])
    expect(seen.toasts.some(t => t.startsWith('Auto-Neustart in'))).toBe(false)
  })
}

test('Auto-Neustart löst nicht aus: aus, ohne classic.Stop, oder mit Mikes Prompt in der Warteschlange', async ($, on) => {
  const { clock, seen } = await autoSetup($, on, 'aus')
  await fullTurn($, seen, clock, 450_000)
  await clock.advance(31_000)
  expect(seen.commands).toEqual([])
  expect(lastOf(seen.status)).not.toMatch(/🔁/)

  await $.command.run(autoCmd('an'))
  // Turn-Ende ohne classic.Stop: unklar, ob Crons laufen.
  await $.turn.start({ text: 'los', turnId: 't2' })
  await $.turn.complete({ ...TURN, turnId: 't2' })
  await clock.advance(31_000)
  expect(seen.commands).toEqual([])

  // Mike tippt während des Turns: der nächste Turn ist seiner.
  await $.turn.start({ text: 'los', turnId: 't3' })
  await $.prompt.submit({ ...typed('und noch'), turnId: 't3' })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [] })
  await $.turn.complete({ ...TURN, turnId: 't3' })
  await clock.advance(31_000)
  expect(seen.commands).toEqual([])
})

for (const [name, cancel] of [
  ['Knopf Abbrechen', async ($: T$) => {
    const ui = await $.ui.mount({ plugin: 'verbrauch', surface: 'terminal', component: 'Pane', requestId: 'verbrauch', props: PANE_PROPS })
    const button = await ui.find({ key: 'auto-abbrechen' })
    expect(button?.props.hotkey).toBe('x')
    await ui.press({ key: 'auto-abbrechen' })
    await ui.unmount()
  }],
  ['/auto aus', async ($: T$) => {
    expect((await $.command.run(autoCmd('aus'))).text).toBe('Auto-Neustart aus, der Countdown ist abgebrochen.')
  }],
  ['Mikes Prompt', async ($: T$) => {
    await $.prompt.submit(typed('warte'))
  }],
  ['Prompt vom Telefon', async ($: T$) => {
    await $.prompt.submit({ text: 'warte', wait: false, origin: { kind: 'bridge' } })
  }],
  ['ein neuer Turn (Cron, Benachrichtigung)', async ($: T$) => {
    await $.turn.start({ text: 'cron', turnId: 't9' })
  }],
] as const) {
  test(`Countdown bricht ab: ${name}`, async ($, on) => {
    const { clock, seen } = await autoSetup($, on)
    await fullTurn($, seen, clock, 450_000)
    await clock.advance(3_000)
    await cancel($)
    await clock.advance(30_000)
    expect(seen.commands).toEqual([])
    if (name !== '/auto aus') expect(lastOf(seen.toasts)).toMatch(/^Auto-Neustart abgebrochen/)
    expect(await paneText($)).not.toMatch(/Auto-Neustart in/)
  })
}

// Der Countdown läuft 30 s ab dem Auslöser (500 ms nach dem Turn-Ende; fullTurn wartet 600 ms, also steht er
// danach bei 100 ms): in der 29. Sekunde lässt er sich noch abbrechen, bei genau 30 s folgt /pause auto.
test('Countdown 30 s: Abbruch nach 29 s hält an, ohne Abbruch folgt /pause auto bei genau 30 s', async ($, on) => {
  const { clock, seen } = await autoSetup($, on)
  await fullTurn($, seen, clock, 450_000)
  await clock.advance(28_900)
  expect(await paneText($)).toMatch(/Auto-Neustart in 1 s/)
  expect(seen.commands).toEqual([])
  await $.prompt.submit(typed('warte'))
  expect(lastOf(seen.toasts)).toBe('Auto-Neustart abgebrochen: du hast geschrieben.')
  await clock.advance(60_000)
  expect(seen.commands).toEqual([])
  expect(autoIn(seen)).toMatchObject({ an: true, kette: 0 })

  // Nächster Turn über der Grenze (kein Mindestabstand: es gab noch keinen Auto-Neustart).
  await fullTurn($, seen, clock, 460_000, 't2')
  const started = clock.now() - 100
  await clock.advance(29_899)
  expect(seen.commands).toEqual([])
  await clock.advance(1)
  expect(seen.commands).toEqual(['pause auto'])
  expect(autoIn(seen)).toMatchObject({ kette: 1, letzter: started + 30_000 })
})

test('Kette: höchstens Max in Folge, Mindestabstand 10 Min., Mikes Prompt setzt zurück, gesenktes Max stoppt sofort', async ($, on) => {
  const { clock, seen } = await autoSetup($, on, 'an 400k 2')
  await fullTurn($, seen, clock, 450_000)
  await clock.advance(30_000)
  expect(seen.commands).toEqual(['pause auto'])
  // Der Sicherungs-Turn endet gleich danach über der Grenze: Mindestabstand, kein zweiter Countdown.
  await fullTurn($, seen, clock, 460_000, 't2')
  await clock.advance(31_000)
  expect(seen.commands.length).toBe(1)
  // Nach 10 Min. wieder.
  await clock.advance(10 * MIN)
  await fullTurn($, seen, clock, 470_000, 't3')
  await clock.advance(30_000)
  expect(seen.commands.length).toBe(2)
  expect(autoIn(seen)).toMatchObject({ kette: 2 })
  // 2/2: wartet, mit einer Meldung, und die Statuszeile sagt es.
  await clock.advance(10 * MIN)
  await fullTurn($, seen, clock, 480_000, 't4')
  await clock.advance(31_000)
  expect(seen.commands.length).toBe(2)
  expect(seen.toasts.filter(t => t === 'Auto-Neustart: 2/2 in Folge erreicht, die Session wartet auf dich.').length).toBe(1)
  expect(lastOf(seen.status)).toMatch(/│ 🔁 auto 2\/2 – wartet$/)
  expect(await paneText($)).toMatch(/Auto-Neustart: ● an · Kette 2\/2 erreicht, wartet auf dich/)
  // Höheres Max (Feld): es geht weiter.
  const ui = await $.ui.mount({ plugin: 'verbrauch', surface: 'terminal', component: 'Pane', requestId: 'verbrauch', props: PANE_PROPS })
  await ui.input({ key: 'auto-max', text: '3' })
  await ui.unmount()
  expect(autoIn(seen)).toMatchObject({ max: 3, kette: 2 })
  await fullTurn($, seen, clock, 490_000, 't5')
  await clock.advance(30_000)
  expect(seen.commands.length).toBe(3)
  // Mike schreibt: die Kette zählt neu.
  await $.prompt.submit(typed('gut so'))
  expect(autoIn(seen)).toMatchObject({ kette: 0 })
  // Max unter den Zählerstand gesenkt: sofort erreicht.
  await clock.advance(10 * MIN)
  await fullTurn($, seen, clock, 450_000, 't6')
  await clock.advance(30_000)
  expect(autoIn(seen)).toMatchObject({ kette: 1 })
  expect((await $.command.run(autoCmd('max 1'))).text).toBe('Auto-Neustart: höchstens 1 Neustarts in Folge. Die Kette steht schon bei 1: sie wartet, bis du schreibst.')
  await clock.advance(10 * MIN)
  await fullTurn($, seen, clock, 450_000, 't7')
  await clock.advance(31_000)
  expect(seen.commands.length).toBe(4)
  expect(lastOf(seen.status)).toMatch(/│ 🔁 auto 1\/1 – wartet$/)
})

test('Max 1: nach einem Auto-Neustart wartet die Session', async ($, on) => {
  const { clock, seen } = await autoSetup($, on, 'an 300k 1')
  await fullTurn($, seen, clock, 310_000)
  await clock.advance(30_000)
  await clock.advance(10 * MIN)
  await fullTurn($, seen, clock, 320_000, 't2')
  await clock.advance(31_000)
  expect(seen.commands).toEqual(['pause auto'])
  expect(lastOf(seen.toasts)).toBe('Auto-Neustart: 1/1 in Folge erreicht, die Session wartet auf dich.')
})

test('Abgleich mit der Engine: nach /clear zählt sie ab 0, die Summe wird nie negativ', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const seen = engine(on)
  const bg = background(on)
  await $.session.start(START_ARGS)
  await step($, bg, usageOf('claude-sonnet-5-5', 0, 0, 0, 1_000))
  await clock.advance(15_000)
  expect(await paneText($)).toMatch(/seit 17:00, zusammen \$0\.00 wie die Engine/)
  // Der Startwert stammt noch vom alten Stand ($4.20), die Engine zählt nach dem /clear ab 0.
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  seen.id = 's2'
  await clock.advance(400)
  seen.usage = usage(20_000, 10, 20, 0.9)
  await step($, bg, usageOf('claude-sonnet-5-5', 0, 0, 0, 1_000))
  await clock.advance(15_000)
  const shown = await paneText($)
  expect(shown).not.toMatch(/\$-/)
  expect(shown).toMatch(/zusammen \$0\.90 wie die Engine/)
})

test('Abgleich mit der Engine: ein neuer Start (startedAt) zählt ab 0, auch wenn er schon mehr kostet als der alte Stand', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const seen = engine(on)
  const bg = background(on)
  // Startwert vom alten, billigen Stand: $0.05.
  seen.usage = usage(20_000, 10, 20, 0.05)
  await $.session.start(START_ARGS)
  await step($, bg, usageOf('claude-sonnet-5-5', 0, 0, 0, 1_000))
  await clock.advance(15_000)
  expect(await paneText($)).toMatch(/zusammen \$0\.00 wie die Engine/)
  // Die Engine hat neu gestartet und steht schon bei $0.30: ohne startedAt hiesse es $0.25.
  seen.usage = { ...usage(20_000, 10, 20, 0.3), startedAt: START + 10 * MIN }
  await clock.advance(15_000)
  expect(await paneText($)).toMatch(/zusammen \$0\.30 wie die Engine/)
})

// Wie der sessions-Mod nach dem Sicherungs-Turn: /clear, neue ID, Marke erst leer, dann mit der Phrase.
const clearTo = async ($: T$, seen: Seen, clock: Clock, from: string, to: string) => {
  await $.session.end({ reason: 'clear', sessionId: from, resume: { id: from } })
  seen.id = to
  seen.files.set(markerOf(to), JSON.stringify({ at: START, pickup: 'webshop pickup', file: WEBSHOP }))
  await clock.advance(400)
}

test('/clear nach dem eigenen Auto-Neustart: der Schalter zieht mit, die Kette bleibt', async ($, on) => {
  const { clock, seen } = await autoSetup($, on)
  await fullTurn($, seen, clock, 450_000)
  await clock.advance(30_000)
  expect(seen.commands).toEqual(['pause auto'])
  await clearTo($, seen, clock, 's1', 's2')
  expect(autoIn(seen, 's1')).toBeUndefined()
  expect(autoIn(seen, 's2')).toMatchObject({ an: true, grenze: 400_000, max: 3, kette: 1 })
  expect(lastOf(seen.status)).toMatch(/│ 🔁 auto 1\/3$/)
})

test('/clear von Hand: Schalter, Grenze und Max. ziehen mit, die Kette zählt neu', async ($, on) => {
  const { clock, seen } = await autoSetup($, on, 'an 300k 5')
  await fullTurn($, seen, clock, 450_000)
  await clock.advance(30_000)
  expect(autoIn(seen)).toMatchObject({ kette: 1 })
  // Länger als 30 Min. nach dem Auto-Neustart: ein /clear ist nicht mehr seiner.
  await clock.advance(31 * MIN)
  await clearTo($, seen, clock, 's1', 's2')
  expect(autoIn(seen, 's2')).toMatchObject({ an: true, grenze: 300_000, max: 5, kette: 0 })
  // Ein /clear ohne vorherigen Auto-Neustart ebenso.
  await clearTo($, seen, clock, 's2', 's3')
  expect(autoIn(seen, 's2')).toBeUndefined()
  expect(autoIn(seen, 's3')).toMatchObject({ an: true, kette: 0 })
})

test('Ablauf wie echt: Sicherungs-Turn → /clear → Pickup-Turn; kein Auslöser aus dem alten Turn, Kette bis Max', async ($, on) => {
  const { clock, seen } = await autoSetup($, on, 'an 400k 2')
  let ids = 1
  // Ein Auto-Neustart: Countdown, /pause auto, Sicherungs-Turn über der Grenze, gleich danach /clear (vor den
  // 500 ms des verzögerten Auslösers), dann der Pickup-Turn der neuen Session.
  const restart = async () => {
    await clock.advance(30_000)
    const from = `s${ids}`
    const to = `s${++ids}`
    await fullTurnNoWait($, seen, 470_000, `save${ids}`)
    await clearTo($, seen, clock, from, to)
    await clock.advance(AFTER_TURN)
    // Pickup-Turn: kleiner Kontext.
    await fullTurn($, seen, clock, 90_000, `pickup${ids}`)
    await clock.advance(31_000)
  }
  await fullTurn($, seen, clock, 450_000)
  await restart()
  expect(seen.commands).toEqual(['pause auto'])
  expect(autoIn(seen, 's2')).toMatchObject({ kette: 1 })
  expect(seen.toasts.filter(t => t.startsWith('Auto-Neustart in')).length).toBe(1)
  // Die Session arbeitet weiter und wächst wieder über die Grenze (nach dem Mindestabstand).
  await clock.advance(10 * MIN)
  await fullTurn($, seen, clock, 455_000, 'work2')
  await restart()
  expect(seen.commands).toEqual(['pause auto', 'pause auto'])
  expect(autoIn(seen, 's3')).toMatchObject({ kette: 2 })
  // 2/2: wartet.
  await clock.advance(10 * MIN)
  await fullTurn($, seen, clock, 460_000, 'work3')
  await clock.advance(31_000)
  expect(seen.commands.length).toBe(2)
  expect(lastOf(seen.toasts)).toBe('Auto-Neustart: 2/2 in Folge erreicht, die Session wartet auf dich.')
})

test('Grenze und Max. Neustarts: Felder übernehmen gültige Werte, ungültige bleiben beim alten Wert', async ($, on) => {
  const { seen } = await autoSetup($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'verbrauch', surface, component: 'Pane', requestId: 'verbrauch', props: PANE_PROPS })
    expect((await ui.find({ key: 'auto-grenze' }))?.props.value).toBe('400k')
    await ui.input({ key: 'auto-grenze', text: '300k' })
    expect(autoIn(seen)).toMatchObject({ grenze: 300_000 })
    await ui.input({ key: 'auto-grenze', text: '350000' })
    expect(autoIn(seen)).toMatchObject({ grenze: 350_000 })
    for (const bad of ['abc', '0', '25', '5k', '950k']) {
      await ui.input({ key: 'auto-grenze', text: bad })
      expect(autoIn(seen)).toMatchObject({ grenze: 350_000 })
    }
    expect(lastOf(seen.toasts)).toBe('Grenze 950k geht nicht: erlaubt sind 50k bis 900k.')
    expect((await ui.find({ key: 'auto-grenze' }))?.props.value).toBe('350k')
    await ui.input({ key: 'auto-max', text: '5' })
    expect(autoIn(seen)).toMatchObject({ max: 5 })
    for (const bad of ['0', '21', 'abc', '2.5', '-1']) {
      await ui.input({ key: 'auto-max', text: bad })
      expect(autoIn(seen)).toMatchObject({ max: 5 })
    }
    expect(lastOf(seen.toasts)).toBe('„-1“ geht nicht als Max. Neustarts: eine ganze Zahl von 1 bis 20.')
    await $.command.run(autoCmd('an 400k 3'))
    await ui.unmount()
  }
})

test('−/+ an den Grenzen; die Mobile-App zeichnet Knöpfe statt Felder', async ($, on) => {
  const { seen } = await autoSetup($, on, 'an 100k 2')
  const ui = await $.ui.mount({ plugin: 'verbrauch', surface: 'mobile', component: 'Pane', requestId: 'verbrauch', props: PANE_PROPS })
  expect(await ui.findAll({ type: 'Input' })).toEqual([])
  expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['neustart', 'auto', 'grenze-', 'grenze+', 'max-', 'max+'])
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')).toMatch(/Grenze 100k/)
  await ui.press({ key: 'grenze-' })
  expect(autoIn(seen)).toMatchObject({ grenze: 50_000 })
  await ui.press({ key: 'grenze-' })
  expect(autoIn(seen)).toMatchObject({ grenze: 50_000 })
  expect(lastOf(seen.toasts)).toBe('Grenze 0 geht nicht: erlaubt sind 50k bis 900k.')
  await ui.press({ key: 'max-' })
  expect(autoIn(seen)).toMatchObject({ max: 1 })
  await ui.press({ key: 'max-' })
  expect(autoIn(seen)).toMatchObject({ max: 1 })
  await $.command.run(autoCmd('max 19'))
  await $.command.run(autoCmd('grenze 850k'))
  await ui.press({ key: 'max+' })
  await ui.press({ key: 'max+' })
  expect(autoIn(seen)).toMatchObject({ max: 20 })
  await ui.press({ key: 'grenze+' })
  await ui.press({ key: 'grenze+' })
  expect(autoIn(seen)).toMatchObject({ grenze: 900_000 })
  expect(lastOf(seen.toasts)).toBe('Grenze 950k geht nicht: erlaubt sind 50k bis 900k.')
  // Der Schalter selbst: der Text sagt den Zustand, der Knopf, was er tut.
  const switchLabel = async () => (await ui.find({ key: 'auto' }))?.props.label
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(await switchLabel()).toBe('ausschalten')
  expect(await texts()).toMatch(/Auto-Neustart: ● an · ab 900k/)
  await ui.press({ key: 'auto' })
  expect(autoIn(seen)).toMatchObject({ an: false })
  expect(await switchLabel()).toBe('einschalten')
  expect(await texts()).toMatch(/Auto-Neustart: ○ aus/)
  // −/+ bei ausgeschaltetem Schalter: der Wert gilt, die Meldung sagt, dass er noch aus ist.
  await ui.press({ key: 'max-' })
  expect(autoIn(seen)).toMatchObject({ an: false, max: 19 })
  expect(lastOf(seen.toasts)).toBe('Auto-Neustart: höchstens 19 Neustarts in Folge. Gilt erst, wenn er an ist: /auto an oder Knopf „einschalten“.')
  await ui.press({ key: 'auto' })
  expect(autoIn(seen)).toMatchObject({ an: true })
  expect(await switchLabel()).toBe('ausschalten')
  await ui.unmount()
})

test('/auto: Status, Unterbefehle, Grenze unter dem Kontextfenster, ohne Pickup-Datei bleibt er aus', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const seen = engine(on)
  background(on)
  await $.session.start(START_ARGS)
  expect((await $.command.run(autoCmd(''))).text).toMatch(/^Auto-Neustart aus \(Grenze 400k, höchstens 3 in Folge\); einschalten geht hier nicht: keine Marke vom sessions-Mod\.\nAufruf: \/auto/)
  seen.files.set(MARKER, JSON.stringify({ at: START, pickup: '', file: '' }))
  expect((await $.command.run(autoCmd('an'))).text).toBe('Auto-Neustart bleibt aus: Session ohne 🔑-Phrase. Er braucht eine Pickup-Datei (🔑-Zeile in MEMORY.md).')
  seen.files.set(MARKER, JSON.stringify({ at: START, pickup: 'garten pickup', file: '' }))
  expect((await $.command.run(autoCmd('an'))).text).toMatch(/^Auto-Neustart bleibt aus: „garten pickup“ hat keine 🔑-Zeile in MEMORY\.md\./)
  await clock.advance(15_000)
  let shown = await paneText($)
  expect(shown).toMatch(/Auto-Neustart: nicht möglich, „garten pickup“ hat keine 🔑-Zeile in MEMORY\.md/)
  expect(seen.store.has('auto:s1')).toBe(false)
  expect((await $.command.run(autoCmd('max 4'))).text).toBe(
    'Auto-Neustart: höchstens 4 Neustarts in Folge. Einschalten geht hier nicht: „garten pickup“ hat keine 🔑-Zeile in MEMORY.md.',
  )

  seen.files.set(MARKER, JSON.stringify({ at: START, pickup: 'webshop pickup', file: WEBSHOP }))
  // Grenze und Max. gehen auch ausgeschaltet, sagen dann aber, dass er aus ist.
  expect((await $.command.run(autoCmd('grenze 300k'))).text).toBe(
    'Auto-Neustart: Grenze jetzt 300k. Gilt erst, wenn er an ist: /auto an oder Knopf „einschalten“.',
  )
  expect(autoIn(seen)).toMatchObject({ an: false, grenze: 300_000 })
  expect((await $.command.run(autoCmd('an 0.4m 5'))).text).toMatch(/^Auto-Neustart an: ab 400k/)
  expect((await $.command.run(autoCmd('max 5'))).text).toBe('Auto-Neustart: höchstens 5 Neustarts in Folge.')
  expect(autoIn(seen)).toMatchObject({ an: true, grenze: 400_000, max: 5 })
  expect((await $.command.run(autoCmd('an 300k 5'))).text).toMatch(/^Auto-Neustart an: ab 300k .+ höchstens 5-mal/)
  expect((await $.command.run(autoCmd('grenze 1m'))).text).toBe('Grenze 1.0M geht nicht: erlaubt sind 50k bis 900k.')
  expect((await $.command.run(autoCmd('max 25'))).text).toBe('„25“ geht nicht als Max. Neustarts: eine ganze Zahl von 1 bis 20.')
  expect((await $.command.run(autoCmd('an 300k 5 7'))).text).toMatch(/^Aufruf: \/auto/)
  expect((await $.command.run(autoCmd('irgendwas'))).text).toMatch(/^Aufruf: \/auto/)
  expect(autoIn(seen)).toMatchObject({ an: true, grenze: 300_000, max: 5 })
  seen.usage = usage(250_000, 10, 20)
  expect((await $.command.run(autoCmd(''))).text).toMatch(/^Auto-Neustart an: ab 300k Kontext \(jetzt 250k\), Kette 0\/5\.\n/)
  shown = await paneText($)
  expect(shown).toMatch(/Auto-Neustart: ● an · ab 300k · Kette 0\/5/)

  // Ein Modell mit 200k-Fenster: die Grenze muss darunter liegen.
  seen.usage = { ...usage(100_000, 10, 20), context: { tokens: 100_000, window: 200_000 } }
  expect((await $.command.run(autoCmd('grenze 250k'))).text).toBe('Grenze 250k geht nicht: sie muss unter dem Kontextfenster (200k) liegen.')
  expect((await $.command.run(autoCmd('an'))).text).toBe('Grenze 300k geht nicht: sie muss unter dem Kontextfenster (200k) liegen. Mit anderer Grenze: /auto an 150k')
  const ui = await $.ui.mount({ plugin: 'verbrauch', surface: 'terminal', component: 'Pane', requestId: 'verbrauch', props: PANE_PROPS })
  await ui.press({ key: 'grenze-' })
  await ui.unmount()
  expect(autoIn(seen)).toMatchObject({ grenze: 150_000 })
  expect((await $.command.run(autoCmd('aus'))).text).toBe('Auto-Neustart aus.')
  await clock.advance(15_000)
  expect(lastOf(seen.status)).not.toMatch(/🔁/)
})

test('Deploy-Sperre: nur bei an und laufender Kette ohne Mike; --check geht durch', async ($, on) => {
  const { clock, seen } = await autoSetup($, on)
  const bash = (command: string) => $.tool.call({ tool: 'Bash', command })
  // Kette 0: alles geht.
  expect((await bash('ansible-playbook -i prod site.yml')).deny).toBeUndefined()
  await fullTurn($, seen, clock, 450_000)
  await clock.advance(30_000)
  expect(autoIn(seen)).toMatchObject({ kette: 1 })
  for (const command of [
    'ansible-playbook -i inventories/prod deploy.yml',
    'cd ~/infra && ansible-playbook site.yml -i hosts.ini',
    'ansible-playbook a.yml --check && ansible-playbook b.yml',
    'npx vercel deploy --prod',
    'vercel --prod --yes',
    'npx wrangler deploy',
    'wrangler publish',
  ]) {
    const ran = await bash(command)
    expect(ran.deny).toMatch(/^Gesperrt vom verbrauch-Mod: Diese Session läuft in einer Auto-Neustart-Kette ohne Mike \(1\/3\)\. .*`Auto-Weiter: nein — Prod-Deploy wartet auf Mike`/)
  }
  for (const command of [
    "bash -c 'cd ~/infra && ansible-playbook deploy.yml'",
    'sudo -E ansible-playbook site.yml',
    'env ANSIBLE_FORCE_COLOR=1 ansible-playbook site.yml',
    '~/venv/bin/ansible-playbook site.yml',
    'echo $(ansible-playbook site.yml)',
    'npx wrangler pages deploy dist',
    'wrangler versions deploy',
    'ANSIBLE_CONFIG=x ansible-playbook site.yml',
    'time ansible-playbook site.yml',
    'nohup ansible-playbook site.yml',
    'timeout 600 ansible-playbook site.yml',
    'uv run ansible-playbook site.yml',
  ]) {
    expect((await bash(command)).deny).toMatch(/^Gesperrt vom verbrauch-Mod/)
  }
  for (const command of [
    'ansible-playbook site.yml --check',
    'ansible-playbook site.yml --syntax-check',
    'ansible-playbook --check -i prod site.yml --diff',
    'ansible-playbook -C site.yml',
    'grep ansible-playbook README.md',
    'rg -n "vercel --prod" docs',
    'cat deploy.log | grep wrangler',
    'echo "wrangler deploy"',
    'vercel deploy',
    'wrangler dev',
    'git status',
  ]) {
    expect((await bash(command)).deny).toBeUndefined()
  }
  // Mike schreibt: Kette 0, die Sperre fällt.
  await $.prompt.submit(typed('deploy bitte'))
  expect((await bash('ansible-playbook site.yml')).deny).toBeUndefined()
  // Aus: auch mit Kette keine Sperre.
  await clock.advance(10 * MIN)
  await fullTurn($, seen, clock, 450_000, 't2')
  await clock.advance(30_000)
  expect((await bash('vercel --prod')).deny).toBeDefined()
  await $.command.run(autoCmd('aus'))
  expect((await bash('vercel --prod')).deny).toBeUndefined()
})

test('Alte auto:-Einträge fallen nach einem Monat heraus', async ($, on) => {
  mock.clock(on, { now: START })
  const old = { an: true, grenze: 400_000, max: 3, kette: 0, letzter: 0, at: START - 40 * DAY, frisch: false, zuGross: false }
  const seen = engine(on, [], { 'auto:alt': old, 'auto:jung': { ...old, at: START - DAY }, 'auto:kaputt': { an: 'ja' } })
  await $.session.start(START_ARGS)
  expect([...seen.store.keys()]).toEqual(['auto:jung'])
})

test('/auto aus nach dem Auslösen hält auch den Neustart beim sessions-Mod an', async ($, on) => {
  const { clock, seen } = await autoSetup($, on)
  // Ohne ausgelösten Neustart: kein /pause abbrechen.
  await $.command.run(autoCmd('aus'))
  expect(seen.commands).toEqual([])
  await $.command.run(autoCmd('an'))
  await fullTurn($, seen, clock, 450_000)
  await clock.advance(30_000)
  expect(seen.commands).toEqual(['pause auto'])
  // Der Sicherungs-Turn läuft: /auto aus schreibt die Abbruch-Datei (gilt sofort) und reiht /pause abbrechen ein.
  await $.turn.start({ text: 'Pause (Auto-Neustart): …', turnId: 'save' })
  expect((await $.command.run(autoCmd('aus'))).text).toBe('Auto-Neustart aus.')
  const at = clock.now()
  await clock.advance(300)
  expect(seen.commands).toEqual(['pause auto', 'pause abbrechen'])
  expect(JSON.parse(seen.files.get('/home/mike/.claude/mod-daten/sessions/s1.abbruch') ?? '{}')).toMatchObject({ at })
  expect(seen.toasts.some(t => t.includes('ging nicht'))).toBe(false)
  expect(autoIn(seen)).toMatchObject({ an: false, kette: 0 })
})

test('Wettlauf: /auto aus, während fire noch liest, gewinnt; kein /pause auto, kein an zurückgeschrieben', async ($, on) => {
  const { clock, seen } = await autoSetup($, on)
  await fullTurn($, seen, clock, 450_000)
  await clock.advance(29_000)
  let release = () => {}
  seen.gate = new Promise<void>(resolve => {
    release = resolve
  })
  // Die letzte Sekunde: fire beginnt und hängt am Lesen des Stores.
  await clock.advance(1_000)
  const off = $.command.run(autoCmd('aus'))
  await clock.settle()
  seen.gate = undefined
  release()
  await off
  await clock.advance(1_000)
  expect(seen.commands).toEqual([])
  expect(autoIn(seen)).toMatchObject({ an: false, kette: 0 })
})
