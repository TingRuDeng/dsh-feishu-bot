/**
 * M0#11 standalone smoke: Feishu long-connection receive + text send,
 * independent of dsh. Reads credential references from ~/.dsh/.credentials.yaml
 * (plain `KEY: value` lines), starts a WSClient, logs only a truncated chat
 * id plus text length, and sends a fixed acknowledgement. It never prints or
 * echoes the received body, sender id, or credential.
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

// The SDK's default error formatter can include request/response bodies.
// Connectivity smoke reports its own fixed metadata, so SDK logs stay silent.
const silentSdkLogger = {
  error() {}, warn() {}, info() {}, debug() {}, trace() {},
}
const sdkOptions = {
  appId, appSecret, loggerLevel: Lark.LoggerLevel.error, logger: silentSdkLogger,
}
const client = new Lark.Client(sdkOptions)
const wsClient = new Lark.WSClient(sdkOptions)

const dispatcher = new Lark.EventDispatcher({ logger: silentSdkLogger }).register({
  'im.message.receive_v1': async (data) => {
    const chatId = data.message.chat_id
    const chatType = data.message.chat_type
    // Connectivity smoke only: never log or echo message text, sender ids,
    // or anything a screenshotted terminal could leak. Length proves the
    // payload decoded; a fixed acknowledgement proves the send path.
    let textLength = 0
    try {
      textLength = (JSON.parse(data.message.content).text ?? '').length
    } catch { /* non-text message content: length stays 0 */ }
    console.log(`[smoke] message received: chat=${chatId.slice(0, 8)}… type=${chatType} textChars=${textLength}`)
    await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: `连通性正常：收到 ${textLength} 字（dsh-feishu-bot smoke）` }),
      },
    })
    console.log('[smoke] ack sent')
  },
})

wsClient.start({ eventDispatcher: dispatcher })
console.log('[smoke] listening — send the bot a private message in Feishu')
