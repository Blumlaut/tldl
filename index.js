import {execa} from 'execa';
import fs from 'fs';
import path from 'path';
import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { Client, GatewayIntentBits, Partials } from 'discord.js';

// set up Discord.js with message content intent
const Discord = new Client({ partials: [Partials.GuildMember, Partials.User, Partials.Message, Partials.Channel], intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages, GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
if (process.env.DISCORD_TOKEN)  {
	Discord.login(process.env.DISCORD_TOKEN);
} else {
	console.error("DISCORD_TOKEN is not set, skipping Discord Setup.");
}

Discord.on('ready', () => {
	console.log(`Logged in as ${Discord.user.tag}!`);
});

Discord.on('messageCreate', async (message) => {
	// if message has a voice message
	let attentionMessage
	if (message.attachments.size > 0 && message.attachments.first().waveform) {
		attentionMessage = message
	} else if (message.messageSnapshots.first()) {
		let snapshot = message.messageSnapshots.first()
		if (snapshot.attachments && snapshot.attachments.first()) {
			if (snapshot.attachments.first().waveform) {
				attentionMessage = message.messageSnapshots.first()
			}
		}
	} else {
		return; 
	}
	if (!attentionMessage || !attentionMessage.attachments) {
		return; 
	}
	const attachment = attentionMessage.attachments.first();
	if (attachment && attachment.waveform) {
		message.channel.sendTyping();
		const transcript = await DiscordVoiceHandler(attachment.url);
		message.reply({ content: `\`\`\`\n${transcript}\`\`\`\n` });
	}
});


async function DiscordVoiceHandler(link) {
	try {
		const fileResponse = await fetch(link)
		if (!fs.existsSync('/tmp/tldl')) {
			fs.mkdirSync('/tmp/tldl')
		}
		// generate a unique file name
		const file_id = `${Date.now()}-${Math.random().toString(36)}.ogg`

		const buffer = Buffer.from(await fileResponse.arrayBuffer())
		fs.writeFileSync(`/tmp/tldl/${file_id}.ogg`, buffer)
		const transcript = await QueryWhisper(`/tmp/tldl/${file_id}.ogg`)
		fs.unlinkSync(`/tmp/tldl/${file_id}.ogg`)
		fs.unlinkSync(`/tmp/tldl/${file_id}.text`)
		return transcript;
	} catch (error) {
		console.error('Error processing voice message:', error);
		return null;
	}
}

var Telegram

if (process.env.TELEGRAM_TOKEN) {
	Telegram = new Telegraf(process.env.TELEGRAM_TOKEN)
	Telegram.start((ctx) => ctx.reply('Welcome! Forward me a Voice Message to get an audio transcript.'))
	Telegram.on(message('voice'), async (ctx) => {
		console.log("Got Voice message!")
		ctx.sendChatAction('typing');
		const transcript = await TGVoiceHandler(ctx.message.voice.file_id);
		ctx.reply(`${transcript}`, {
			reply_to_message_id: ctx.message.message_id
		}).catch((err) => {
			ctx.reply(`${transcript}`)
		})
	});
	

	Telegram.launch()
} else {
	console.error('TELEGRAM_TOKEN is not set')
}



async function TGVoiceHandler(file_id) {
	try {
		const link = await Telegram.telegram.getFileLink(file_id);
		const fileResponse = await fetch(link)
		if (!fs.existsSync('/tmp/tldl')) {
			fs.mkdirSync('/tmp/tldl')
		}
		const buffer = Buffer.from(await fileResponse.arrayBuffer())
		fs.writeFileSync(`/tmp/tldl/${file_id}.ogg`, buffer)
		const transcript = await QueryWhisper(`/tmp/tldl/${file_id}.ogg`)
		fs.unlinkSync(`/tmp/tldl/${file_id}.ogg`)
		fs.unlinkSync(`/tmp/tldl/${file_id}.text`)
		return transcript;
	} catch (error) {
		console.error('Error processing voice message:', error);
		return null;
	}
}


async function QueryWhisper(fileName) {
	// execute ./whisper-faster-xxl in "Whisper-Faster-XXL" folder
	const result = await execa`./Whisper-Faster-XXL/whisper-faster-xxl ${fileName} --output_format text --output_dir /tmp/tldl/ --without_timestamps true --word_timestamps false --model ${process.env.WHISPER_MODEL || 'medium'}`

	let strippedFileName = path.basename(fileName, path.extname(fileName));
	const filePath = path.join('/tmp/tldl/', `${strippedFileName}.text`);
	const fileContent = fs.readFileSync(filePath, 'utf-8');
	return fileContent
}

process.once('SIGINT', () => Telegram.stop('SIGINT'))
process.once('SIGTERM', () => Telegram.stop('SIGTERM'))