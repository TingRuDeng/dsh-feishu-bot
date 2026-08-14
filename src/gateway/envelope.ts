/** Exact argument shape passed to Feishu's create-message API for a card. */
export interface CardMessageEnvelope {
  params: { receive_id_type: 'chat_id' }
  data: { receive_id: string; msg_type: 'interactive'; content: string }
}

/** Build the complete create-message envelope used by the gateway. */
export function createCardMessageEnvelope(chatId: string, card: object): CardMessageEnvelope {
  return {
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
  }
}

/** Measure JSON as UTF-8 bytes, matching the HTTP request encoding. */
export function jsonUtf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
