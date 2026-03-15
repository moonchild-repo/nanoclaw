import https from 'https';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import fs from 'fs';
import path from 'path';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

/**
 * Transcribe voice message using Home Assistant's faster_whisper
 */
async function transcribeVoiceMessage(
  bot: Bot,
  ctx: any,
  chatJid: string,
  messageId: string,
): Promise<string | null> {
  try {
    // Load HA configuration
    const configPath = '/home/node/.claude/memory/config.json';
    if (!fs.existsSync(configPath)) {
      logger.debug('HA config not found, skipping voice transcription');
      return null;
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const haUrl = config.homeassistant?.url;
    const haToken = config.homeassistant?.token;

    if (!haUrl || !haToken) {
      logger.debug('HA credentials not configured');
      return null;
    }

    // Download audio file from Telegram
    const fileId = ctx.message.voice?.file_id;
    if (!fileId) return null;

    let audioBuffer: Buffer | null = null;
    try {
      const file = await bot.api.getFile(fileId);
      if (!file.file_path) return null;

      const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;

      audioBuffer = await new Promise((resolve) => {
        const chunks: Buffer[] = [];
        const req = https.get(fileUrl, { timeout: 30000 }, (res: any) => {
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => {
          req.destroy();
          resolve(null);
        });
      });

      if (!audioBuffer || audioBuffer.length === 0) {
        logger.debug({ fileId }, 'Failed to download voice file');
        return null;
      }
    } catch (err) {
      logger.debug({ err }, 'Error downloading voice file');
      return null;
    }

    // Transcribe using HA
    try {
      const boundary = '----B' + Date.now();
      let body =
        '--' +
        boundary +
        '\r\nContent-Disposition: form-data; name="file"; filename="voice.ogg"\r\nContent-Type: audio/ogg\r\n\r\n';

      const formData = Buffer.concat([
        Buffer.from(body),
        audioBuffer,
        Buffer.from('\r\n--' + boundary + '--\r\n'),
      ]);

      const transcription = await new Promise<string | null>((resolve) => {
        let timeout: NodeJS.Timeout;
        timeout = setTimeout(() => {
          logger.debug('Voice transcription timeout');
          resolve(null);
        }, 30000);

        const url = new URL(
          '/api/services/stt/faster_whisper',
          haUrl,
        ).toString();

        // Choose http or https based on haUrl
        const HttpModule = haUrl.startsWith('https') ? require('https') : require('http');
        
        const req = HttpModule.request(
          url,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + haToken,
              'Content-Type': `multipart/form-data; boundary=${boundary}`,
              'Content-Length': formData.length,
            },
          },
          (res: any) => {
            let data = '';
            res.on('data', (chunk: string) => (data += chunk));
            res.on('end', () => {
              clearTimeout(timeout);
              try {
                const json = JSON.parse(data);
                const text = json.result?.[0]?.text || json.text || null;
                if (text) {
                  logger.info(
                    { length: text.length },
                    'Voice message transcribed',
                  );
                }
                resolve(text);
              } catch (e) {
                logger.debug({ err: e }, 'HA response parse error');
                resolve(null);
              }
            });
          },
        );

        req.on('error', (err) => {
          clearTimeout(timeout);
          logger.debug({ err }, 'HA transcription request failed');
          resolve(null);
        });

        req.write(formData);
        req.end();
      });

      return transcription;
    } catch (err) {
      logger.debug({ err }, 'HA transcription failed');
      return null;
    }
  } catch (err) {
    logger.debug({ err }, 'Voice transcription error');
    return null;
  }
}

/**
 * Analyze image using Claude vision API
 */
