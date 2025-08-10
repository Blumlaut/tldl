import { execa } from 'execa';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { Client, GatewayIntentBits, Partials } from 'discord.js';

const WYO_HOST = process.env.WYOMING_HOST || '127.0.0.1';
const WYO_PORT = parseInt(process.env.WYOMING_PORT || '10300', 10);
const WYO_MODEL = process.env.WYOMING_MODEL || 'auto';      // e.g. tiny-int8, small, large-v3, etc.
const WYO_LANGUAGE = process.env.WYOMING_LANGUAGE || undefined; // e.g. 'en'

let intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages
];
if (process.env.DISCORD_MESSAGE_CONTENT_INTENT == 'true') {
  intents.push(GatewayIntentBits.MessageContent);
}
const Discord = new Client({
  partials: [Partials.GuildMember, Partials.User, Partials.Message, Partials.Channel],
  intents
});
if (process.env.DISCORD_TOKEN) {
  Discord.login(process.env.DISCORD_TOKEN);
} else {
  console.error('DISCORD_TOKEN is not set, skipping Discord Setup.');
}

Discord.on('ready', () => {
  console.log(`Logged in as ${Discord.user.tag}!`);
});

Discord.on('messageCreate', async (message) => {
  let attentionMessage;
  if (message.attachments.size > 0 && message.attachments.first().waveform) {
    attentionMessage = message;
  } else if (message.messageSnapshots?.first()) {
    const snapshot = message.messageSnapshots.first();
    if (snapshot.attachments?.first()?.waveform) {
      attentionMessage = message.messageSnapshots.first();
    }
  } else {
    return;
  }
  if (!attentionMessage?.attachments) return;

  const attachment = attentionMessage.attachments.first();
  if (attachment?.waveform) {
    message.channel.sendTyping();
    const transcript = await DiscordVoiceHandler(attachment.url);
    message.reply({ content: `\`\`\`\n${transcript}\n\`\`\`` });
  }
});

async function DiscordVoiceHandler(link) {
  try {
    const fileResponse = await fetch(link);
    if (!fs.existsSync('/tmp/tldl')) fs.mkdirSync('/tmp/tldl');
    const file_id = `${Date.now()}-${Math.random().toString(36)}.ogg`;
    const buffer = Buffer.from(await fileResponse.arrayBuffer());
    const oggPath = `/tmp/tldl/${file_id}.ogg`;
    fs.writeFileSync(oggPath, buffer);
    const transcript = await QueryWyoming(oggPath);
    fs.unlinkSync(oggPath);
    return transcript;
  } catch (error) {
    console.error('Error processing voice message:', error);
    return null;
  }
}

let Telegram;
if (process.env.TELEGRAM_TOKEN) {
  Telegram = new Telegraf(process.env.TELEGRAM_TOKEN);
  Telegram.start((ctx) => ctx.reply('Welcome! Forward me a Voice Message to get an audio transcript.'));
  Telegram.on(message('voice'), async (ctx) => {
    ctx.sendChatAction('typing');
    const transcript = await TGVoiceHandler(ctx.message.voice.file_id);
    await ctx.reply(transcript || '(no text detected)', { reply_to_message_id: ctx.message.message_id });
  });
  Telegram.launch();
} else {
  console.error('TELEGRAM_TOKEN is not set');
}

async function TGVoiceHandler(file_id) {
  try {
    const link = await Telegram.telegram.getFileLink(file_id);
    const fileResponse = await fetch(link);
    if (!fs.existsSync('/tmp/tldl')) fs.mkdirSync('/tmp/tldl');
    const oggPath = `/tmp/tldl/${file_id}.ogg`;
    const buffer = Buffer.from(await fileResponse.arrayBuffer());
    fs.writeFileSync(oggPath, buffer);
    const transcript = await QueryWyoming(oggPath);
    fs.unlinkSync(oggPath);
    return transcript;
  } catch (error) {
    console.error('Error processing voice message:', error);
    return null;
  }
}

