/**
 * Extension factories capture these globals during resourceLoader.reload(). Keep
 * the serialisation here, not in the desktop bridges: the headless engine needs
 * session scoping too, but must never load Electron to stamp a conversation id.
 */
function conversationBinder(key: string) {
  let tail: Promise<unknown> = Promise.resolve();
  return function bind<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const run = tail.then(async () => {
      const globals = globalThis as Record<string, unknown>;
      const previous = globals[key];
      const existed = Object.prototype.hasOwnProperty.call(globals, key);
      globals[key] = conversationId;
      try {
        return await fn();
      } finally {
        if (existed) globals[key] = previous;
        else delete globals[key];
      }
    });
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

export const bindBrowserConversation = conversationBinder("__fastvibeBrowserConversationId");
export const bindComputerConversation = conversationBinder("__fastvibeComputerConversationId");
