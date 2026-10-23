import { expect, test } from 'claude-code/testing'

// How decorated's reply hook composes with another plugin's on the same
// component. A managed (`prepend`) plugin sits above every installed one, so
// it stands in for whichever reply mod the engine seats above decorated.

const reply = (text: string) =>
  ({
    plugin: 'decorated',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text, isFirstOfReply: true },
    viewport: { columns: 100, rows: 40, isFullscreen: true },
  }) as const

const MARKED = 'Build is <ok>green</ok>.'

const texts = async (ui: { findAll: (q: { type: 'Text' }) => Promise<readonly { text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text)

test('a mod above that draws the reply itself wins, and decorated never runs', {
  plugins: [
    {
      name: 'replacer',
      tier: 'prepend',
      register(on) {
        on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
          const { Text } = $.ui.resolve(e)

          return <Text>replaced</Text>
        })
      },
    },
  ],
}, async $ => {
  const ui = await $.ui.mount(reply(MARKED))
  expect(await texts(ui)).toEqual(['replaced'])
  await ui.unmount()
})

test('a mod above that rewrites the text hands decorated the rewrite, markup included', {
  plugins: [
    {
      name: 'rewriter',
      tier: 'prepend',
      register(on) {
        on('ui.render', { component: 'AssistantMessage' }, ($, e, next) =>
          next({ ...e, props: { ...e.props, text: `${e.props.text} <warn>rewritten</warn>` } }),
        )
      },
    },
  ],
}, async $ => {
  const ui = await $.ui.mount(reply(MARKED))
  const row = await ui.find({ type: 'Text', text: /rewritten/ })
  expect(row?.text).toBe('Build is green. rewritten')
  await ui.unmount()
})

test('a mod above that wraps the reply wraps decorated’s drawing', {
  plugins: [
    {
      name: 'wrapper',
      tier: 'prepend',
      register(on) {
        on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
          const { Box, Text } = $.ui.resolve(e)
          const inner = await next(e)

          return (
            <Box flexDirection="column">
              <Text>wrapped</Text>
              {inner}
            </Box>
          )
        })
      },
    },
  ],
}, async $ => {
  const ui = await $.ui.mount(reply(MARKED))
  const drawn = await texts(ui)
  expect(drawn[0]).toBe('wrapped')
  expect(drawn).toContain('Build is green.')
  await ui.unmount()
})

test('a mod beneath still draws a reply with no markup', {
  plugins: [
    {
      name: 'beneath',
      tier: 'append',
      register(on) {
        on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
          const { Text } = $.ui.resolve(e)

          return <Text>beneath</Text>
        })
      },
    },
  ],
}, async $ => {
  const ui = await $.ui.mount(reply('Plain **markdown** and a <div>.'))
  expect(await texts(ui)).toEqual(['beneath'])
  await ui.unmount()
})

// The test's own hooks sit beneath every plugin, decorated included.
test('a mod beneath sees a reply with markup, and decorated draws it', async ($, on) => {
  const seen: string[] = []
  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    seen.push(e.props.text)

    return next(e)
  })
  const ui = await $.ui.mount(reply(MARKED))
  expect(seen).toContain(MARKED)
  expect(await texts(ui)).toContain('Build is green.')
  await ui.unmount()
})

test('a mod beneath that fails leaves decorated’s drawing whole', {
  plugins: [
    {
      name: 'failing',
      tier: 'append',
      register(on) {
        on('ui.render', { component: 'AssistantMessage' }, () => {
          throw new Error('beneath failed')
        })
      },
    },
  ],
}, async $ => {
  const ui = await $.ui.mount(reply(MARKED))
  expect(await texts(ui)).toContain('Build is green.')
  await ui.unmount()
})
