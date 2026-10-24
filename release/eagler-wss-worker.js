import { connect } from "cloudflare:sockets";

const MINECRAFT_HOST = "57.129.18.222";
const MINECRAFT_PORT = 10290;
const MINECRAFT_PROTOCOL = 776;
const STARTUP_TIMEOUT_MS = 55_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export default {
  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("This endpoint is an Eaglercraft WebSocket proxy.", { status: 426 });
    }

    // The host only recognizes a normal Java Minecraft request for auto-start.
    if (!(await waitForMinecraftServer())) {
      return new Response("Minecraft server is starting; reconnect in a moment", { status: 503 });
    }

    let socket;
    try {
      socket = connect({ hostname: MINECRAFT_HOST, port: MINECRAFT_PORT });
      await socket.opened;
    } catch {
      return new Response("Minecraft TCP server could not be reached", { status: 502 });
    }

    const reader = socket.readable.getReader();
    const writer = socket.writable.getWriter();
    let writeTail = Promise.resolve();
    let closed = false;

    const enqueue = (bytes) => {
      writeTail = writeTail.then(() => writer.write(bytes));
      return writeTail;
    };

    try {
      const keyBytes = crypto.getRandomValues(new Uint8Array(16));
      const key = btoa(String.fromCharCode(...keyBytes));
      await enqueue(encoder.encode(
        `GET / HTTP/1.1\r\n` +
        `Host: ${MINECRAFT_HOST}:${MINECRAFT_PORT}\r\n` +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        `Sec-WebSocket-Key: ${key}\r\n` +
        "Sec-WebSocket-Version: 13\r\n\r\n",
      ));
    } catch {
      await closeSocket(socket, reader, writer);
      return new Response("Minecraft WebSocket handshake could not be sent", { status: 502 });
    }

    let handshake;
    try {
      handshake = await readHttpHeaders(reader);
    } catch {
      await closeSocket(socket, reader, writer);
      return new Response("Minecraft server did not answer the WebSocket handshake", { status: 502 });
    }

    if (!/^HTTP\/1\.1 101\b/.test(decoder.decode(handshake.headers))) {
      await closeSocket(socket, reader, writer);
      return new Response("Minecraft server rejected the WebSocket handshake", { status: 502 });
    }

    const [client, browser] = Object.values(new WebSocketPair());
    browser.accept({ allowHalfOpen: true });
    const parser = new WebSocketFrameParser();

    const shutDown = async (code = 1000, reason = "") => {
      if (closed) return;
      closed = true;
      try {
        if (browser.readyState < WebSocket.CLOSING) browser.close(code, reason);
      } catch {}
      await closeSocket(socket, reader, writer);
    };

    browser.addEventListener("message", (event) => {
      void (async () => {
        try {
          const bytes = await toBytes(event.data);
          const opcode = typeof event.data === "string" ? 0x1 : 0x2;
          await enqueue(makeClientFrame(opcode, bytes));
        } catch {
          await shutDown(1011, "Proxy write failed");
        }
      })();
    });

    browser.addEventListener("close", (event) => {
      void (async () => {
        try {
          await enqueue(makeCloseFrame(event.code, event.reason));
        } catch {}
        await shutDown();
      })();
    });

    void (async () => {
      try {
        await processFrames(handshake.remaining);
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          await processFrames(value);
        }
      } catch {
        if (!closed) await shutDown(1011, "Minecraft server connection failed");
      } finally {
        if (!closed) await shutDown();
      }
    })();

    async function processFrames(bytes) {
      for (const frame of parser.push(bytes)) {
        if (frame.opcode === 0x1) {
          browser.send(decoder.decode(frame.payload));
        } else if (frame.opcode === 0x2) {
          browser.send(frame.payload.buffer.slice(
            frame.payload.byteOffset,
            frame.payload.byteOffset + frame.payload.byteLength,
          ));
        } else if (frame.opcode === 0x9) {
          await enqueue(makeClientFrame(0xA, frame.payload));
        } else if (frame.opcode === 0x8) {
          const { code, reason } = closeDetails(frame.payload);
          await shutDown(code, reason);
        }
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  },
};

async function readHttpHeaders(reader) {
  let buffer = new Uint8Array();
  while (buffer.length <= 16 * 1024) {
    const marker = findHeaderEnd(buffer);
    if (marker >= 0) {
      return { headers: buffer.slice(0, marker + 4), remaining: buffer.slice(marker + 4) };
    }
    const { value, done } = await reader.read();
    if (done) throw new Error("socket closed");
    buffer = concat(buffer, value);
  }
  throw new Error("headers too large");
}

function findHeaderEnd(bytes) {
  for (let i = 0; i + 3 < bytes.length; ++i) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
  }
  return -1;
}

async function toBytes(value) {
  if (typeof value === "string") return encoder.encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  throw new Error("unsupported WebSocket payload");
}