/** Transcode OGG → raw PCM s16le 16kHz mono (Buffer) using ffmpeg */
async function oggToPcmBuffer(inputPath) {
  const { stdout } = await execa(
    'ffmpeg',
    ['-y', '-i', inputPath, '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'],
    { encoding: 'buffer', stdout: 'pipe' } // <-- fix
  );
  return stdout; // Buffer
}


/** Minimal Wyoming client for STT */
async function QueryWyoming(oggPath) {
  const DEBUG = process.env.DEBUG_WYOMING == 1;
  const DUMP  = process.env.DEBUG_WYOMING_DUMP == 1;
  const dlog = (...args) => { if (DEBUG) console.log('[wyoming]', ...args); };

  const pcm = await oggToPcmBuffer(oggPath);
  const RATE = 16000, WIDTH = 2, CHANNELS = 1;

  dlog('connect', { host: WYO_HOST, port: WYO_PORT, pcmBytes: pcm.length });

  const socket = await new Promise((resolve, reject) => {
    const s = net.createConnection({ host: WYO_HOST, port: WYO_PORT }, () => resolve(s));
    s.on('error', reject);
  });

  const writeEvent = (hdr, payload) => {
    const header = { ...hdr };
    if (payload?.length) header.payload_length = payload.length;
    dlog('>>', header.type, header, payload ? `(${payload.length} bytes)` : '');
    socket.write(JSON.stringify(header) + '\n');
    if (payload?.length) socket.write(payload);
  };

  // Start request (model/lang if provided)
  writeEvent({ type: 'transcribe', data: { name: WYO_MODEL, language: WYO_LANGUAGE } });
  writeEvent({ type: 'audio-start', data: { rate: RATE, width: WIDTH, channels: CHANNELS } });

  const CHUNK = 8192;
  for (let o = 0; o < pcm.length; o += CHUNK) {
    const slice = pcm.subarray(o, Math.min(o + CHUNK, pcm.length));
    writeEvent({ type: 'audio-chunk', data: { rate: RATE, width: WIDTH, channels: CHANNELS } }, slice);
  }
  writeEvent({ type: 'audio-stop' });

  let buf = Buffer.alloc(0);
  let lastText = '';
  let resolved = false;
  let streamingMode = false;
  const dumpPath = `/tmp/wyoming-dump-${Date.now()}.bin`;
  const dumpStream = DUMP ? fs.createWriteStream(dumpPath) : null;
  if (dumpStream) dlog('dumping raw bytes to', dumpPath);

  const finish = (text, reason) => {
    if (!resolved) {
      resolved = true;
      try { socket.end(); } catch {}
      clearTimeout(timer);
      dumpStream?.end();
      dlog('finish', { reason, textLen: (text || lastText).trim().length, streamingMode });
      return (text || lastText || '').trim();
    }
  };

  const timer = setTimeout(() => {
    dlog('timeout 60s \u2014 best effort return');
    try { socket.destroy(); } catch {}
  }, 60_000);

  const getTextFrom = (header, payload) => {
    if (header?.data?.text) return { text: header.data.text, final: !!header.data.final };
    const asStr = payload?.toString?.('utf8') ?? '';
    if (!asStr) return { text: '', final: false };
    try {
      const j = JSON.parse(asStr);
      if (typeof j?.text === 'string') return { text: j.text, final: !!j.final };
    } catch {}
    return { text: asStr, final: false };
  };

  return await new Promise((resolve, reject) => {
    socket.on('data', (chunk) => {
      dumpStream?.write(chunk);
      dlog('<< chunk', chunk.length, 'bytes');
      buf = Buffer.concat([buf, chunk]);

      while (true) {
        const nl = buf.indexOf(0x0a); // '\n'
        if (nl < 0) break;

        const rawLine = buf.subarray(0, nl);
        const line = rawLine.toString('utf8').trim();
        buf = buf.subarray(nl + 1);
        if (!line) continue;

        let header;
        try {
          header = JSON.parse(line);
        } catch {
          dlog('!! bad header JSON', { linePreview: line.slice(0, 200) });
          continue;
        }

        // Accept multiple header keys for payload sizing (some servers use data_length)
        const need =
          header?.payload_length ??
          header?.data_length ??
          header?.length ??
          header?.payloadLen ??
          0;

        dlog('<< header', header.type, { need, has: buf.length, header });

        if (need > 0) {
          if (buf.length < need) {
            dlog('... waiting payload', { need, have: buf.length });
            // put header back and wait for more bytes
            buf = Buffer.concat([Buffer.from(line + '\n', 'utf8'), buf]);
            break;
          }
          const payload = buf.subarray(0, need);
          buf = buf.subarray(need);

          if (header.type === 'transcript-start') {
            streamingMode = true;
            dlog('state: streamingMode=true');
          } else if (header.type === 'transcript-chunk') {
            const { text } = getTextFrom(header, payload);
            if (text) {
              lastText += (lastText ? ' ' : '') + text;
              dlog('chunk+', { addLen: text.length, totalLen: lastText.length, preview: text.slice(0, 120) });
            }
          } else if (header.type === 'transcript-stop') {
            dlog('stop (payload)', { totalLen: lastText.length });
            return resolve(finish(lastText, 'transcript-stop'));
          } else if (header.type === 'transcript') {
            const { text } = getTextFrom(header, payload);
            if (streamingMode) {
              if (text) lastText = text;
              dlog('final transcript (streaming)', { totalLen: lastText.length });
              return resolve(finish(lastText, 'final transcript (streaming)'));
            } else {
              if (text) lastText = text;
              dlog('final transcript (non-streaming)', { totalLen: lastText.length });
              return resolve(finish(lastText, 'final transcript (non-streaming)'));
            }
          } else if (header.type === 'error') {
            dlog('server error', header.data);
            return reject(new Error(header.data?.message || 'Wyoming error'));
          }
        } else {
          // No payload bytes declared
          if (header.type === 'transcript-start') {
            streamingMode = true;
            dlog('state: streamingMode=true (no payload)');
          } else if (header.type === 'transcript-chunk') {
            const { text } = getTextFrom(header, null);
            if (text) {
              lastText += (lastText ? ' ' : '') + text;
              dlog('chunk+ (no payload)', { addLen: text.length, totalLen: lastText.length, preview: text.slice(0, 120) });
            }
          } else if (header.type === 'transcript-stop') {
            dlog('stop (no payload)', { totalLen: lastText.length });
            return resolve(finish(lastText, 'transcript-stop'));
          } else if (header.type === 'transcript') {
            const { text } = getTextFrom(header, null);
            if (streamingMode) {
              if (text) lastText = text;
              dlog('final transcript (streaming, no payload)', { totalLen: lastText.length });
              return resolve(finish(lastText, 'final transcript (streaming, no payload)'));
            } else {
              if (text) lastText = text;
              dlog('final transcript (non-streaming, no payload)', { totalLen: lastText.length });
              return resolve(finish(lastText, 'final transcript (non-streaming, no payload)'));
            }
          } else if (header.type === 'error') {
            dlog('server error (no payload)', header.data);
            return reject(new Error(header.data?.message || 'Wyoming error'));
          }
        }
      }
    });

    socket.on('end',   () => resolve(finish('', 'socket end')));
    socket.on('close', () => resolve(finish('', 'socket close')));
    socket.on('error', (e) => {
      dlog('socket error', e?.message || e);
      dumpStream?.end();
      return reject(e);
    });
  });
}




process.once('SIGINT', () => Telegram?.stop('SIGINT'));
process.once('SIGTERM', () => Telegram?.stop('SIGTERM'));