async function analyzeImage(imageUrl: string): Promise<string | null> {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      logger.debug('ANTHROPIC_API_KEY not set, skipping image analysis');
      return null;
    }

    // Use Claude API to analyze the image
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'url',
                  url: imageUrl,
                },
              },
              {
                type: 'text',
                text: 'Beschreibe dieses Bild kurz und prägnant in 1-2 Sätzen auf Deutsch.',
              },
            ],
          },
        ],
      }),
    });

    const data = await response.json();
    const description = data.content?.[0]?.text;
    if (description) {
      logger.info({ length: description.length }, 'Image analyzed');
      return description;
    }
    return null;
  } catch (err) {
    logger.debug({ err }, 'Image analysis failed');
    return null;
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const messageId = ctx.message.message_id.toString();

      // Store placeholder
      storeNonText(ctx, '[Bild wird analysiert...]');

      // Analyze image async
      if (this.bot) {
        try {
          const fileId =
            ctx.message.photo?.[ctx.message.photo.length - 1]?.file_id;
          const file = await this.bot.api.getFile(fileId);
          const imageUrl = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;

          analyzeImage(imageUrl).then((description) => {
            if (description) {
              import('./db.js').then((dbModule) => {
                (dbModule as any).updateMessageContent(
                  messageId,
                  chatJid,
                  description,
                );
              });
            }
          });
        } catch (err) {
          logger.debug({ err }, 'Image download failed');
        }
      }
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const messageId = ctx.message.message_id.toString();

      // Store with placeholder initially
      storeNonText(ctx, '[Sprachnachricht wird transkribiert...]');

      // Start async transcription (fire-and-forget)
      if (this.bot) {
        transcribeVoiceMessage(this.bot, ctx, chatJid, messageId)
          .then((transcription) => {
            if (transcription) {
              // Import db module and update message
              import('./db.js').then((dbModule) => {
                (dbModule as any).updateMessageContent(
                  messageId,
                  chatJid,
                  transcription,
                );
              });
            }
          })
          .catch((err) => {
            logger.error({ err }, 'Unexpected voice transcription error');
          });
      }
    });
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle message reactions with semantic interpretation
    this.bot.on('message_reaction', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const reactions = ctx.messageReaction.new_reaction || [];
      const reactionEmoji = reactions.map((r) => r.emoji || '').join('');
      const messageId = ctx.messageReaction.message_id.toString();

      if (reactionEmoji) {
        const timestamp = new Date().toISOString();
        const senderName =
          ctx.from?.first_name || ctx.from?.username || 'Unknown';
        const sender = ctx.from?.id?.toString() || '';

        // Semantic mapping of reactions
        const reactionMeaning: Record<string, string> = {
          '👍': 'Zustimmung/Ja/Gut',
          '👎': 'Ablehnung/Nein',
          '❤️': 'Gefällt mir/Liebe',
          '😂': 'Witzig/Lustig',
          '😢': 'Traurig/Mitleid',
          '🔥': 'Großartig/Heiß',
          '🎉': 'Freude/Glückwunsch',
        };

        const meaning = reactionMeaning[reactionEmoji] || 'Reaktion';

        logger.debug(
          { chatJid, messageId, emoji: reactionEmoji, meaning },
          'Message reaction: ' + meaning,
        );

        // Store reaction as pseudo-message so agent can see it
        this.opts.onMessage(chatJid, {
          id: `reaction_${messageId}_${Date.now()}`,
          chat_jid: chatJid,
          sender,
          sender_name: senderName,
          content: `[Hat mit ${reactionEmoji} (${meaning}) reagiert]`,
          timestamp,
          is_from_me: false,
        });
      }
    });

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  /**
   * Send emoji reaction to a message
   * Usage: await channel.sendReaction('tg:-123456789', 123, '👍')
   */
  async sendReaction(
    jid: string,
    messageId: number | string,
    emoji: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const msgId =
        typeof messageId === 'string' ? parseInt(messageId) : messageId;

      await this.bot.api.setMessageReaction(numericId, msgId, [
        { type: 'emoji', emoji },
      ]);
      logger.debug({ jid, messageId: msgId, emoji }, 'Reaction sent');
    } catch (err) {
      logger.debug({ jid, messageId, emoji, err }, 'Failed to send reaction');
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
