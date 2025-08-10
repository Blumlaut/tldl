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
    ctx.reply(`${transcript}`, { reply_to_message_id: ctx.message.message_id }).catch(() =>
      ctx.reply(`${transcript}`)
    );
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


/** Minimal Wyoming client for STT (transcribe → audio-start/chunk/stop → transcript) */
async function QueryWyoming(oggPath) {
  const pcm = await oggToPcmBuffer(oggPath);
  const RATE = 16000, WIDTH = 2, CHANNELS = 1;

  const socket = await new Promise((resolve, reject) => {
    const s = net.createConnection({ host: WYO_HOST, port: WYO_PORT }, () => resolve(s));
    s.on('error', reject);
  });

  const writeEvent = (headerObj, payloadBuf) => {
    const hdr = { ...headerObj };
    if (payloadBuf?.length) hdr.payload_length = payloadBuf.length;
    socket.write(JSON.stringify(hdr) + '\n');
    if (payloadBuf?.length) socket.write(payloadBuf);
  };

  // 1) transcribe (optionally pass model/language)
  writeEvent({
    type: 'transcribe',
    data: {
      ...(WYO_MODEL ? { name: WYO_MODEL } : {}),
      ...(WYO_LANGUAGE ? { language: WYO_LANGUAGE } : {})
    }
  });

  // 2) audio-start
  writeEvent({
    type: 'audio-start',
    data: { rate: RATE, width: WIDTH, channels: CHANNELS }
  });

  // 3) audio-chunk(s)
  const CHUNK = 8192;
  for (let o = 0; o < pcm.length; o += CHUNK) {
    const chunk = pcm.subarray(o, Math.min(o + CHUNK, pcm.length));
    writeEvent({
      type: 'audio-chunk',
      data: { rate: RATE, width: WIDTH, channels: CHANNELS }
    }, chunk);
  }

  // 4) audio-stop
  writeEvent({ type: 'audio-stop' });

  // 5) wait for transcript
  let leftover = Buffer.alloc(0);
  const transcript = await new Promise((resolve, reject) => {
    socket.on('data', (buf) => {
      leftover = Buffer.concat([leftover, buf]);
      // read line by line (JSON header per line)
      while (true) {
        const idx = leftover.indexOf(0x0a); // '\n'
        if (idx < 0) break;
        const line = leftover.subarray(0, idx).toString('utf8').trim();
        leftover = leftover.subarray(idx + 1);
        if (!line) continue;
        let header;
        try { header = JSON.parse(line); } catch { continue; }

        const payloadLen = header?.payload_length || 0;
        if (payloadLen > 0) {
          if (leftover.length < payloadLen) { // wait for more
            // put line back and wait
            leftover = Buffer.concat([Buffer.from(line + '\n'), leftover]);
            return;
          }
          const payload = leftover.subarray(0, payloadLen);
          leftover = leftover.subarray(payloadLen);

          if (header.type === 'transcript') {
            // payload is UTF-8 text
            resolve(payload.toString('utf8'));
            socket.end();
          }
        } else {
          if (header.type === 'transcript' && header.data?.text) {
            resolve(header.data.text);
            socket.end();
          }
        }
      }
    });
    socket.on('error', reject);
    socket.on('end', () => reject(new Error('Wyoming closed before transcript')));
  });

  return transcript;
}

process.once('SIGINT', () => Telegram?.stop('SIGINT'));
process.once('SIGTERM', () => Telegram?.stop('SIGTERM'));
