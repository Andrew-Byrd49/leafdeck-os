// Live updates: one Durable Object that every open companion app keeps a WebSocket to.
// The Worker POSTs /notify after each write; the hub tells every socket "changed" and they fetch /api/changes.
// Uses the hibernation API, so idle sockets cost nothing.

export class Live {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/notify' && request.method === 'POST') {
      const msg = JSON.stringify({ type: 'changed', at: Date.now() });
      for (const ws of this.state.getWebSockets()) {
        try {
          ws.send(msg);
        } catch {}
      }
      return new Response('ok');
    }
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response('Not found', { status: 404 });
  }

  webSocketMessage(ws, message) {
    if (typeof message !== 'string') return;
    try {
      if (JSON.parse(message).type === 'ping') ws.send(JSON.stringify({ type: 'pong', at: Date.now() }));
    } catch {}
  }

  webSocketClose(ws) {
    try {
      ws.close();
    } catch {}
  }

  webSocketError(ws) {
    try {
      ws.close();
    } catch {}
  }
}
