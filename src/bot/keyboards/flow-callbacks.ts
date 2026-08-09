// The post flow and the /queue edit flow walk the same steps and show the same keyboards;
// only the callback data differs — the post flow keys off the replied-to message, the edit
// flow off a session id. Both variants live side by side here so a step's two encodings
// can't drift apart, and the keyboards take a resolver instead of hardcoding either one.

export type FlowKind = 'post' | 'edit';

/** Payload each step's callback data carries. */
type StepArg = {
  channel: string;
  action: 'quick' | 'transform' | 'forward';
  text: 'keep' | 'quote' | 'remove';
  preset: string;
  addText: undefined;
  nickname: string;
};

const CALLBACKS: {
  [S in keyof StepArg]: Record<FlowKind, (arg: StepArg[S], sessionId: string) => string>;
} = {
  channel: {
    post: (channelId) => `select_channel:${channelId}`,
    edit: (channelId, sid) => `queue:edit:ch:${sid}:${channelId}`,
  },
  action: {
    post: (action) => `action:${action}`,
    edit: (action, sid) => `queue:edit:action:${sid}:${action}`,
  },
  text: {
    post: (handling) => `text:${handling}`,
    edit: (handling, sid) => `queue:edit:text:${sid}:${handling}`,
  },
  // Callback data is capped at 64 bytes, so the edit preset prefix is shortened to `ec:` —
  // a preset id (24 chars) rides along with the session id (24) in the same string.
  preset: {
    post: (presetId) => `custom_text:preset:${presetId}`,
    edit: (presetId, sid) => `ec:preset:${sid}:${presetId}`,
  },
  addText: {
    post: () => 'custom_text:add',
    edit: (_arg, sid) => `queue:edit:custom:${sid}:add`,
  },
  nickname: {
    post: (key) => `select_nickname:${key}`,
    edit: (key, sid) => `queue:edit:nickname:${sid}:${key}`,
  },
};

export type FlowCallbacks = <S extends keyof StepArg>(step: S, arg?: StepArg[S]) => string;

export const flowCallbacks =
  (kind: FlowKind, sessionId = ''): FlowCallbacks =>
  <S extends keyof StepArg>(step: S, arg?: StepArg[S]) => {
    // Indexing the table with a generic key widens the entry to a union of function types
    // TS refuses to call; by construction the argument is that step's own.
    const encode = CALLBACKS[step][kind] as (arg: StepArg[S] | undefined, sid: string) => string;
    return encode(arg, sessionId);
  };

export const POST_FLOW = flowCallbacks('post');
