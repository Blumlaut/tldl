# tl;dl
 too long; didn't listen, generate voice message captions with whisper in telegram and discord 

## Installation

Clone the repository and download the latest version of [Whisper-Faster-XXL](https://github.com/Purfview/whisper-standalone-win/releases/tag/Faster-Whisper-XXL), extract it into the bot directory so the whisper-faster-xxl executable is in `${BOT_DIR}/Whisper-Faster-XXL`.

Run `npm i` in bot directory, copy `.env.example` to `.env` and fill out the required environment variables.

Start the bot with `npm start`

## Behaviour

The Bot will create an audio transcript for every voice message it sees, this can be in a DM, Group or Server.

Voice messages are temporarily downloaded into `/tmp/tldl/`, this is also where transcripts are stored until they are read by the bot, the files are subsequently deleted.

![image](https://github.com/user-attachments/assets/0f34c103-d643-45f3-aaa1-51cb1a785ba0)
![image](https://github.com/user-attachments/assets/951b923f-254f-479a-b3cb-a431ac3040ab)



## License

see [LICENSE](LICENSE)

## Give it a try!

Test the Bot by [inviting it on Discord](https://discord.com/oauth2/authorize?client_id=1327351558777864333) or [messaging it on Telegram](https://t.me/voicetranscriptbot)
