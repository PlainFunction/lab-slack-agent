import { IMAGE_TYPES, MAX_IMAGE_BYTES, type FileRef } from '../tools/contract'
import { fromSlackText } from './mrkdwn'

// Which Slack messages start or continue a conversation. Pure, so every rule
// here has a test.

/** The parts of a Slack file object we use. */
export interface SlackFile { id: string; name?: string; title?: string; mimetype?: string; size?: number; mode?: string }

export interface SlackMessageEvent {
  type: string
  user?: string
  text?: string
  ts: string
  thread_ts?: string
  channel: string
  channel_type?: string
  bot_id?: string
  subtype?: string
  files?: SlackFile[]
}

export interface Inbound {
  /** One per DM, one per thread. */
  conversation: string
  channel: string
  /** Where replies go. Unset for a top-level DM, so the reply reads like chat. */
  thread?: string
  ts: string
  user: string
  text: string
  /** Images attached to this message, as references. Anything else is left out. */
  files?: FileRef[]
  /** Attachments it couldn't use, to tell the model and the person. */
  skipped?: string[]
}

export interface RouteOptions {
  /** Slack member ids allowed to use it. Anyone else is ignored. */
  allowed: string[]
  /** The bot's own user id, from the event's `authorizations`. */
  botUserId?: string
  /** Whether a conversation already exists, so a channel thread it was brought into continues. */
  known(conversation: string): Promise<boolean>
}

export const stripMention = (text: string, botUserId?: string) =>
  (botUserId ? text.replaceAll(`<@${botUserId}>`, '') : text.replace(/^\s*<@[UW][A-Z0-9]+>/, '')).trim()

/** Images it can hand to tools, and a word on anything else, so nothing vanishes silently. */
export function attachments(files: SlackFile[] = []): { files: FileRef[]; skipped: string[] } {
  const out: FileRef[] = []
  const skipped: string[] = []
  for (const f of files.slice(0, 10)) {
    const name = (f.name ?? f.title ?? 'file').slice(0, 200)
    // Slack sends 'tombstone' for deleted files and 'external' for links to Drive and the like.
    if (!/^F[A-Z0-9]{6,}$/.test(f.id) || (f.mode && f.mode !== 'hosted' && f.mode !== 'snippet')) skipped.push(`${name} (not a file I can read)`)
    else if (!(IMAGE_TYPES as readonly string[]).includes(f.mimetype ?? '')) skipped.push(`${name} (only PNG, JPEG, GIF and WebP images)`)
    else if ((f.size ?? 0) > MAX_IMAGE_BYTES) skipped.push(`${name} (over ${MAX_IMAGE_BYTES / 1024 / 1024} MB)`)
    else out.push({ id: f.id, name, mimetype: f.mimetype!, size: f.size ?? 0 })
  }
  return { files: out, skipped }
}

export async function routeEvent(e: SlackMessageEvent, o: RouteOptions): Promise<Inbound | undefined> {
  // Bots (including its own replies) and edits, deletes and joins. Without this it answers itself forever.
  // file_share is a message with attachments, which is the one subtype people send on purpose.
  if (e.bot_id || (e.subtype && e.subtype !== 'file_share') || !e.user || (o.botUserId && e.user === o.botUserId)) return undefined
  if (!o.allowed.includes(e.user)) return undefined
  const text = fromSlackText(stripMention(e.text ?? '', o.botUserId)).trim()
  const { files, skipped } = attachments(e.files)
  if (!text && !files.length && !skipped.length) return undefined
  const base = { channel: e.channel, ts: e.ts, user: e.user, text, ...(files.length ? { files } : {}), ...(skipped.length ? { skipped } : {}) }

  // An @mention fires both app_mention and message.channels. Only app_mention starts one.
  if (e.type === 'app_mention') {
    const thread = e.thread_ts ?? e.ts
    return { ...base, conversation: `${e.channel}:${thread}`, thread }
  }
  if (e.type !== 'message') return undefined

  if (e.channel_type === 'im') {
    return e.thread_ts
      ? { ...base, conversation: `${e.channel}:${e.thread_ts}`, thread: e.thread_ts }
      : { ...base, conversation: e.channel }
  }

  // A reply in a channel thread it's already in. A mention there arrives as app_mention too, so skip those.
  if (e.thread_ts && !(o.botUserId && (e.text ?? '').includes(`<@${o.botUserId}>`))) {
    const conversation = `${e.channel}:${e.thread_ts}`
    if (await o.known(conversation)) return { ...base, conversation, thread: e.thread_ts }
  }
  return undefined
}
