import { expect, mock, test } from 'claude-code/testing'

const spawn = (prompt: string, subagentType = 'general-purpose') => ({
  prompt, description: 'x', subagentType, provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5', background: false, fork: false,
})

test('an Explore subagent runs on haiku', async ($, on) => {
  mock.store(on)
  let model: string | undefined
  on('agent.spawn', (_, e) => ((model = e.model), { model: e.model ?? e.parentModel }))
  await $.agent.spawn(spawn('find where auth is configured', 'Explore') as never)
  expect(model).toBe('haiku')
})

test('a hard subagent task keeps the parent model', async ($, on) => {
  mock.store(on)
  let model: string | undefined = 'unset'
  on('agent.spawn', (_, e) => ((model = e.model), { model: e.model ?? e.parentModel }))
  await $.agent.spawn(spawn('Refactor the payment module and debug the race condition in the queue') as never)
  expect(model).toBe(undefined)
})

test('/route off turns routing off', async ($, on) => {
  mock.store(on)
  let model: string | undefined = 'unset'
  on('agent.spawn', (_, e) => ((model = e.model), { model: e.model ?? e.parentModel }))
  on('ui.status', () => ({ value: undefined }))
  await $.command.run({ command: 'route', args: 'off' } as never)
  await $.agent.spawn(spawn('list files', 'Explore') as never)
  expect(model).toBe(undefined)
})
