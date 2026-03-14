import { FAILOVER_COMMAND_PREFIXES } from './constants.js';

type MessagePart =
  | {
      type: 'text';
      text?: string;
      synthetic?: unknown;
      ignored?: unknown;
      metadata?: unknown;
    }
  | {
      type: 'file';
      mime?: unknown;
      filename?: unknown;
      url?: unknown;
      source?: unknown;
    }
  | {
      type: 'agent';
      name?: unknown;
      source?: unknown;
    }
  | {
      type: 'subtask';
      prompt?: unknown;
      description?: unknown;
      agent?: unknown;
    }
  | Record<string, unknown>;

type SessionMessage = {
  info?: { role?: string };
  parts?: MessagePart[];
};

/** convertPartToInput does convert persisted message parts into replay-safe prompt input parts. */
export function convertPartToInput(part: unknown): Record<string, unknown> | null {
  if (!part || typeof part !== 'object') {
    return null;
  }

  const typedPart = part as MessagePart;
  if (typedPart.type === 'text') {
    return {
      type: 'text',
      text: typedPart.text ?? '',
      synthetic: typedPart.synthetic,
      ignored: typedPart.ignored,
      metadata: typedPart.metadata,
    };
  }

  if (typedPart.type === 'file') {
    return {
      type: 'file',
      mime: typedPart.mime,
      filename: typedPart.filename,
      url: typedPart.url,
      source: typedPart.source,
    };
  }

  if (typedPart.type === 'agent') {
    return {
      type: 'agent',
      name: typedPart.name,
      source: typedPart.source,
    };
  }

  if (typedPart.type === 'subtask') {
    return {
      type: 'subtask',
      prompt: typedPart.prompt,
      description: typedPart.description,
      agent: typedPart.agent,
    };
  }

  return null;
}

/** firstTextPart does extract the first textual message part content. */
export function firstTextPart(message: SessionMessage | null | undefined): string {
  if (!message || !Array.isArray(message.parts)) {
    return '';
  }
  const part = message.parts.find(
    (entry) => entry?.type === 'text' && typeof entry.text === 'string',
  );
  return part && typeof (part as { text?: unknown }).text === 'string'
    ? ((part as { text: string }).text ?? '')
    : '';
}

/** isFailoverCommandMessage does detect whether a user message is a failover command invocation. */
export function isFailoverCommandMessage(message: SessionMessage | null | undefined): boolean {
  const text = firstTextPart(message).trim().toLowerCase();
  return FAILOVER_COMMAND_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/** pickReplayUserMessage does choose the latest non-command user message for replay fallback. */
export function pickReplayUserMessage(messages: SessionMessage[] | null | undefined): SessionMessage | null {
  const ordered = [...(messages ?? [])].reverse();
  const nonCommandUser = ordered.find(
    (message) =>
      message.info?.role === 'user' && !isFailoverCommandMessage(message),
  );
  if (nonCommandUser) {
    return nonCommandUser;
  }
  return ordered.find((message) => message.info?.role === 'user') ?? null;
}