function makeClientFrame(opcode, payload) {
  const length = payload.length;
  const headerLength = length < 126 ? 2 : length <= 0xffff ? 4 : 10;
  const output = new Uint8Array(headerLength + 4 + length);
  output[0] = 0x80 | opcode;
  if (length < 126) {
    output[1] = 0x80 | length;
  } else if (length <= 0xffff) {
    output[1] = 0x80 | 126;
    output[2] = length >>> 8;
    output[3] = length;
  } else {
    output[1] = 0x80 | 127;
    new DataView(output.buffer).setBigUint64(2, BigInt(length));
  }
  const maskOffset = headerLength;
  const mask = crypto.getRandomValues(new Uint8Array(4));
  output.set(mask, maskOffset);
  for (let i = 0; i < length; ++i) output[maskOffset + 4 + i] = payload[i] ^ mask[i & 3];
  return output;
}

function makeCloseFrame(code, reason) {
  const reasonBytes = encoder.encode(reason || "");
  const payload = new Uint8Array(2 + reasonBytes.length);
  new DataView(payload.buffer).setUint16(0, code || 1000);
  payload.set(reasonBytes, 2);
  return makeClientFrame(0x8, payload);
}

function closeDetails(payload) {
  if (payload.length < 2) return { code: 1000, reason: "" };
  return { code: new DataView(payload.buffer, payload.byteOffset, 2).getUint16(0), reason: decoder.decode(payload.slice(2)) };
}

class WebSocketFrameParser {
  constructor() {
    this.buffer = new Uint8Array();
    this.fragmentOpcode = null;
    this.fragments = [];
  }

  push(incoming) {
    this.buffer = concat(this.buffer, incoming);
    const messages = [];
    let offset = 0;
    while (offset + 2 <= this.buffer.length) {
      const first = this.buffer[offset];
      const second = this.buffer[offset + 1];
      const fin = (first & 0x80) !== 0;
      let opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let extra = 0;
      if (length === 126) extra = 2;
      else if (length === 127) extra = 8;
      const maskLength = masked ? 4 : 0;
      if (offset + 2 + extra + maskLength > this.buffer.length) break;
      if (length === 126) length = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset + 2, 2).getUint16(0);
      if (length === 127) {
        const longLength = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset + 2, 8).getBigUint64(0);
        if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("frame too large");
        length = Number(longLength);
      }
      const start = offset + 2 + extra + maskLength;
      if (start + length > this.buffer.length) break;
      let payload = this.buffer.slice(start, start + length);
      if (masked) {
        const mask = this.buffer.slice(offset + 2 + extra, start);
        for (let i = 0; i < payload.length; ++i) payload[i] ^= mask[i & 3];
      }
      offset = start + length;
      if (opcode === 0x0) {
        if (this.fragmentOpcode === null) throw new Error("unexpected continuation");
        this.fragments.push(payload);
        opcode = this.fragmentOpcode;
      } else if (!fin && opcode < 0x8) {
        if (this.fragmentOpcode !== null) throw new Error("nested fragment");
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
      }
      if (!fin && opcode < 0x8) continue;
      if (this.fragmentOpcode !== null && opcode === this.fragmentOpcode) {
        payload = concat(...this.fragments);
        this.fragmentOpcode = null;
        this.fragments = [];
      }
      messages.push({ opcode, payload });
    }
    this.buffer = this.buffer.slice(offset);
    return messages;
  }
}

function concat(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

async function closeSocket(socket, reader, writer) {
  try { await writer.close(); } catch {}
  try { reader?.releaseLock(); } catch {}
  try { writer?.releaseLock(); } catch {}
  try { socket.close(); } catch {}
}

async function waitForMinecraftServer() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  do {
    if (await pingMinecraftStatus()) return true;
    await sleep(1_500);
  } while (Date.now() < deadline);
  return false;
}

async function pingMinecraftStatus() {
  let socket;
  let reader;
  let writer;
  try {
    socket = connect({ hostname: MINECRAFT_HOST, port: MINECRAFT_PORT });
    await socket.opened;
    reader = socket.readable.getReader();
    writer = socket.writable.getWriter();
    await writer.write(javaStatusHandshake());
    await writer.write(new Uint8Array([0x01, 0x00]));
    return await Promise.race([
      reader.read().then(({ value, done }) => !done && Boolean(value?.length)),
      sleep(2_000).then(() => false),
    ]);
  } catch {
    return false;
  } finally {
    if (socket) await closeSocket(socket, reader, writer);
  }
}

function javaStatusHandshake() {
  const hostname = encoder.encode("schujegi.mcsh.gg");
  const payload = concat(
    new Uint8Array([0x00]),
    encodeVarInt(MINECRAFT_PROTOCOL),
    encodeVarInt(hostname.length),
    hostname,
    new Uint8Array([MINECRAFT_PORT >>> 8, MINECRAFT_PORT & 0xff, 0x01]),
  );
  return concat(encodeVarInt(payload.length), payload);
}

function encodeVarInt(value) {
  const bytes = [];
  do {
    let part = value & 0x7f;
    value >>>= 7;
    if (value !== 0) part |= 0x80;
    bytes.push(part);
  } while (value !== 0);
  return new Uint8Array(bytes);
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
