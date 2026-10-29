export function authorizeComfyGuest(sender: unknown, frame: unknown, expectedSender: unknown, mainFrame: unknown, frameUrl: string, origin: string) {
  if (sender !== expectedSender || frame !== mainFrame || new URL(frameUrl).origin !== origin) throw new Error('Comfy 请求来源不受信任。');
}
export function authorizeComfyHandshake(received: unknown, expected: string | undefined, handshaken: boolean) {
  if (!expected || received !== expected || handshaken) throw new Error('Comfy 实例握手不正确。');
}
