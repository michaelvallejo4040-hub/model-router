import type { Register, EngineInterface } from 'claude-code'

// ---------------------------------------------------------------------------
// model-router: send each task to the cheapest model that can handle it.
//
//   simple   -> haiku   (lookups, explanations, renames, small edits, chit-chat)
//   moderate -> sonnet  (ordinary coding work)
//   complex  -> the session's own model (architecture, hard debugging, big builds)
//
// It never routes *up*: if the session already runs on Sonnet, "complex" just
// stays on Sonnet. Prefix a prompt with "!!" to force the session's model for
// that one turn, or "!cheap" to force Haiku.
// ---------------------------------------------------------------------------

type Tier = 'simple' | 'moderate' | 'complex'
type Mode = 'auto' | 'off' | 'haiku' | 'sonnet'
type Settings = { mode: Mode; classifier: boolean; escalateAfterSteps: number; longContext: number }
type Stats = Record<string, number>

const DEFAULTS: Settings = { mode: 'auto', classifier: true, escalateAfterSteps: 20, longContext: 60 }
const TIER_MODEL: Record<Tier, string | undefined> = { simple: 'haiku', moderate: 'sonnet', complex: undefined }

const RANK = (m: string): number =>
  /haiku/i.test(m) ? 1 : /sonnet/i.test(m) ? 2 : /opus/i.test(m) ? 3 : /fable/i.test(m) ? 4 : 3

