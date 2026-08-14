/**
 * M0#11 standalone smoke: Feishu long-connection receive + text send,
 * independent of dsh. Reads credential references from ~/.dsh/.credentials.yaml
 * (plain `KEY: value` lines), starts a WSClient, logs every private message
 * event (chat_id / open_id / text), and echoes a reply.
 *
 * Run: node scripts/feishu-smoke.mjs   (Ctrl-C to stop)
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as Lark from '@larksuiteoapi/node-sdk'

function credential(name) {
  const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/)
    if (match && match[1] === name) return match[2].replace(/^['"]|['"]$/g, '')
  }
  throw new Error(`credential ${name} not found in ~/.dsh/.credentials.yaml`)
}

const appId = credential('FEISHU_APP_ID')
const appSecret = credential('FEISHU_APP_SECRET')
console.log(`[smoke] appId=${appId.slice(0, 8)}… starting long connection`)

const client = new Lark.Client({ appId, appSecret })
const wsClient = new Lark.WSClient({ appId, appSecret, loggerLevel: Lark.LoggerLevel.info })

const dispatcher = new Lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    const chatId = data.message.chat_id
    const openId = data.sender.sender_id?.open_id
    const chatType = data.message.chat_type
    let text = '(non-text)'
    try {
      text = JSON.parse(data.message.content).text ?? '(no text field)'
    } catch { /* non-text message content stays as the placeholder */ }
    console.log(`[smoke] message: chat=${chatId} type=${chatType} open_id=${openId} text=${JSON.stringify(text)}`)
    await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: `echo: ${text} (dsh-feishu-bot M0 smoke)` }),
      },
    })
    console.log('[smoke] echo sent')
  },
})

wsClient.start({ eventDispatcher: dispatcher })
console.log('[smoke] listening — send the bot a private message in Feishu')