const COMPLEX = /\b(architect\w*|design (a|the)|refactor\w*|debug\w*|root cause|race condition|deadlock|memory leak|security|vulnerab\w*|migrat\w*|implement\w*|build (me|a|an|the)|from scratch|optimi[sz]\w*|performance|concurren\w*|algorithm|prove|trade-?offs?|end-to-end|whole (repo|codebase|project)|across (the|all) files)\b/i
const SIMPLE = /^(what('s| is| are| does)|who|when|where|which|how (do|can) i|explain|define|summari[sz]e|translate|list|show( me)?|print|find|grep|search|look up|rename|fix (the |a |this )?typo|format|reword|rephrase|write a (commit|short|one-line)|convert|thanks|thank you|hi|hello|hey)\b/i
const CONTINUATION = /^(y|yes|yep|ok|okay|sure|go( ahead)?|continue|do it|proceed|sounds good|lgtm|no|nope|n)[.! ]*$/i

// Per-session memory (resets on a mod reload, which is fine).
const planned = new Map<string, { model?: string; tier: Tier; why: string }>()
let lastModel: string | undefined
let lastTier: Tier = 'complex'
let forceNext: 'full' | 'cheap' | undefined

async function settings($: EngineInterface): Promise<Settings> {
  const s = (await $.store.get('settings')) as Partial<Settings> | undefined
  return { ...DEFAULTS, ...(s ?? {}) }
}

async function bump($: EngineInterface, key: string) {
  const stats = ((await $.store.get('stats')) as Stats | undefined) ?? {}
  stats[key] = (stats[key] ?? 0) + 1
  await $.store.set('stats', stats)
}

function heuristic(text: string): { tier?: Tier; why: string } {
  const t = text.trim()
  if (t === '') return { why: 'empty' }
  if (CONTINUATION.test(t)) return { tier: lastTier, why: 'follow-up, same tier as last turn' }
  if (t.length > 1500 || (t.match(/```/g) ?? []).length >= 4) return { tier: 'complex', why: 'long / code-heavy prompt' }
  if (COMPLEX.test(t)) return { tier: 'complex', why: 'complex keywords' }
  if (t.length < 160 && SIMPLE.test(t)) return { tier: 'simple', why: 'short simple request' }
  if (t.length < 40) return { tier: 'simple', why: 'very short prompt' }
  return { why: 'unclear' }
}

async function classify($: EngineInterface, text: string, s: Settings): Promise<{ tier: Tier; why: string }> {
  const h = heuristic(text)
  if (h.tier) return { tier: h.tier, why: h.why }
  if (!s.classifier) return { tier: 'moderate', why: 'default (classifier off)' }
  try {
    const label = await $.model.classify(
      'Rate how hard this request to a coding assistant is. simple = a quick answer, lookup or trivial edit. ' +
        'moderate = ordinary coding work in a few files. complex = deep reasoning, architecture, tricky debugging, ' +
        'or a large multi-file build.\n\nRequest:\n' + text.slice(0, 4000),
      ['simple', 'moderate', 'complex'],
      { model: 'haiku' },
    )
    if (label === 'simple' || label === 'moderate' || label === 'complex') return { tier: label, why: 'haiku classifier' }
  } catch {
    /* fall through */
  }
  return { tier: 'complex', why: 'classifier unsure, kept full model' }
}

/** The model to use for a tier, never above the model the session already runs. */
function pick(tier: Tier, sessionModel: string, s: Settings): string | undefined {
  if (s.mode === 'haiku' || s.mode === 'sonnet') return RANK(s.mode) < RANK(sessionModel) ? s.mode : undefined
  const m = TIER_MODEL[tier]
  return m && RANK(m) < RANK(sessionModel) ? m : undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'route',
      description: 'Model router: /route [status|on|off|haiku|sonnet|classifier on|off|stats|reset]',
    })
    const s = await settings($)
    $.ui.status(s.mode === 'off' ? undefined : `route: ${s.mode}`)
    return next(e)
  })

  on('command.run', { command: 'route' }, async ($, e) => {
    const s = await settings($)
    const [a = 'status', b] = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const save = async (patch: Partial<Settings>) => {
      const next = { ...s, ...patch }
      await $.store.set('settings', next)
      $.ui.status(next.mode === 'off' ? undefined : `route: ${next.mode}`)
      return next
    }
    switch (a) {
      case 'on':
      case 'auto':
        await save({ mode: 'auto' })
        return { text: 'model-router: automatic routing on.' }
      case 'off':
        await save({ mode: 'off' })
        return { text: 'model-router: off, every turn uses the session model.' }
      case 'haiku':
      case 'sonnet':
        await save({ mode: a })
        return { text: `model-router: forcing ${a} for every turn (when cheaper than the session model).` }
      case 'classifier':
        await save({ classifier: b !== 'off' })
        return { text: `model-router: haiku classifier ${b !== 'off' ? 'on' : 'off'}.` }
      case 'stats': {
        const st = ((await $.store.get('stats')) as Stats | undefined) ?? {}
        const rows = Object.entries(st).map(([k, v]) => `  ${k}: ${v}`).join('\n')
        return { text: `model-router turns routed:\n${rows || '  (none yet)'}` }
      }
      case 'reset':
        await $.store.set('stats', {})
        return { text: 'model-router: stats cleared.' }
      default:
        return {
          text:
            `model-router: mode=${s.mode}, classifier=${s.classifier ? 'on' : 'off'}, ` +
            `session model=${await $.session.model()}, last turn=${lastModel ?? 'full'} (${lastTier}).\n` +
            'Usage: /route [status|on|off|haiku|sonnet|classifier on|off|stats|reset]. ' +
            'Prefix a prompt with !! for the full model or !cheap for haiku.',
        }
    }
  })

  // Per-turn override prefixes: "!!" = full model, "!cheap" = haiku.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    const m = e.text.match(/^\s*(!!|!cheap\b)\s*/i)
    if (!m) return next(e)
    forceNext = m[1] === '!!' ? 'full' : 'cheap'
    return next({ ...e, text: e.text.slice(m[0].length) })
  }).catch(($, e, next) => next(e))

  // Decide the model when a main-loop turn starts.
  on('turn.start', async ($, e, next) => {
    if (e.agentId) return next(e)
    const s = await settings($)
    if (s.mode === 'off') return next(e)
    const sessionModel = await $.session.model()
    let plan: { model?: string; tier: Tier; why: string }
    if (forceNext === 'full') plan = { tier: 'complex', why: '!! override' }
    else if (forceNext === 'cheap') plan = { tier: 'simple', model: pick('simple', sessionModel, { ...s, mode: 'auto' }), why: '!cheap override' }
    else if (e.text === '') plan = { tier: lastTier, model: lastModel, why: 'continuation' }
    else {
      const c = await classify($, e.text, s)
      plan = { ...c, model: pick(c.tier, sessionModel, s) }
    }
    forceNext = undefined
    planned.set(e.turnId, plan)
    return next(e)
  })

  // Apply the decision to every model request of the turn.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const plan = planned.get(e.turnId)
    if (!plan) return yield* next(e)
    const s = await settings($)

    if (e.index === 0 && plan.model && plan.model !== lastModel && e.messageCount > s.longContext) {
      // Switching model drops the prompt cache; on a long conversation the
      // uncached re-read can cost more than it saves, so stay put.
      plan.model = lastModel
      plan.why += `; kept previous model (long context, ${e.messageCount} msgs)`
    }
    if (plan.model && e.index >= s.escalateAfterSteps) {
      plan.model = undefined
      plan.why += `; escalated after ${e.index} steps`
      $.ui.toast(`model-router: task is bigger than it looked, back to ${e.model}`)
    }

    if (e.index === 0 || plan.model === undefined) {
      const label = plan.model ?? 'full'
      $.ui.status(`route: ${label} (${plan.tier})`)
      if (e.index === 0) {
        lastModel = plan.model
        lastTier = plan.tier
        await bump($, plan.model ?? 'full')
      }
    }
    return yield* next(plan.model ? { ...e, model: plan.model } : e)
  })

  on('turn.complete', ($, e, next) => {
    if (!('agentId' in e && e.agentId)) planned.clear()
    return next(e)
  })

  // Subagents with no explicit model get routed too.
  on('agent.spawn', async ($, e, next) => {
    if (e.fork || e.model !== undefined) return next(e)
    const s = await settings($)
    if (s.mode === 'off') return next(e)
    if (/^(explore|claude-code-guide|statusline-setup)$/i.test(e.subagentType)) {
      const m = pick('simple', e.parentModel, s)
      if (m) await bump($, `agent:${m}`)
      return next(m ? { ...e, model: m } : e)
    }
    const c = await classify($, e.prompt, s)
    const m = pick(c.tier, e.parentModel, s)
    if (m) await bump($, `agent:${m}`)
    return next(m ? { ...e, model: m } : e)
  }).catch(($, e, next) => next(e))
}
